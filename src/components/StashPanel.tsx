import { buildSavedChangeTree, type TreeDir } from './savedChangeTree';
import { useState, useEffect, useMemo } from 'react';
import { Codicon } from './Codicon';
import { RepositoryGroup } from './RepositoryGroup';
import { BranchRefBadge } from './BranchRefBadge';
import { ContextMenu } from './ContextMenu';
import { FileIcon } from './FileIcon';
import { branchColor } from './branchColor';
import { useAppStore } from '../store/appStore';
import { useI18n } from '../i18n';
import { confirmDialog } from './dialogService';
import type { RepositoryStatus, ShelfFileEntry, StashEntry } from '../bindings/generated';
import { useSpeedSearch } from '../hooks/useSpeedSearch';
import { SpeedSearchIndicator } from './SpeedSearchIndicator';

export type StashItem = StashEntry;

export type ExpansionCommand = { sequence: number; expanded: boolean };

const STATUS_COLORS: Record<string, string> = {
  modified: 'var(--vscode-gitDecoration-modifiedResourceForeground, var(--versiondock-warning, #e2c08d))',
  added: 'var(--vscode-gitDecoration-addedResourceForeground, var(--versiondock-success, #73c991))',
  deleted: 'var(--vscode-gitDecoration-deletedResourceForeground, var(--versiondock-danger, #c74e39))',
  renamed: 'var(--vscode-gitDecoration-renamedResourceForeground, #73c991)',
  untracked: 'var(--vscode-gitDecoration-untrackedResourceForeground, var(--versiondock-success, #73c991))',
  conflicted: 'var(--vscode-gitDecoration-conflictingResourceForeground, var(--versiondock-danger, #e51400))',
};

const STATUS_LETTERS: Record<string, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
  conflicted: 'C',
};

const BASE_PAD = 20;
const LEVEL_PAD = 20;

function formatDate(
  iso: string,
  t: (text: string, ...args: (string | number)[]) => string,
  language = 'zh-CN',
): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const diffMs = Date.now() - d.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return t('just now');
    if (diffMin < 60) return t('{0}m ago', diffMin);
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return t('{0}h ago', diffH);
    const diffD = Math.floor(diffH / 24);
    if (diffD < 7) return t('{0}d ago', diffD);
    return d.toLocaleDateString(language === 'zh-CN' ? 'zh-CN' : 'en-US', {
      month: 'short',
      day: 'numeric',
      year: diffD > 365 ? 'numeric' : undefined,
    });
  } catch {
    return iso;
  }
}

function getMessageTitle(fullMessage: string, fallback: string): string {
  if (!fullMessage) return fallback;
  const firstLine = fullMessage.split('\n')[0].trim();
  return firstLine || fallback;
}

// ── Tree data structure ───────────────────────────────────────────────────────

type StashFile = ShelfFileEntry;

function countFiles(node: TreeDir): number {
  let c = 0;
  for (const ch of node.children) {
    if (ch.kind === 'file') c++;
    else c += countFiles(ch);
  }
  return c;
}

// ── File row ──────────────────────────────────────────────────────────────────

function FileRow({
  file,
  repoId,
  entry,
  depth = 0,
  onOpenFileDiff,
}: {
  file: StashFile;
  repoId: string;
  entry: StashItem;
  depth?: number;
  onOpenFileDiff?: (repoId: string, reference: string, filePath: string) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const { t } = useI18n();
  const fname = file.path.split('/').pop() ?? file.path;
  const dir = file.path.includes('/')
    ? file.path.split('/').slice(0, -1).join('/')
    : '';
  const color =
    STATUS_COLORS[file.status] ?? 'var(--versiondock-foreground, var(--vscode-foreground, #ccc))';
  const letter = STATUS_LETTERS[file.status] ?? 'M';
  const paddingLeft = BASE_PAD + depth * LEVEL_PAD;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        minHeight: '22px',
        fontSize: '12px',
        gap: '3px',
        paddingLeft,
        paddingRight: '8px',
        cursor: onOpenFileDiff ? 'pointer' : 'default',
        background: hovered
          ? 'var(--vscode-list-hoverBackground, var(--versiondock-list-hover, rgba(255,255,255,0.06)))'
          : 'transparent',
      }}
      onClick={() => onOpenFileDiff?.(repoId, entry.reference, file.path)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={t('{0} — click to open diff', file.path)}
    >
      <FileIcon name={fname} />
      <span
        style={{
          color,
          flex: 1,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          minWidth: 0,
        }}
      >
        {fname}
      </span>
      {depth === 0 && dir && (
        <span
          style={{
            fontSize: '11px',
            color: 'var(--versiondock-muted, var(--vscode-descriptionForeground, #888))',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flexShrink: 1,
            maxWidth: '80px',
          }}
        >
          {dir}
        </span>
      )}
      <span
        style={{
          fontSize: '10px',
          fontWeight: 'bold',
          color,
          flexShrink: 0,
          width: '12px',
          textAlign: 'center',
        }}
      >
        {letter}
      </span>
    </div>
  );
}

