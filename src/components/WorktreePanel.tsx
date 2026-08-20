import React, { useEffect, useState } from 'react';
import { Codicon } from './Codicon';
import { ContextMenu, type ContextMenuEntry } from './ContextMenu';
import { useI18n } from '../i18n';
import { branchColor, headColor, readableAccentColor } from './branchColor';
import { useAppStore } from '../store/appStore';
import type { RepositoryStatus, WorktreeEntry as BoundWorktreeEntry } from '../bindings/generated';

export interface NormalizedWorktreeEntry {
  path: string;
  head: string;
  branch: string;
  isMain: boolean;
  isDetached: boolean;
  isBare: boolean;
  isLocked: boolean;
  lockReason?: string;
  isPrunable: boolean;
  branchShort: string;
  isInWorkspace: boolean;
}

export interface RepoWorktrees {
  repoId: string;
  repoName: string;
  repoColor: string;
  worktrees: NormalizedWorktreeEntry[];
  isLinkedWorktree: boolean;
}

export interface WorktreePanelProps {
  repos?: RepositoryStatus[];
  customRepos?: RepoWorktrees[];
  loading?: boolean;
  error?: string | null;
  multiRepo?: boolean;
  onDelete?: (repoId: string, worktreePath: string, force: boolean) => void;
  onLock?: (repoId: string, worktreePath: string) => void;
  onUnlock?: (repoId: string, worktreePath: string) => void;
  onPrune?: (repoId: string) => void;
  onOpenInExplorer?: (repoId: string, worktreePath: string) => void;
  onOpenInNewWindow?: (worktreePath: string) => void;
  onOpenInOS?: (worktreePath: string) => void;
  onAddToWorkspace?: (worktreePath: string) => void;
  onRequestCreate?: (repoId: string) => void;
}

