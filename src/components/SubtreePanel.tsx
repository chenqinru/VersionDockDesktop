import React, { useEffect, useMemo, useState } from 'react';
import { Codicon } from './Codicon';
import { ContextMenu, type ContextMenuEntry } from './ContextMenu';
import { useI18n } from '../i18n';
import { branchColor, readableAccentColor } from './branchColor';
import { useAppStore } from '../store/appStore';
import type { RepositoryStatus, SubtreeEntry as BoundSubtreeEntry } from '../bindings/generated';

export interface NormalizedSubtreeEntry {
  id: string;
  repoId: string;
  name: string;
  prefix: string;
  repository: string;
  ref: string;
  defaultSquash: boolean;
  lastSplitBranch?: string;
  state?: 'active' | 'pending';
}

export interface SubtreePushStatus {
  loading?: boolean;
  aheadCount?: number;
  hasUpdates?: boolean;
  remoteRef?: string;
  splitHash?: string;
  remoteHash?: string;
  error?: string;
}

export type SubtreeOp = 'add' | 'pull' | 'push' | 'split' | 'merge' | 'remove' | 'register' | 'edit' | 'delete';

export interface SubtreePanelProps {
  repos?: RepositoryStatus[];
  entries?: NormalizedSubtreeEntry[] | BoundSubtreeEntry[];
  repoMetas?: Array<{ id: string; name: string; color: string }>;
  loading?: boolean;
  activeOps?: Record<string, SubtreeOp | undefined>;
  statuses?: Record<string, SubtreePushStatus | undefined>;
  error?: string | null;
  multiRepo?: boolean;
  onAdd?: (repoId?: string) => void;
  onRegister?: (repoId?: string) => void;
  onPull?: (entryId: string) => void;
  onPush?: (entryId: string) => void;
  onSplit?: (entryId: string) => void;
  onMerge?: (entryId: string) => void;
  onRemove?: (entryId: string) => void;
  onEdit?: (entryId: string) => void;
  onDeleteRegistry?: (entryId: string) => void;
  onReveal?: (entryId: string) => void;
}

function normalizeSubtree(raw: BoundSubtreeEntry | NormalizedSubtreeEntry): NormalizedSubtreeEntry {
  const id = raw.id;
  const prefix = raw.prefix;
  const name = ('name' in raw && raw.name)
    ? raw.name
    : (prefix.split(/[\\/]/).filter(Boolean).pop() || prefix);
  const repository = ('repository' in raw && raw.repository)
    ? raw.repository
    : ('remote' in raw ? (raw as BoundSubtreeEntry).remote : '');
  const ref = ('ref' in raw && raw.ref)
    ? raw.ref
    : ('branch' in raw ? (raw as BoundSubtreeEntry).branch : 'main');
  const defaultSquash = ('defaultSquash' in raw && typeof (raw as NormalizedSubtreeEntry).defaultSquash === 'boolean')
    ? (raw as NormalizedSubtreeEntry).defaultSquash
    : ('squash' in raw ? Boolean((raw as BoundSubtreeEntry).squash) : true);
  const lastSplitBranch = ('lastSplitBranch' in raw && (raw as NormalizedSubtreeEntry).lastSplitBranch)
    ? (raw as NormalizedSubtreeEntry).lastSplitBranch
    : undefined;
  const repoId = ('repoId' in raw && (raw as NormalizedSubtreeEntry).repoId)
    ? (raw as NormalizedSubtreeEntry).repoId
    : '';
  const state = ('state' in raw && raw.state) ? raw.state : 'active';

  return {
    id,
    repoId,
    name,
    prefix,
    repository,
    ref,
    defaultSquash,
    lastSplitBranch,
    state,
  };
}

function getRowContextMenuItems(t: (key: string, ...args: Array<string | number>) => string): ContextMenuEntry[] {
  return [
    { id: 'pull', label: t('Pull Subtree'), icon: 'cloud-download' },
    { id: 'push', label: t('Push Subtree'), icon: 'cloud-upload' },
    { id: 'split', label: t('Split Subtree'), icon: 'git-branch' },
    { id: 'merge', label: t('Merge Subtree'), icon: 'git-merge' },
    { separator: true },
    { id: 'reveal', label: t('Reveal Prefix'), icon: 'folder-opened' },
    { id: 'edit', label: t('Edit Registry'), icon: 'edit' },
    { id: 'delete-registry', label: t('Delete Registry'), icon: 'trash' },
    { separator: true },
    { id: 'remove', label: t('Remove Subtree Files'), icon: 'trash', danger: true },
  ];
}

