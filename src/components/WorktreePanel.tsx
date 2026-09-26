import React, { useEffect, useState } from 'react';
import { Codicon } from './Codicon';
import { BranchRefBadge } from './BranchRefBadge';
import { ContextMenu, type ContextMenuEntry } from './ContextMenu';
import { useI18n } from '../i18n';
import { choiceDialog, confirmDialog, promptDialog } from './dialogService';
import { useSpeedSearch } from '../hooks/useSpeedSearch';
import { SpeedSearchIndicator } from './SpeedSearchIndicator';
import { branchColor, headColor, readableAccentColor } from './branchColor';
import { useAppStore } from '../store/appStore';
import type { RepositoryStatus, WorktreeEntry as BoundWorktreeEntry } from '../bindings/generated';
import { WorkingDiffPanel } from './BranchWorkingDiffPanel';

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
  onOpenInOS?: (repoId: string, worktreePath: string) => void;
  onAddToWorkspace?: (worktreePath: string) => void;
  onRequestCreate?: (repoId: string) => void;
}

function normalizeEntry(entry: BoundWorktreeEntry | NormalizedWorktreeEntry, workspacePaths: string[] = []): NormalizedWorktreeEntry {
  const isMain = 'isMain' in entry ? Boolean((entry as NormalizedWorktreeEntry).isMain) : Boolean((entry as BoundWorktreeEntry).main);
  const isDetached = 'isDetached' in entry ? Boolean((entry as NormalizedWorktreeEntry).isDetached) : Boolean((entry as BoundWorktreeEntry).detached);
  const isBare = 'isBare' in entry ? Boolean((entry as NormalizedWorktreeEntry).isBare) : Boolean((entry as BoundWorktreeEntry).bare);
  const isLocked = 'isLocked' in entry ? Boolean((entry as NormalizedWorktreeEntry).isLocked) : Boolean((entry as BoundWorktreeEntry).locked);
  const isPrunable = 'isPrunable' in entry ? Boolean((entry as NormalizedWorktreeEntry).isPrunable) : Boolean((entry as BoundWorktreeEntry).prunable);
  const branchShort = ('branchShort' in entry && (entry as NormalizedWorktreeEntry).branchShort)
    ? (entry as NormalizedWorktreeEntry).branchShort
    : (entry.branch || '').replace(/^refs\/heads\//, '');
  const isInWorkspace = 'isInWorkspace' in entry && typeof (entry as NormalizedWorktreeEntry).isInWorkspace === 'boolean'
    ? Boolean((entry as NormalizedWorktreeEntry).isInWorkspace)
    : workspacePaths.some((wp) => {
        const normalizedWp = wp.replace(/[\\/]+$/, '').toLocaleLowerCase();
        const normalizedPath = entry.path.replace(/[\\/]+$/, '').toLocaleLowerCase();
        return normalizedPath === normalizedWp || normalizedPath.startsWith(`${normalizedWp}/`);
      });

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
    { id: 'open', label: t('Open in New Window'), icon: 'link-external' },
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
  onOpenInOS,
  onAddToWorkspace,
  onCompare,
}: {
  entry: NormalizedWorktreeEntry;
  repoId: string;
  onDelete?: WorktreePanelProps['onDelete'];
  onLock?: WorktreePanelProps['onLock'];
  onUnlock?: WorktreePanelProps['onUnlock'];
  onOpenInExplorer?: WorktreePanelProps['onOpenInExplorer'];
  onOpenInOS?: WorktreePanelProps['onOpenInOS'];
  onAddToWorkspace?: WorktreePanelProps['onAddToWorkspace'];
  onCompare?: (repoId: string, entry: NormalizedWorktreeEntry) => void;
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
            <BranchRefBadge label={branchLabel} kind={entry.isDetached ? 'head' : 'branch'} color={branchClr} />
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
            {onOpenInExplorer && (
              <button
                data-action-btn=""
                style={row.btn}
                title={t('Open Worktree')}
                onClick={(e) => { e.stopPropagation(); onOpenInExplorer(repoId, entry.path); }}
              >
                <Codicon name="folder-opened" />
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
            if (id === 'add-to-workspace') onAddToWorkspace?.(entry.path);
            if (id === 'explorer' || id === 'open') onOpenInExplorer?.(repoId, entry.path);
            if (id === 'os') onOpenInOS?.(repoId, entry.path);
            if (id === 'diff') onCompare?.(repoId, entry);
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
  onOpenInOS,
  onAddToWorkspace,
  onRequestCreate,
  onCompare,
  error,
}: {
  repo: RepoWorktrees;
  multiRepo: boolean;
  onDelete?: WorktreePanelProps['onDelete'];
  onLock?: WorktreePanelProps['onLock'];
  onUnlock?: WorktreePanelProps['onUnlock'];
  onPrune?: WorktreePanelProps['onPrune'];
  onOpenInExplorer?: WorktreePanelProps['onOpenInExplorer'];
  onOpenInOS?: WorktreePanelProps['onOpenInOS'];
  onAddToWorkspace?: WorktreePanelProps['onAddToWorkspace'];
  onRequestCreate?: WorktreePanelProps['onRequestCreate'];
  onCompare?: (repoId: string, entry: NormalizedWorktreeEntry) => void;
  error?: string | null;
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
      {error && (
        <div style={{ ...css.empty, color: 'var(--vscode-errorForeground, #f48771)' }}>
          <Codicon name="error" style={{ marginRight: '6px' }} />
          {error}
        </div>
      )}
      {repo.worktrees.length === 0 && !error ? (
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
            onOpenInOS={onOpenInOS}
            onAddToWorkspace={onAddToWorkspace}
            onCompare={onCompare}
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
  onOpenInOS,
  onAddToWorkspace,
  onRequestCreate,
}: WorktreePanelProps) {
  const { t } = useI18n();
  const speedSearch = useSpeedSearch('worktrees');
  const storeWorktrees = useAppStore((state) => state.worktrees);
  const loadWorktrees = useAppStore((state) => state.loadWorktrees);
  const worktreeOperation = useAppStore((state) => state.worktreeOperation);
  const branchesByRepo = useAppStore((state) => state.branchesByRepo);
  const openWorktree = useAppStore((state) => state.openWorktree);
  const loadWorktreeDiff = useAppStore((state) => state.loadWorktreeDiff);
  const worktreeDiff = useAppStore((state) => state.worktreeDiff);

  useEffect(() => {
    if (!customRepos && repos.length > 0) {
      for (const repo of repos) {
        void loadWorktrees(repo.meta.id);
      }
    }
  }, [customRepos, loadWorktrees, repos]);

  const defaultDelete = async (repoId: string, worktreePath: string, force: boolean) => {
    const title = force ? t('Force Remove Worktree') : t('Remove Worktree');
    const message = force
      ? t('Are you sure you want to force remove worktree "{0}"? All uncommitted local changes and untracked files will be permanently lost.', worktreePath)
      : t('Remove worktree "{0}" from repository?', worktreePath);
    const confirmed = await confirmDialog({
      title,
      message,
      confirmLabel: force ? t('Force Remove') : t('Remove'),
      danger: true,
    });
    if (!confirmed) return;
    void worktreeOperation(repoId, { type: 'remove', path: worktreePath, force });
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

  const defaultCreate = async (repoId: string) => {
    const branches = [...new Map((branchesByRepo[repoId] ?? []).map((branch) => [branch.name, branch])).values()];
    const branchChoices = new Map(branches.map((branch, index) => [`branch:${index}`, branch]));
    const selected = await choiceDialog({
      title: t('New Worktree — Branch'),
      message: t('Select branch for new worktree'),
      choices: [
        { id: 'new', label: t('Create new branch…'), icon: 'add' },
        ...branches.map((branch, index) => ({
          id: `branch:${index}`,
          label: branch.name,
          description: branch.current ? t('(current)') : undefined,
          icon: branch.remote ? 'cloud' : 'git-branch',
        })),
      ],
    });
    if (!selected) return;
    if (selected === 'new') {
      const branch = await promptDialog({ title: t('New Worktree — New Branch Name'), message: t('New branch name'), inputLabel: t('Branch name') });
      if (branch?.trim()) void worktreeOperation(repoId, { type: 'create', branch: branch.trim(), new_branch: true });
      return;
    }
    const branch = branchChoices.get(selected);
    if (branch) void worktreeOperation(repoId, { type: 'create', branch: branch.name, new_branch: false });
  };
  const defaultCompare = (repoId: string, entry: NormalizedWorktreeEntry) => {
    void loadWorktreeDiff(repoId, entry.path, 'HEAD');
  };

  const openWorkspace = useAppStore((state) => state.openWorkspace);
  const workspacePaths = useAppStore((state) => state.snapshot?.workspace.paths ?? []);
  const loadErrors = useAppStore((state) => state.loadErrors);

  const defaultOpen = (repoId: string, worktreePath: string) => { void openWorktree(repoId, worktreePath, false); };
  const defaultOpenInOS = (repoId: string, worktreePath: string) => { void openWorktree(repoId, worktreePath, true); };
  const defaultAddToWorkspace = async (worktreePath: string) => {
    if (!workspacePaths.includes(worktreePath)) {
      await openWorkspace([...workspacePaths, worktreePath]);
    }
  };

  const resolvedRepos: RepoWorktrees[] = (customRepos ?? repos.map((r) => {
    const rawList = storeWorktrees[r.meta.id];
    const list = Array.isArray(rawList) ? rawList : [];
    return {
      repoId: r.meta.id,
      repoName: r.meta.name,
      repoColor: r.meta.color,
      isLinkedWorktree: Boolean(r.meta.isWorktree),
      worktrees: list.map((entry) => normalizeEntry(entry, workspacePaths)),
    };
  })).flatMap((repo) => {
    const needle = speedSearch.query.trim().toLocaleLowerCase();
    if (!needle || repo.repoName.toLocaleLowerCase().includes(needle)) return [repo];
    const worktrees = repo.worktrees.filter((entry) => `${entry.path} ${entry.branch ?? ''} ${entry.head}`.toLocaleLowerCase().includes(needle));
    return worktrees.length ? [{ ...repo, worktrees }] : [];
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

  if (worktreeDiff) return <WorkingDiffPanel source="worktree" />;
  return (
    <div style={css.root}>
      <SpeedSearchIndicator query={speedSearch.query} onClear={speedSearch.clear} />
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
            onOpenInExplorer={onOpenInExplorer ?? defaultOpen}
            onOpenInOS={onOpenInOS ?? defaultOpenInOS}
            onAddToWorkspace={onAddToWorkspace ?? defaultAddToWorkspace}
            onRequestCreate={onRequestCreate ?? defaultCreate}
            onCompare={defaultCompare}
            error={loadErrors[`worktrees:${repo.repoId}`]}
          />
        ))
      )}
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const css = {
  root: { display: 'flex', flexDirection: 'column' as const, flex: 1, overflowY: 'auto' as const, minHeight: 0 },
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