// ── Tree directory node ───────────────────────────────────────────────────────

function TreeDirNode({
  node,
  depth,
  repoId,
  entry,
  expansion,
  onManualExpansionChange,
  onOpenFileDiff,
}: {
  node: TreeDir;
  depth: number;
  repoId: string;
  entry: StashItem;
  expansion: ExpansionCommand;
  onManualExpansionChange: () => void;
  onOpenFileDiff?: (repoId: string, reference: string, filePath: string) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [localExpansion, setLocalExpansion] = useState<ExpansionCommand>({ sequence: 0, expanded: true });
  const open = localExpansion.sequence === expansion.sequence ? localExpansion.expanded : expansion.expanded;
  const paddingLeft = BASE_PAD + depth * LEVEL_PAD;
  const fc = countFiles(node);

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          minHeight: '22px',
          fontSize: '12px',
          paddingLeft,
          paddingRight: '8px',
          gap: '0',
          minWidth: 0,
          overflow: 'hidden',
          boxSizing: 'border-box',
          background: hovered
            ? 'var(--vscode-list-hoverBackground, var(--versiondock-list-hover, rgba(255,255,255,0.06)))'
            : 'transparent',
          color: 'var(--versiondock-foreground, var(--vscode-foreground, #ccc))',
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            cursor: 'pointer',
            userSelect: 'none',
            paddingLeft: '2px',
          }}
          onClick={() => { onManualExpansionChange(); setLocalExpansion({ sequence: expansion.sequence, expanded: !open }); }}
          title={node.path}
        >
          <Codicon
            name={open ? 'chevron-down' : 'chevron-right'}
            style={{ fontSize: '12px', width: '12px', flexShrink: 0 }}
          />
          <FileIcon name={node.name} folder open={open} />
          <span
            style={{
              flex: 1,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {node.name}
          </span>
          <span
            style={{
              fontSize: '10px',
              color: 'var(--versiondock-muted, var(--vscode-descriptionForeground, #888))',
              flexShrink: 0,
            }}
          >
            {fc}
          </span>
        </div>
      </div>
      {open &&
        node.children.map((child) =>
          child.kind === 'dir' ? (
            <TreeDirNode
              key={child.path}
              node={child}
              depth={depth + 1}
              repoId={repoId}
              entry={entry}
              expansion={expansion}
              onManualExpansionChange={onManualExpansionChange}
              onOpenFileDiff={onOpenFileDiff}
            />
          ) : (
            <FileRow
              key={child.file.path}
              file={child.file}
              repoId={repoId}
              entry={entry}
              depth={depth + 1}
              onOpenFileDiff={onOpenFileDiff}
            />
          ),
        )}
    </div>
  );
}

// ── Single stash row ──────────────────────────────────────────────────────────