function subtreeOpLabel(op: SubtreeOp | undefined, t: (key: string, ...args: Array<string | number>) => string): string | null {
  if (op === 'pull') return t('Pulling...');
  if (op === 'push') return t('Pushing...');
  if (op === 'split') return t('Splitting...');
  if (op === 'merge') return t('Merging...');
  if (op === 'remove') return t('Removing...');
  if (op === 'delete') return t('Deleting...');
  return null;
}

function subtreeStatusLabel(status: SubtreePushStatus | undefined, t: (key: string, ...args: Array<string | number>) => string): string {
  if (!status) return t('Up to date');
  if (status.loading) return t('Checking...');
  if (status.error && status.hasUpdates) return t('Updates');
  if (status.error) return t('Status unavailable');
  if (status.aheadCount && status.aheadCount > 0) return t('{0} to push', status.aheadCount);
  if (status.hasUpdates) return t('Updates');
  return t('Up to date');
}

function subtreeStatusTone(status: SubtreePushStatus | undefined): 'loading' | 'updated' | 'clean' | 'error' {
  if (!status) return 'clean';
  if (status.loading) return 'loading';
  if (status.error && !status.hasUpdates) return 'error';
  if (status.hasUpdates || (status.aheadCount ?? 0) > 0) return 'updated';
  return 'clean';
}

function repoStatusSummary(entries: NormalizedSubtreeEntry[], statuses: Record<string, SubtreePushStatus | undefined>, t: (key: string, ...args: Array<string | number>) => string): string | null {
  let loading = false;
  let hasUnknownUpdates = false;
  let totalAhead = 0;
  for (const entry of entries) {
    const status = statuses[entry.id];
    if (!status) continue;
    if (status.loading) {
      loading = true;
      continue;
    }
    if (status.aheadCount && status.aheadCount > 0) {
      totalAhead += status.aheadCount;
      continue;
    }
    if (status.hasUpdates) hasUnknownUpdates = true;
  }
  if (totalAhead > 0) return t('{0} to push', totalAhead);
  if (hasUnknownUpdates) return t('Updates');
  if (loading) return t('Checking...');
  return null;
}