function normalizeEntry(entry: BoundWorktreeEntry | NormalizedWorktreeEntry): NormalizedWorktreeEntry {
  const isMain = 'isMain' in entry ? Boolean((entry as NormalizedWorktreeEntry).isMain) : Boolean((entry as BoundWorktreeEntry).main);
  const isDetached = 'isDetached' in entry ? Boolean((entry as NormalizedWorktreeEntry).isDetached) : Boolean((entry as BoundWorktreeEntry).detached);
  const isBare = 'isBare' in entry ? Boolean((entry as NormalizedWorktreeEntry).isBare) : Boolean((entry as BoundWorktreeEntry).bare);
  const isLocked = 'isLocked' in entry ? Boolean((entry as NormalizedWorktreeEntry).isLocked) : Boolean((entry as BoundWorktreeEntry).locked);
  const isPrunable = 'isPrunable' in entry ? Boolean((entry as NormalizedWorktreeEntry).isPrunable) : Boolean((entry as BoundWorktreeEntry).prunable);
  const branchShort = ('branchShort' in entry && (entry as NormalizedWorktreeEntry).branchShort)
    ? (entry as NormalizedWorktreeEntry).branchShort
    : (entry.branch || '').replace(/^refs\/heads\//, '');
  const isInWorkspace = 'isInWorkspace' in entry ? Boolean((entry as NormalizedWorktreeEntry).isInWorkspace) : true;

  return {
    path: entry.path,
    head: entry.head,
    branch: entry.branch,
    isMain,
    isDetached,
    isBare,
    isLocked,
    lockReason: entry.lockReason ?? undefined,
    isPrunable,
    branchShort,
    isInWorkspace,
  };
}

function ctxItems(entry: NormalizedWorktreeEntry, t: (key: string, ...args: Array<string | number>) => string): ContextMenuEntry[] {
  const items: ContextMenuEntry[] = [
    ...(entry.isInWorkspace ? [{ id: 'explorer', label: t('Reveal in Explorer'), icon: 'folder-opened' } as ContextMenuEntry] : []),
    { id: 'newwindow', label: t('Open in New Window'), icon: 'link-external' },
    { id: 'os', label: t('Open in File Manager'), icon: 'folder' },
    ...(!entry.isInWorkspace ? [{ id: 'add-to-workspace', label: t('Add Folder to Workspace'), icon: 'add' } as ContextMenuEntry] : []),
  ];
  if (!entry.isMain) {
    items.push(
      { separator: true },
      entry.isLocked
        ? { id: 'unlock', label: t('Unlock'), icon: 'unlock' }
        : { id: 'lock', label: t('Lock'), icon: 'lock' },
      { separator: true },
      { id: 'delete', label: t('Remove Worktree'), icon: 'trash', danger: true },
      { id: 'force-delete', label: t('Force Remove'), icon: 'trash', danger: true },
    );
  }
  return items;
}

// ── Single worktree row ───────────────────────────────────────────────────────

function WorktreeRow({
  entry,
  repoId,
  onDelete,
  onLock,
  onUnlock,
  onOpenInExplorer,
  onOpenInNewWindow,
  onOpenInOS,
  onAddToWorkspace,
}: {
  entry: NormalizedWorktreeEntry;
  repoId: string;
  onDelete?: WorktreePanelProps['onDelete'];
  onLock?: WorktreePanelProps['onLock'];
  onUnlock?: WorktreePanelProps['onUnlock'];
  onOpenInExplorer?: WorktreePanelProps['onOpenInExplorer'];
  onOpenInNewWindow?: WorktreePanelProps['onOpenInNewWindow'];
  onOpenInOS?: WorktreePanelProps['onOpenInOS'];
  onAddToWorkspace?: WorktreePanelProps['onAddToWorkspace'];
}) {
  const { t } = useI18n();
  const [hovered, setHovered] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);

  const dirName = entry.path.split(/[\\/]/).pop() ?? entry.path;

  const branchLabel = entry.isDetached
    ? (entry.head ? entry.head.slice(0, 8) : t('detached HEAD'))
    : (entry.branchShort || entry.branch || 'main');
  const branchClr = entry.isDetached ? headColor() : branchColor(branchLabel);

  return (
    <div style={row.root}>
      <div
        style={{ ...row.header, background: hovered ? 'var(--vscode-list-hoverBackground, var(--versiondock-hover))' : 'transparent' }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onContextMenu={(e) => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY }); }}
        title={entry.path}
      >
        <Codicon
          name={entry.isMain ? 'repo' : 'repo-clone'}
          style={{ fontSize: '13px', flexShrink: 0, color: 'var(--vscode-foreground, var(--versiondock-text))' }}
        />
        <div style={row.info}>
          <span style={row.name}>
            <span style={row.nameText}>{dirName}</span>
            {entry.isMain && <span style={row.mainBadge}>{t('main')}</span>}
            {!entry.isMain && entry.isInWorkspace && <span style={row.workspaceBadge}>{t('in workspace')}</span>}
            {entry.isLocked && (
              <Codicon name="lock" style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground, var(--versiondock-muted))' }} />
            )}
          </span>
          <span style={row.meta}>
            <span style={row.branch(branchClr)} title={branchLabel}>
              <Codicon name={entry.isDetached ? 'git-commit' : 'git-branch'} style={{ fontSize: '10px', flexShrink: 0 }} />
              <span style={row.branchName}>{branchLabel}</span>
            </span>
            {entry.isPrunable && (
              <span style={row.prunableBadge}>{t('prunable')}</span>
            )}
          </span>
        </div>
        {hovered && !entry.isMain && (
          <div style={row.actions}>
            {!entry.isInWorkspace && onAddToWorkspace && (
              <button
                data-action-btn=""
                style={row.btn}
                title={t('Add Folder to Workspace')}
                onClick={(e) => { e.stopPropagation(); onAddToWorkspace(entry.path); }}
              >
                <Codicon name="add" />
              </button>
            )}
            {entry.isInWorkspace && onOpenInExplorer && (
              <button
                data-action-btn=""
                style={row.btn}
                title={t('Reveal in Explorer')}
                onClick={(e) => { e.stopPropagation(); onOpenInExplorer(repoId, entry.path); }}
              >
                <Codicon name="folder-opened" />
              </button>
            )}
            {onOpenInNewWindow && (
              <button
                data-action-btn=""
                style={row.btn}
                title={t('Open in New Window')}
                onClick={(e) => { e.stopPropagation(); onOpenInNewWindow(entry.path); }}
              >
                <Codicon name="link-external" />
              </button>
            )}
            {entry.isLocked ? (
              onUnlock && (
                <button
                  data-action-btn=""
                  style={row.btn}
                  title={t('Unlock worktree')}
                  onClick={(e) => { e.stopPropagation(); onUnlock(repoId, entry.path); }}
                >
                  <Codicon name="unlock" />
                </button>
              )
            ) : (
              onLock && (
                <button
                  data-action-btn=""
                  style={row.btn}
                  title={t('Lock worktree')}
                  onClick={(e) => { e.stopPropagation(); onLock(repoId, entry.path); }}
                >
                  <Codicon name="lock" />
                </button>
              )
            )}
            {onDelete && (
              <button
                data-action-btn=""
                style={{ ...row.btn, color: 'var(--vscode-errorForeground, var(--versiondock-danger))' }}
                title={t('Remove worktree')}
                onClick={(e) => { e.stopPropagation(); onDelete(repoId, entry.path, false); }}
              >
                <Codicon name="trash" />
              </button>
            )}
          </div>
        )}
      </div>

      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={ctxItems(entry, t)}
          onSelect={(id) => {
            setCtxMenu(null);
            if (id === 'explorer') onOpenInExplorer?.(repoId, entry.path);
            if (id === 'newwindow') onOpenInNewWindow?.(entry.path);
            if (id === 'os') onOpenInOS?.(entry.path);
            if (id === 'add-to-workspace') onAddToWorkspace?.(entry.path);
            if (id === 'lock') onLock?.(repoId, entry.path);
            if (id === 'unlock') onUnlock?.(repoId, entry.path);
            if (id === 'delete') onDelete?.(repoId, entry.path, false);
            if (id === 'force-delete') onDelete?.(repoId, entry.path, true);
          }}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </div>
  );
}