function StashRow({
  entry,
  repoId,
  viewMode,
  expansion,
  onManualExpansionChange,
  onApply,
  onPop,
  onDrop,
  onOpenFileDiff,
  busy = false,
}: {
  entry: StashItem;
  repoId: string;
  viewMode: 'tree' | 'list';
  expansion: ExpansionCommand;
  onManualExpansionChange: () => void;
  onApply: (repoId: string, reference: string, expectedHash?: string) => void;
  onPop: (repoId: string, reference: string, expectedHash?: string) => void;
  onDrop: (repoId: string, reference: string, expectedHash?: string) => void;
  onOpenFileDiff?: (repoId: string, reference: string, filePath: string) => void;
  busy?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const [localExpansion, setLocalExpansion] = useState<ExpansionCommand>({ sequence: 0, expanded: false });
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const { t, language } = useI18n();
  const expanded = localExpansion.sequence === expansion.sequence ? localExpansion.expanded : expansion.expanded;
  const fullMessage = entry.fullMessage || entry.message || entry.reference;
  const messageTitle = getMessageTitle(entry.message || fullMessage, entry.reference);
  const files = entry.files ?? [];
  const treeNodes = useMemo(
    () => (viewMode === 'tree' && entry.files ? buildSavedChangeTree(entry.files) : null),
    [entry.files, viewMode],
  );

  const branchName = entry.branch;
  const branchColorHex = branchName ? branchColor(branchName) : '#11b0ff';

  return (
    <div style={rowStyle.root}>
      {/* Header */}
      <div
        style={{
          ...rowStyle.header,
          background: hovered
            ? 'var(--vscode-list-hoverBackground, var(--versiondock-list-hover, rgba(255,255,255,0.06)))'
            : 'transparent',
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onContextMenu={(e) => {
          e.preventDefault();
          setCtxMenu({ x: e.clientX, y: e.clientY });
        }}
        onClick={() => { onManualExpansionChange(); setLocalExpansion({ sequence: expansion.sequence, expanded: !expanded }); }}
        title={fullMessage}
      >
        <button
          type="button"
          style={rowStyle.chevronBtn}
          onClick={(e) => {
            e.stopPropagation();
            onManualExpansionChange();
            setLocalExpansion({ sequence: expansion.sequence, expanded: !expanded });
          }}
        >
          <Codicon
            name={expanded ? 'chevron-down' : 'chevron-right'}
            style={{ fontSize: '11px' }}
          />
        </button>
        <Codicon name="save" style={{ fontSize: '13px', flexShrink: 0 }} />
        <div style={rowStyle.info}>
          <span style={rowStyle.name}>
            <span style={rowStyle.message} title={fullMessage}>
              {messageTitle}
            </span>
            {branchName && (
              <BranchRefBadge label={branchName} color={branchColorHex} style={{ maxWidth: 'min(160px, 40%)', flexShrink: 0 }} />
            )}
          </span>
          <span style={rowStyle.meta}>
            {files.length > 0 && (
              <span style={rowStyle.fileCount}>
                {files.length === 1
                  ? t('{0} file', files.length)
                  : t('{0} files', files.length)}
              </span>
            )}
            <span style={rowStyle.date}>{formatDate(entry.date, t, language)}</span>
          </span>
        </div>
        {hovered && (
          <div style={rowStyle.actions}>
            <button
              type="button"
              style={{ ...rowStyle.btn, opacity: busy ? 0.4 : 1, cursor: busy ? 'not-allowed' : 'pointer' }}
              disabled={busy}
              title={t('Pop (apply and drop)')}
              onClick={(e) => {
                e.stopPropagation();
                if (busy) return;
                onPop(repoId, entry.reference, entry.hash);
              }}
            >
              <Codicon name="desktop-download" />
            </button>
            <button
              type="button"
              style={{ ...rowStyle.btn, opacity: busy ? 0.4 : 1, cursor: busy ? 'not-allowed' : 'pointer' }}
              disabled={busy}
              title={t('Apply (keep stash)')}
              onClick={(e) => {
                e.stopPropagation();
                if (busy) return;
                onApply(repoId, entry.reference, entry.hash);
              }}
            >
              <Codicon name="arrow-down" />
            </button>
            <button
              type="button"
              style={{
                ...rowStyle.btn,
                color: 'var(--versiondock-danger, var(--vscode-errorForeground, #f48771))',
                opacity: busy ? 0.4 : 1,
                cursor: busy ? 'not-allowed' : 'pointer',
              }}
              disabled={busy}
              title={t('Drop stash')}
              onClick={(e) => {
                e.stopPropagation();
                if (busy) return;
                onDrop(repoId, entry.reference, entry.hash);
              }}
            >
              <Codicon name="trash" />
            </button>
          </div>
        )}
      </div>

      {/* Expanded body: file list (flat or tree) */}
      {expanded && (
        <div style={rowStyle.fileList}>
          {files.length === 0 ? (
            <div style={rowStyle.emptyFiles}>{t('No files')}</div>
          ) : viewMode === 'tree' && treeNodes ? (
            treeNodes.map((node) =>
              node.kind === 'dir' ? (
                <TreeDirNode
                  key={node.path}
                  node={node}
                  depth={0}
                  repoId={repoId}
                  entry={entry}
                  expansion={expansion}
                  onManualExpansionChange={onManualExpansionChange}
                  onOpenFileDiff={onOpenFileDiff}
                />
              ) : (
                <FileRow
                  key={node.file.path}
                  file={node.file}
                  repoId={repoId}
                  entry={entry}
                  depth={0}
                  onOpenFileDiff={onOpenFileDiff}
                />
              ),
            )
          ) : (
            files.map((f) => (
              <FileRow
                key={f.path}
                file={f}
                repoId={repoId}
                entry={entry}
                onOpenFileDiff={onOpenFileDiff}
              />
            ))
          )}
        </div>
      )}

      {/* Context Menu */}
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={[
            { id: 'pop', label: t('Pop (apply & drop)'), icon: 'desktop-download', disabled: busy },
            { id: 'apply', label: t('Apply (keep stash)'), icon: 'arrow-down', disabled: busy },
            { separator: true },
            { id: 'drop', label: t('Delete'), icon: 'trash', danger: true, disabled: busy },
          ]}
          onSelect={(id) => {
            if (busy) return;
            if (id === 'pop') onPop(repoId, entry.reference, entry.hash);
            else if (id === 'apply') onApply(repoId, entry.reference, entry.hash);
            else if (id === 'drop') onDrop(repoId, entry.reference, entry.hash);
            setCtxMenu(null);
          }}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </div>
  );
}

// ── Stash Panel (Main component) ─────────────────────────────────────────────

export function StashPanel({ active = true,
  repos,
  viewMode = 'tree',
  expansion = { sequence: 0, expanded: false },
  onManualExpansionChange = () => undefined,
  onOpenFileDiff,
}: {
  active?: boolean;
  repos: RepositoryStatus[];
  selectedPaths?: Map<string, string[]>;
  viewMode?: 'tree' | 'list';
  expansion?: ExpansionCommand;
  onManualExpansionChange?: () => void;
  onOpenFileDiff?: (repoId: string, reference: string, filePath: string) => void;
}) {
  const stashes = useAppStore((state) => state.stashes);
  const loadErrors = useAppStore((state) => state.loadErrors);
  const loadStashes = useAppStore((state) => state.loadStashes);
  const stashOperation = useAppStore((state) => state.stashOperation);
  const { t } = useI18n();
  const speedSearch = useSpeedSearch('stash', active);
  const [operatingRepos, setOperatingRepos] = useState<Set<string>>(new Set());

  useEffect(() => {
    for (const repo of repos) {
      if (repo.meta.kind === 'git' && !stashes[repo.meta.id] && !loadErrors[`stashes:${repo.meta.id}`]) {
        void loadStashes(repo.meta.id);
      }
    }
  }, [loadStashes, loadErrors, repos, stashes]);

  const handleApply = async (repoId: string, reference: string, expectedHash?: string) => {
    if (operatingRepos.has(repoId)) return;
    setOperatingRepos((prev) => new Set(prev).add(repoId));
    try {
      await stashOperation(repoId, { type: 'apply', reference, expected_hash: expectedHash });
    } finally {
      setOperatingRepos((prev) => {
        const next = new Set(prev);
        next.delete(repoId);
        return next;
      });
    }
  };

  const handlePop = async (repoId: string, reference: string, expectedHash?: string) => {
    if (operatingRepos.has(repoId)) return;
    setOperatingRepos((prev) => new Set(prev).add(repoId));
    try {
      await stashOperation(repoId, { type: 'pop', reference, expected_hash: expectedHash });
    } finally {
      setOperatingRepos((prev) => {
        const next = new Set(prev);
        next.delete(repoId);
        return next;
      });
    }
  };

  const handleDrop = async (repoId: string, reference: string, expectedHash?: string) => {
    if (operatingRepos.has(repoId)) return;
    if (await confirmDialog({ title: t('Drop stash {0}?', reference), message: reference, danger: true })) {
      setOperatingRepos((prev) => new Set(prev).add(repoId));
      try {
        await stashOperation(repoId, { type: 'drop', reference, expected_hash: expectedHash });
      } finally {
        setOperatingRepos((prev) => {
          const next = new Set(prev);
          next.delete(repoId);
          return next;
        });
      }
    }
  };

  return (
    <div style={css.root} className="stash-panel">
      <SpeedSearchIndicator query={speedSearch.query} onClear={speedSearch.clear} />
      <div style={css.list} className="stash-list">
        {repos.map((repo) => {
          const needle = speedSearch.query.trim().toLocaleLowerCase();
          const list = ((stashes[repo.meta.id] ?? []) as StashItem[]).filter((entry) => !needle || `${repo.meta.name} ${entry.message} ${entry.fullMessage} ${entry.branch} ${entry.files.map((file) => file.path).join(' ')}`.toLocaleLowerCase().includes(needle));
          const projectColor = repo.meta.color || '#4ec9b0';
          const worktreeBranch = repo.meta.isWorktree ? repo.branch : undefined;
          const error = loadErrors[`stashes:${repo.meta.id}`];
          const isRepoBusy = operatingRepos.has(repo.meta.id);

          return (
            <section key={repo.meta.id} style={css.repoSection} className="stash-repo">
              {/* Repository Header - Always shown to match design */}
              <RepositoryGroup expansion={expansion} onToggle={onManualExpansionChange} name={repo.meta.name} color={projectColor} extras={worktreeBranch && <BranchRefBadge label={worktreeBranch} kind="worktree" color={branchColor(worktreeBranch)} />}>


              {/* Stash items or empty */}
              {error && (
                <div style={{ ...css.empty, color: 'var(--vscode-errorForeground, #f48771)' }} className="stash-empty">
                  <Codicon name="error" style={{ marginRight: '6px' }} />
                  {error}
                </div>
              )}

              {list.length === 0 && !error ? (
                <div style={css.empty} className="stash-empty">
                  {t('No stashes')}
                </div>
              ) : (
                list.map((entry) => (
                  <StashRow
                    key={entry.reference}
                    entry={entry}
                    repoId={repo.meta.id}
                    viewMode={viewMode}
                    expansion={expansion}
                    onManualExpansionChange={onManualExpansionChange}
                    onApply={handleApply}
                    onPop={handlePop}
                    onDrop={handleDrop}
                    onOpenFileDiff={onOpenFileDiff}
                    busy={isRepoBusy}
                  />
                ))
              )}
              </RepositoryGroup>
            </section>
          );
        })}
      </div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const css = {
  root: {
    minHeight: 0,
    flex: 1,
    display: 'flex',
    flexDirection: 'column' as const,
    overflow: 'hidden',
  },
  list: {
    minHeight: 0,
    flex: 1,
    overflowY: 'auto' as const,
  },
  repoSection: {
    borderBottom: '1px solid var(--versiondock-border, var(--vscode-panel-border, #333))',
  },
  empty: {
    padding: '16px 12px',
    fontSize: '12px',
    color: 'var(--versiondock-muted, var(--vscode-descriptionForeground, #888))',
    textAlign: 'center' as const,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
};

const rowStyle = {
  root: {
    borderBottom: '1px solid var(--versiondock-border-soft, var(--vscode-panel-border, #2a2a2a))',
  } as React.CSSProperties,
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '5px',
    padding: '5px 8px 5px 4px',
    cursor: 'pointer',
    minHeight: '32px',
    minWidth: 0,
    overflow: 'hidden',
  } as React.CSSProperties,
  chevronBtn: {
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    padding: '1px 3px',
    display: 'flex',
    alignItems: 'center',
    color: 'var(--versiondock-foreground, var(--vscode-foreground, #ccc))',
    flexShrink: 0,
  } as React.CSSProperties,
  info: {
    display: 'flex',
    flexDirection: 'column' as const,
    flex: 1,
    minWidth: 0,
  },
  name: {
    fontSize: '12px',
    overflow: 'hidden',
    whiteSpace: 'nowrap' as const,
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    minWidth: 0,
  } as React.CSSProperties,
  message: {
    flex: '0 1 auto',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    color: 'var(--versiondock-foreground, var(--vscode-foreground, #ccc))',
  } as React.CSSProperties,
  meta: {
    display: 'flex',
    gap: '8px',
    marginTop: '2px',
  } as React.CSSProperties,
  fileCount: {
    fontSize: '10px',
    color: 'var(--versiondock-muted, var(--vscode-descriptionForeground, #888))',
  },
  date: {
    fontSize: '10px',
    color: 'var(--versiondock-muted, var(--vscode-descriptionForeground, #888))',
    whiteSpace: 'nowrap' as const,
  },
  actions: {
    display: 'flex',
    gap: '2px',
    flexShrink: 0,
  } as React.CSSProperties,
  btn: {
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    padding: '2px 4px',
    borderRadius: '3px',
    fontSize: '13px',
    display: 'flex',
    alignItems: 'center',
    color: 'var(--versiondock-foreground, var(--vscode-foreground, #ccc))',
  } as React.CSSProperties,
  fileList: {
    display: 'flex',
    flexDirection: 'column' as const,
    borderTop: '1px solid var(--versiondock-border-soft, var(--vscode-panel-border, #2a2a2a))',
    background: 'var(--versiondock-subsurface, var(--vscode-sideBar-background, rgba(0,0,0,0.15)))',
  } as React.CSSProperties,
  emptyFiles: {
    padding: '6px 24px',
    fontSize: '11px',
    color: 'var(--versiondock-muted, var(--vscode-descriptionForeground, #888))',
  },
};