function SubtreeRow({
  entry,
  repoColor,
  activeOp,
  status,
  onPull,
  onPush,
  onSplit,
  onMerge,
  onRemove,
  onEdit,
  onDeleteRegistry,
  onReveal,
}: {
  entry: NormalizedSubtreeEntry;
  repoColor: string;
  activeOp?: SubtreeOp;
  status?: SubtreePushStatus;
  onPull?: (entryId: string) => void;
  onPush?: (entryId: string) => void;
  onSplit?: (entryId: string) => void;
  onMerge?: (entryId: string) => void;
  onRemove?: (entryId: string) => void;
  onEdit?: (entryId: string) => void;
  onDeleteRegistry?: (entryId: string) => void;
  onReveal?: (entryId: string) => void;
}) {
  const { t } = useI18n();
  const [hovered, setHovered] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const activeLabel = subtreeOpLabel(activeOp, t);
  const disabled = Boolean(activeOp);
  const statusLabel = subtreeStatusLabel(status, t);
  const statusTone = subtreeStatusTone(status);
  const projectColor = readableAccentColor(repoColor || '#20b2aa');

  const runAction = (id: string) => {
    if (disabled) return;
    if (id === 'pull') onPull?.(entry.id);
    if (id === 'push') onPush?.(entry.id);
    if (id === 'split') onSplit?.(entry.id);
    if (id === 'merge') onMerge?.(entry.id);
    if (id === 'remove') onRemove?.(entry.id);
    if (id === 'edit') onEdit?.(entry.id);
    if (id === 'delete-registry') onDeleteRegistry?.(entry.id);
    if (id === 'reveal') onReveal?.(entry.id);
  };

  const contextItems = useMemo(() => getRowContextMenuItems(t), [t]);

  return (
    <div style={row.root}>
      <div
        style={{
          ...row.header,
          background: hovered ? 'var(--vscode-list-hoverBackground, var(--versiondock-hover))' : 'transparent',
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onContextMenu={(e) => {
          e.preventDefault();
          setCtxMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        <Codicon name="repo" style={{ fontSize: '13px', color: projectColor, flexShrink: 0, marginTop: '2px' }} />
        <div style={row.info}>
          <div style={row.titleLine}>
            <span style={row.name}>{entry.name}</span>
            <span style={row.badge}>{entry.defaultSquash ? t('squash') : t('full history')}</span>
            {entry.lastSplitBranch && (
              <span style={row.branchBadge(branchColor(entry.lastSplitBranch))} title={entry.lastSplitBranch}>
                <Codicon name="git-branch" style={{ fontSize: '10px', flexShrink: 0 }} />
                <span style={row.branchBadgeLabel}>{entry.lastSplitBranch}</span>
              </span>
            )}
            <span style={row.statusBadge(statusTone)} title={status?.error ?? statusLabel}>{statusLabel}</span>
          </div>
          <div style={row.pathLine} title={entry.prefix}>
            <Codicon name="folder" style={row.metaIcon} />
            <span style={row.prefix}>{entry.prefix}</span>
          </div>
          <div style={row.remoteLine}>
            <Codicon name="link" style={row.metaIcon} />
            <span style={row.repository} title={entry.repository}>{entry.repository}</span>
            {entry.ref && <span style={row.ref} title={entry.ref}>{entry.ref}</span>}
          </div>
        </div>
        <div style={row.actions}>
          {activeLabel ? (
            <span style={row.busyBadge} title={activeLabel}>
              <Codicon name="sync" style={{ fontSize: '11px' }} />
              <span>{activeLabel}</span>
            </span>
          ) : (
            <>
              <button
                data-action-btn=""
                style={row.btn}
                title={t('Pull Subtree')}
                disabled={disabled}
                onClick={(e) => {
                  e.stopPropagation();
                  onPull?.(entry.id);
                }}
              >
                <Codicon name="cloud-download" />
              </button>
              <button
                data-action-btn=""
                style={row.btn}
                title={t('More')}
                disabled={disabled}
                onClick={(e) => {
                  e.stopPropagation();
                  setCtxMenu({ x: e.clientX, y: e.clientY });
                }}
              >
                <Codicon name="ellipsis" />
              </button>
            </>
          )}
        </div>
      </div>
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={contextItems}
          onSelect={runAction}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </div>
  );
}

function RepoSection({
  meta,
  entries,
  activeOps = {},
  statuses = {},
  multiRepo,
  onAdd,
  onRegister,
  onPull,
  onPush,
  onSplit,
  onMerge,
  onRemove,
  onEdit,
  onDeleteRegistry,
  onReveal,
}: {
  meta: { id: string; name: string; color: string };
  entries: NormalizedSubtreeEntry[];
  activeOps?: Record<string, SubtreeOp | undefined>;
  statuses?: Record<string, SubtreePushStatus | undefined>;
  multiRepo: boolean;
  onAdd?: (repoId?: string) => void;
  onRegister?: (repoId?: string) => void;
  onPull?: (entryId: string) => void;
  onPush?: (entryId: string) => void;
  onSplit?: (entryId: string) => void;
  onMerge?: (entryId: string) => void;
  onRemove?: (entryId: string) => void;
  onEdit?: (entryId: string) => void;
  onDeleteRegistry?: (entryId: string) => void;
  onReveal?: (entryId: string) => void;
}) {
  const { t } = useI18n();
  const summary = repoStatusSummary(entries, statuses, t);
  const projectColor = readableAccentColor(meta.color || '#20b2aa');

  return (
    <div style={css.repoSection}>
      {multiRepo && (
        <div style={css.repoHeader(projectColor)}>
          <span style={css.dot(projectColor)} />
          <span style={css.repoName}>{meta.name}</span>
          {summary && <span style={css.repoStatus}>{summary}</span>}
          <div style={css.headerActions}>
            <button
              data-action-btn=""
              style={css.headerBtn}
              title={t('Add Subtree from Repository')}
              onClick={() => onAdd?.(meta.id)}
            >
              <Codicon name="add" style={{ fontSize: '12px' }} />
            </button>
            <button
              data-action-btn=""
              style={css.headerBtn}
              title={t('Register Existing Directory')}
              onClick={() => onRegister?.(meta.id)}
            >
              <Codicon name="list-tree" style={{ fontSize: '12px' }} />
            </button>
          </div>
        </div>
      )}
      {entries.length === 0 ? (
        <div style={css.empty}>{t('No subtrees registered')}</div>
      ) : (
        entries.map((entry) => (
          <SubtreeRow
            key={entry.id}
            entry={entry}
            repoColor={meta.color}
            activeOp={activeOps[entry.id]}
            status={statuses[entry.id]}
            onPull={onPull}
            onPush={onPush}
            onSplit={onSplit}
            onMerge={onMerge}
            onRemove={onRemove}
            onEdit={onEdit}
            onDeleteRegistry={onDeleteRegistry}
            onReveal={onReveal}
          />
        ))
      )}
      {!multiRepo && (
        <div style={css.singleRepoActions}>
          <button data-secondary-action-btn="" style={css.actionBtn} onClick={() => onAdd?.(meta.id)}>
            <Codicon name="add" style={{ marginRight: '4px', fontSize: '12px' }} />
            {t('Add Subtree')}
          </button>
          <button data-secondary-action-btn="" style={css.actionBtn} onClick={() => onRegister?.(meta.id)}>
            <Codicon name="list-tree" style={{ marginRight: '4px', fontSize: '12px' }} />
            {t('Register Existing')}
          </button>
        </div>
      )}
    </div>
  );
}

export function SubtreePanel({
  repos = [],
  entries: explicitEntries,
  repoMetas: explicitRepoMetas,
  loading: externalLoading,
  activeOps = {},
  statuses = {},
  error: externalError,
  multiRepo: forcedMultiRepo,
  onAdd,
  onRegister,
  onPull,
  onPush,
  onSplit,
  onMerge,
  onRemove,
  onEdit,
  onDeleteRegistry,
  onReveal,
}: SubtreePanelProps) {
  const { t } = useI18n();
  const storeSubtrees = useAppStore((state) => state.subtrees);
  const loadSubtrees = useAppStore((state) => state.loadSubtrees);

  useEffect(() => {
    if (!explicitEntries && repos.length > 0) {
      for (const repo of repos) {
        void loadSubtrees(repo.meta.id);
      }
    }
  }, [explicitEntries, loadSubtrees, repos]);

  const resolvedRepoMetas = useMemo(() => {
    if (explicitRepoMetas) return explicitRepoMetas;
    return repos.map((r) => ({ id: r.meta.id, name: r.meta.name, color: r.meta.color }));
  }, [explicitRepoMetas, repos]);

  const resolvedEntries = useMemo(() => {
    if (explicitEntries) {
      return explicitEntries.map((e) => normalizeSubtree(e));
    }
    const list: NormalizedSubtreeEntry[] = [];
    for (const repo of repos) {
      const repoEntries = storeSubtrees[repo.meta.id] ?? [];
      for (const entry of repoEntries) {
        list.push(normalizeSubtree({ ...entry, repoId: repo.meta.id }));
      }
    }
    return list;
  }, [explicitEntries, repos, storeSubtrees]);

  const grouped = useMemo(() => {
    const byRepo = new Map<string, NormalizedSubtreeEntry[]>();
    for (const entry of resolvedEntries) {
      const key = entry.repoId || (resolvedRepoMetas[0]?.id ?? '');
      if (!byRepo.has(key)) byRepo.set(key, []);
      byRepo.get(key)!.push(entry);
    }
    return resolvedRepoMetas.map((meta) => ({
      meta,
      entries: (byRepo.get(meta.id) ?? []).sort((left, right) => left.prefix.localeCompare(right.prefix)),
    }));
  }, [resolvedEntries, resolvedRepoMetas]);

  if (externalLoading && resolvedEntries.length === 0) return <div style={css.empty}>{t('Loading...')}</div>;
  if (externalError) {
    return (
      <div style={css.errorRow}>
        <Codicon name="warning" style={{ marginRight: '4px', flexShrink: 0 }} />
        {externalError}
      </div>
    );
  }

  if (grouped.length === 0) {
    return <div style={css.empty}>{t('No Git repositories found in this workspace.')}</div>;
  }

  const multiRepo = forcedMultiRepo ?? (grouped.length >= 1);

  return (
    <div style={css.root}>
      {grouped.map((group) => (
        <RepoSection
          key={group.meta.id}
          meta={group.meta}
          entries={group.entries}
          activeOps={activeOps}
          statuses={statuses}
          multiRepo={multiRepo}
          onAdd={onAdd}
          onRegister={onRegister}
          onPull={onPull}
          onPush={onPush}
          onSplit={onSplit}
          onMerge={onMerge}
          onRemove={onRemove}
          onEdit={onEdit}
          onDeleteRegistry={onDeleteRegistry}
          onReveal={onReveal}
        />
      ))}
    </div>
  );
}

const css = {
  root: {
    display: 'flex',
    flexDirection: 'column' as const,
    flex: 1,
    overflowY: 'auto' as const,
    background: 'var(--vscode-editor-background, var(--versiondock-bg))',
  },
  repoSection: {
    borderBottom: '1px solid var(--vscode-panel-border, var(--versiondock-border-soft))',
  } as React.CSSProperties,
  repoHeader: (color: string): React.CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '4px 8px',
    minHeight: '26px',
    background: `${color}22`,
    borderBottom: '1px solid var(--vscode-panel-border, var(--versiondock-border-soft))',
    boxSizing: 'border-box',
  }),
  dot: (color: string): React.CSSProperties => ({
    width: 8,
    height: 8,
    borderRadius: '50%',
    background: color,
    flexShrink: 0,
  }),
  repoName: {
    fontSize: '11px',
    fontWeight: 'bold' as const,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.04em',
    flex: 1,
    color: 'var(--vscode-foreground, var(--versiondock-text))',
  },
  repoStatus: {
    flexShrink: 0,
    maxWidth: '92px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    padding: '1px 5px',
    borderRadius: '3px',
    fontSize: '10px',
    color: 'var(--vscode-gitDecoration-modifiedResourceForeground, var(--vscode-charts-yellow, #e2c08d))',
    background: 'color-mix(in srgb, var(--vscode-gitDecoration-modifiedResourceForeground, var(--vscode-charts-yellow, #e2c08d)) 16%, transparent)',
  } as React.CSSProperties,
  headerActions: {
    marginLeft: 'auto',
    display: 'flex',
    gap: '2px',
  },
  headerBtn: {
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    padding: '2px 4px',
    borderRadius: '3px',
    display: 'flex',
    alignItems: 'center',
    color: 'var(--vscode-descriptionForeground, var(--versiondock-muted))',
  } as React.CSSProperties,
  singleRepoActions: {
    display: 'flex',
    gap: '4px',
    padding: '6px 8px',
    borderTop: '1px solid var(--vscode-panel-border, var(--versiondock-border-soft))',
  } as React.CSSProperties,
  actionBtn: {
    display: 'flex',
    alignItems: 'center',
    fontSize: '11px',
    background: 'var(--vscode-button-secondaryBackground, var(--versiondock-surface-alt))',
    color: 'var(--vscode-button-secondaryForeground, var(--versiondock-text))',
    border: 'none',
    borderRadius: '3px',
    padding: '3px 8px',
    cursor: 'pointer',
  } as React.CSSProperties,
  empty: {
    padding: '16px 12px',
    fontSize: '12px',
    color: 'var(--vscode-descriptionForeground, var(--versiondock-muted))',
    textAlign: 'center' as const,
  },
  errorRow: {
    display: 'flex',
    alignItems: 'flex-start',
    padding: '4px 8px',
    fontSize: '11px',
    color: 'var(--vscode-errorForeground, var(--versiondock-danger))',
    background: 'var(--vscode-inputValidation-errorBackground, rgba(244, 135, 113, 0.15))',
  } as React.CSSProperties,
};

const row = {
  root: {
    borderBottom: '1px solid color-mix(in srgb, var(--vscode-panel-border, var(--versiondock-border-soft)) 50%, transparent)',
  } as React.CSSProperties,
  header: {
    display: 'grid',
    gridTemplateColumns: '16px minmax(0, 1fr) auto',
    alignItems: 'start',
    gap: '6px',
    padding: '6px 8px 7px',
    cursor: 'default',
    minHeight: '58px',
    boxSizing: 'border-box',
    userSelect: 'none' as const,
  } as React.CSSProperties,
  info: {
    display: 'flex',
    flexDirection: 'column' as const,
    minWidth: 0,
    gap: '3px',
  },
  titleLine: {
    display: 'flex',
    alignItems: 'center',
    gap: '5px',
    minWidth: 0,
  } as React.CSSProperties,
  name: {
    fontSize: '12px',
    fontWeight: 600,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    minWidth: 0,
    color: 'var(--vscode-foreground, var(--versiondock-text))',
  },
  badge: {
    fontSize: '9px',
    padding: '1px 5px',
    borderRadius: '3px',
    background: 'var(--versiondock-badge-background, #0e639c)',
    color: 'var(--versiondock-badge-foreground, #ffffff)',
    flexShrink: 0,
  } as React.CSSProperties,
  branchBadge: (color: string): React.CSSProperties => ({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '3px',
    fontSize: '10px',
    fontWeight: 600,
    padding: '1px 5px',
    borderRadius: '3px',
    background: `${color}33`,
    color,
    border: `1px solid ${color}88`,
    flexShrink: 1,
    minWidth: 0,
    maxWidth: '160px',
    overflow: 'hidden',
  }),
  branchBadgeLabel: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    minWidth: 0,
  } as React.CSSProperties,
  statusBadge: (tone: 'loading' | 'updated' | 'clean' | 'error'): React.CSSProperties => {
    const color = tone === 'updated'
      ? 'var(--vscode-gitDecoration-modifiedResourceForeground, var(--vscode-charts-yellow, #e2c08d))'
      : tone === 'clean'
        ? 'var(--vscode-gitDecoration-addedResourceForeground, var(--vscode-charts-green, var(--versiondock-success)))'
        : tone === 'error'
          ? 'var(--vscode-errorForeground, var(--versiondock-danger))'
          : 'var(--vscode-descriptionForeground, var(--versiondock-muted))';
    return {
      flexShrink: 0,
      maxWidth: '86px',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      padding: '1px 5px',
      borderRadius: '3px',
      fontSize: '10px',
      lineHeight: '14px',
      color,
      border: `1px solid color-mix(in srgb, ${color} 38%, transparent)`,
      background: `color-mix(in srgb, ${color} 12%, transparent)`,
    };
  },
  pathLine: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    minWidth: 0,
    fontSize: '11px',
    color: 'var(--vscode-descriptionForeground, var(--versiondock-muted))',
  } as React.CSSProperties,
  remoteLine: {
    display: 'flex',
    alignItems: 'center',
    gap: '5px',
    minWidth: 0,
    fontSize: '11px',
    color: 'var(--vscode-descriptionForeground, var(--versiondock-muted))',
  } as React.CSSProperties,
  metaIcon: {
    fontSize: '11px',
    flexShrink: 0,
  } as React.CSSProperties,
  prefix: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    minWidth: 0,
  },
  repository: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    minWidth: 0,
    flex: 1,
  },
  ref: {
    flexShrink: 0,
    maxWidth: '96px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    padding: '0 4px',
    border: '1px solid color-mix(in srgb, var(--vscode-panel-border, var(--versiondock-border)) 70%, transparent)',
    borderRadius: '3px',
    color: 'var(--vscode-descriptionForeground, var(--versiondock-muted))',
  } as React.CSSProperties,
  actions: {
    display: 'flex',
    alignItems: 'center',
    gap: '1px',
    flexShrink: 0,
    transition: 'opacity 0.12s ease',
    marginTop: '-1px',
  },
  btn: {
    background: 'transparent',
    border: 'none',
    width: '20px',
    height: '20px',
    padding: '0',
    cursor: 'pointer',
    color: 'var(--vscode-descriptionForeground, var(--versiondock-muted))',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: '3px',
  } as React.CSSProperties,
  busyBadge: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    minWidth: 0,
    maxWidth: '92px',
    padding: '2px 5px',
    borderRadius: '3px',
    fontSize: '10px',
    lineHeight: '14px',
    color: 'var(--vscode-progressBar-background, var(--versiondock-accent))',
    background: 'color-mix(in srgb, var(--vscode-progressBar-background, var(--versiondock-accent)) 16%, transparent)',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  } as React.CSSProperties,
};