// ── Per-repo section ──────────────────────────────────────────────────────────

function RepoSection({
  repo,
  multiRepo,
  onDelete,
  onLock,
  onUnlock,
  onPrune,
  onOpenInExplorer,
  onOpenInNewWindow,
  onOpenInOS,
  onAddToWorkspace,
  onRequestCreate,
}: {
  repo: RepoWorktrees;
  multiRepo: boolean;
  onDelete?: WorktreePanelProps['onDelete'];
  onLock?: WorktreePanelProps['onLock'];
  onUnlock?: WorktreePanelProps['onUnlock'];
  onPrune?: WorktreePanelProps['onPrune'];
  onOpenInExplorer?: WorktreePanelProps['onOpenInExplorer'];
  onOpenInNewWindow?: WorktreePanelProps['onOpenInNewWindow'];
  onOpenInOS?: WorktreePanelProps['onOpenInOS'];
  onAddToWorkspace?: WorktreePanelProps['onAddToWorkspace'];
  onRequestCreate?: WorktreePanelProps['onRequestCreate'];
}) {
  const { t } = useI18n();
  const hasPrunable = repo.worktrees.some((w) => w.isPrunable);
  const projectColor = readableAccentColor(repo.repoColor || '#4EC9B0');

  return (
    <div style={css.repoSection}>
      {multiRepo && (
        <div style={css.repoHeader(projectColor)}>
          <span style={css.dot(projectColor)} />
          <span style={css.repoName}>{repo.repoName}</span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: '2px' }}>
            {hasPrunable && onPrune && (
              <button
                data-action-btn=""
                style={css.headerBtn}
                title={t('Prune stale worktrees')}
                onClick={() => onPrune(repo.repoId)}
              >
                <Codicon name="git-compare" style={{ fontSize: '12px' }} />
              </button>
            )}
            {!repo.isLinkedWorktree && onRequestCreate && (
              <button
                data-action-btn=""
                style={css.headerBtn}
                title={t('Add worktree')}
                onClick={() => onRequestCreate(repo.repoId)}
              >
                <Codicon name="add" style={{ fontSize: '12px' }} />
              </button>
            )}
          </div>
        </div>
      )}
      {repo.worktrees.length === 0 ? (
        <div style={css.empty}>{t('No worktrees')}</div>
      ) : (
        repo.worktrees.map((w) => (
          <WorktreeRow
            key={w.path}
            entry={w}
            repoId={repo.repoId}
            onDelete={onDelete}
            onLock={onLock}
            onUnlock={onUnlock}
            onOpenInExplorer={onOpenInExplorer}
            onOpenInNewWindow={onOpenInNewWindow}
            onOpenInOS={onOpenInOS}
            onAddToWorkspace={onAddToWorkspace}
          />
        ))
      )}
      {!multiRepo && (hasPrunable || !repo.isLinkedWorktree) && (
        <div style={css.singleRepoActions}>
          {hasPrunable && onPrune && (
            <button data-secondary-action-btn="" style={css.actionBtn} onClick={() => onPrune(repo.repoId)}>
              <Codicon name="git-compare" style={{ marginRight: '4px', fontSize: '12px' }} />
              {t('Prune stale')}
            </button>
          )}
          {!repo.isLinkedWorktree && onRequestCreate && (
            <button data-secondary-action-btn="" style={css.actionBtn} onClick={() => onRequestCreate(repo.repoId)}>
              <Codicon name="add" style={{ marginRight: '4px', fontSize: '12px' }} />
              {t('New Worktree')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ── Public component ──────────────────────────────────────────────────────────

export function WorktreePanel({
  repos = [],
  customRepos,
  loading: externalLoading,
  error: externalError,
  multiRepo: forcedMultiRepo,
  onDelete,
  onLock,
  onUnlock,
  onPrune,
  onOpenInExplorer,
  onOpenInNewWindow,
  onOpenInOS,
  onAddToWorkspace,
  onRequestCreate,
}: WorktreePanelProps) {
  const { t } = useI18n();
  const storeWorktrees = useAppStore((state) => state.worktrees);
  const loadWorktrees = useAppStore((state) => state.loadWorktrees);
  const worktreeOperation = useAppStore((state) => state.worktreeOperation);
  const systemOpen = useAppStore((state) => state.systemOpen);

  useEffect(() => {
    if (!customRepos && repos.length > 0) {
      for (const repo of repos) {
        void loadWorktrees(repo.meta.id);
      }
    }
  }, [customRepos, loadWorktrees, repos]);

  const defaultDelete = (repoId: string, worktreePath: string, force: boolean) => {
    if (confirm(force ? t('Force remove worktree {0}?', worktreePath) : t('Remove worktree {0}?', worktreePath))) {
      void worktreeOperation(repoId, { type: 'remove', path: worktreePath, force });
    }
  };

  const defaultLock = (repoId: string, worktreePath: string) => {
    void worktreeOperation(repoId, { type: 'lock', path: worktreePath });
  };

  const defaultUnlock = (repoId: string, worktreePath: string) => {
    void worktreeOperation(repoId, { type: 'unlock', path: worktreePath });
  };

  const defaultPrune = (repoId: string) => {
    void worktreeOperation(repoId, { type: 'prune' });
  };

  const defaultCreate = (repoId: string) => {
    const branch = prompt(t('Branch name'));
    if (!branch?.trim()) return;
    const newBranch = confirm(t('Create new branch'));
    void worktreeOperation(repoId, { type: 'create', branch: branch.trim(), new_branch: newBranch });
  };

  const defaultOpenInOS = (worktreePath: string) => {
    const matchedRepo = repos.find((r) => worktreePath.startsWith(r.meta.rootPath));
    if (matchedRepo) {
      void systemOpen(matchedRepo.meta.id, worktreePath, true);
    }
  };

  const resolvedRepos: RepoWorktrees[] = customRepos ?? repos.map((r) => {
    const list = storeWorktrees[r.meta.id] ?? [];
    return {
      repoId: r.meta.id,
      repoName: r.meta.name,
      repoColor: r.meta.color,
      isLinkedWorktree: Boolean(r.meta.isWorktree),
      worktrees: list.map(normalizeEntry),
    };
  });

  const multiRepo = forcedMultiRepo ?? (resolvedRepos.length >= 1);

  if (externalLoading) return <div style={css.empty}>{t('Loading…')}</div>;
  if (externalError) {
    return (
      <div style={css.errorRow}>
        <Codicon name="warning" style={{ marginRight: '4px', flexShrink: 0 }} />
        {externalError}
      </div>
    );
  }

  const allEmpty = resolvedRepos.every((r) => r.worktrees.length === 0);

  return (
    <div style={css.root}>
      {allEmpty && resolvedRepos.length === 0 ? (
        <div style={css.empty}>{t('No worktrees')}</div>
      ) : (
        resolvedRepos.map((repo) => (
          <RepoSection
            key={repo.repoId}
            repo={repo}
            multiRepo={multiRepo}
            onDelete={onDelete ?? defaultDelete}
            onLock={onLock ?? defaultLock}
            onUnlock={onUnlock ?? defaultUnlock}
            onPrune={onPrune ?? defaultPrune}
            onOpenInExplorer={onOpenInExplorer}
            onOpenInNewWindow={onOpenInNewWindow}
            onOpenInOS={onOpenInOS ?? defaultOpenInOS}
            onAddToWorkspace={onAddToWorkspace}
            onRequestCreate={onRequestCreate ?? defaultCreate}
          />
        ))
      )}
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const css = {
  root: { display: 'flex', flexDirection: 'column' as const, flex: 1, overflowY: 'auto' as const, background: 'var(--vscode-editor-background, var(--versiondock-bg))' },
  repoSection: { borderBottom: '1px solid var(--vscode-panel-border, var(--versiondock-border-soft))' } as React.CSSProperties,
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
    color: 'var(--vscode-foreground, var(--versiondock-text))',
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
    fontStyle: 'italic' as const,
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
  root: { borderBottom: '1px solid color-mix(in srgb, var(--vscode-panel-border, var(--versiondock-border-soft)) 50%, transparent)' } as React.CSSProperties,
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '5px 8px',
    cursor: 'default',
    minHeight: '32px',
    userSelect: 'none' as const,
  } as React.CSSProperties,
  info: { display: 'flex', flexDirection: 'column' as const, flex: 1, minWidth: 0 },
  name: {
    fontSize: '12px',
    display: 'flex',
    alignItems: 'center',
    gap: '5px',
    minWidth: 0,
    color: 'var(--vscode-foreground, var(--versiondock-text))',
  } as React.CSSProperties,
  nameText: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    minWidth: 0,
    flexShrink: 1,
    fontWeight: 500,
  } as React.CSSProperties,
  mainBadge: {
    fontSize: '9px',
    padding: '1px 5px',
    borderRadius: '3px',
    flexShrink: 0,
    background: 'var(--versiondock-badge-background, #0e639c)',
    color: 'var(--versiondock-badge-foreground, #ffffff)',
    fontWeight: 'normal',
    letterSpacing: '0.03em',
    lineHeight: '13px',
  } as React.CSSProperties,
  workspaceBadge: {
    fontSize: '9px',
    padding: '1px 5px',
    borderRadius: '3px',
    flexShrink: 0,
    background: 'var(--vscode-statusBarItem-remoteBackground, #16825d)',
    color: 'var(--vscode-statusBarItem-remoteForeground, #ffffff)',
    fontWeight: 'normal',
    letterSpacing: '0.03em',
    lineHeight: '13px',
  } as React.CSSProperties,
  meta: { display: 'flex', alignItems: 'center', gap: '6px', marginTop: '4px' } as React.CSSProperties,
  branch: (color: string): React.CSSProperties => ({
    fontSize: '10px',
    fontWeight: 600,
    display: 'inline-flex',
    alignItems: 'center',
    gap: '3px',
    background: `${color}33`,
    color,
    border: `1px solid ${color}88`,
    borderRadius: '3px',
    padding: '1px 5px',
    flexShrink: 1,
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    minWidth: 0,
    maxWidth: '160px',
  }),
  branchName: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, minWidth: 0 },
  prunableBadge: {
    fontSize: '9px',
    padding: '0 4px',
    borderRadius: '3px',
    flexShrink: 0,
    background: 'var(--vscode-inputValidation-warningBackground, rgba(204, 167, 0, 0.2))',
    color: 'var(--vscode-inputValidation-warningForeground, var(--versiondock-warning))',
  } as React.CSSProperties,
  actions: { display: 'flex', gap: '2px', flexShrink: 0, marginLeft: 'auto' } as React.CSSProperties,
  btn: {
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    padding: '2px 4px',
    borderRadius: '3px',
    fontSize: '13px',
    display: 'flex',
    alignItems: 'center',
    color: 'var(--vscode-foreground, var(--versiondock-text))',
  } as React.CSSProperties,
};
