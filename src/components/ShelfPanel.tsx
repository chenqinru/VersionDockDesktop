import { useState, useEffect, useMemo } from 'react';
import { Codicon } from './Codicon';
import { BranchRefBadge } from './BranchRefBadge';
import { FileIcon } from './FileIcon';
import { branchColor } from './branchColor';
import { useAppStore } from '../store/appStore';
import { useI18n } from '../i18n';
import { confirmDialog } from './dialogService';
import type { RepositoryStatus, ShelfEntry, ShelfFileEntry } from '../bindings/generated';

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

export type ExpansionCommand = { sequence: number; expanded: boolean };

function formatDate(iso: string, t: (text: string, ...args: (string | number)[]) => string): string {
  try {
    const d = new Date(iso);
    const diffMs = Date.now() - d.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return t('just now');
    if (diffMin < 60) return t('{0}m ago', diffMin);
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return t('{0}h ago', diffH);
    const diffD = Math.floor(diffH / 24);
    if (diffD < 7) return t('{0}d ago', diffD);
    return d.toLocaleDateString(undefined, {
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

type ShelfFile = ShelfFileEntry;
interface TreeDir {
  kind: 'dir';
  name: string;
  path: string;
  children: TreeNode[];
}
interface TreeFile {
  kind: 'file';
  name: string;
  file: ShelfFile;
}
type TreeNode = TreeDir | TreeFile;

function buildTree(files: ShelfFile[]): TreeNode[] {
  const root: TreeDir = { kind: 'dir', name: '', path: '', children: [] };
  for (const file of files) {
    const parts = file.path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      const dirPath = parts.slice(0, i + 1).join('/');
      let child = node.children.find(
        (c): c is TreeDir => c.kind === 'dir' && c.name === part,
      );
      if (!child) {
        child = { kind: 'dir', name: part, path: dirPath, children: [] };
        node.children.push(child);
      }
      node = child;
    }
    node.children.push({ kind: 'file', name: parts[parts.length - 1], file });
  }
  return collapseSingleChildDirs(root.children);
}

function collapseSingleChildDirs(nodes: TreeNode[]): TreeNode[] {
  return nodes.map((node) => {
    if (node.kind === 'file') return node;
    const children = collapseSingleChildDirs(node.children);
    if (children.length === 1 && children[0].kind === 'dir') {
      const only = children[0] as TreeDir;
      return {
        kind: 'dir' as const,
        name: `${node.name}/${only.name}`,
        path: only.path,
        children: only.children,
      };
    }
    return { ...node, children };
  });
}

// ── File row (shared between flat and tree) ───────────────────────────────────

function FileRow({
  file,
  repoId,
  entry,
  depth = 0,
  onUnshelveFile,
  onOpenFileDiff,
}: {
  file: ShelfFile;
  repoId: string;
  entry: ShelfEntry;
  depth?: number;
  onUnshelveFile: (repoId: string, shelveId: string, filePath: string) => void;
  onOpenFileDiff?: (repoId: string, shelfId: string, filePath: string) => void;
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
      onClick={() => onOpenFileDiff?.(repoId, entry.id, file.path)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={file.path}
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
      {hovered ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '1px',
            marginLeft: 'auto',
            flexShrink: 0,
          }}
        >
          <button
            type="button"
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--versiondock-foreground, var(--vscode-foreground, #ccc))',
              cursor: 'pointer',
              padding: '2px 4px',
              borderRadius: '3px',
              fontSize: '12px',
              display: 'flex',
              alignItems: 'center',
            }}
            title={t('Unshelve this file only')}
            onClick={(e) => {
              e.stopPropagation();
              onUnshelveFile(repoId, entry.id, file.path);
            }}
          >
            <Codicon name="desktop-download" />
          </button>
        </div>
      ) : (
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
      )}
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
  onUnshelveFile,
  onOpenFileDiff,
}: {
  node: TreeDir;
  depth: number;
  repoId: string;
  entry: ShelfEntry;
  expansion: ExpansionCommand;
  onManualExpansionChange: () => void;
  onUnshelveFile: (repoId: string, shelveId: string, filePath: string) => void;
  onOpenFileDiff?: (repoId: string, shelfId: string, filePath: string) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [localExpansion, setLocalExpansion] = useState<ExpansionCommand>({ sequence: 0, expanded: true });
  const open = localExpansion.sequence === expansion.sequence ? localExpansion.expanded : expansion.expanded;
  const paddingLeft = BASE_PAD + depth * LEVEL_PAD;

  function countFiles(n: TreeDir): number {
    let c = 0;
    for (const ch of n.children) {
      if (ch.kind === 'file') c++;
      else c += countFiles(ch);
    }
    return c;
  }
  const fileCount = countFiles(node);

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
            {fileCount}
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
              onUnshelveFile={onUnshelveFile}
              onOpenFileDiff={onOpenFileDiff}
            />
          ) : (
            <FileRow
              key={child.file.path}
              file={child.file}
              repoId={repoId}
              entry={entry}
              depth={depth + 1}
              onUnshelveFile={onUnshelveFile}
              onOpenFileDiff={onOpenFileDiff}
            />
          ),
        )}
    </div>
  );
}

// ── Single shelf row ─────────────────────────────────────────────────────────

function ShelfRow({
  entry,
  repoId,
  viewMode,
  expansion,
  onManualExpansionChange,
  onUnshelve,
  onUnshelveFile,
  onOpenFileDiff,
  onDrop,
}: {
  entry: ShelfEntry;
  repoId: string;
  viewMode: 'tree' | 'list';
  expansion: ExpansionCommand;
  onManualExpansionChange: () => void;
  onUnshelve: (repoId: string, shelveId: string) => void;
  onUnshelveFile: (repoId: string, shelveId: string, filePath: string) => void;
  onOpenFileDiff?: (repoId: string, shelfId: string, filePath: string) => void;
  onDrop: (repoId: string, shelveId: string) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [localExpansion, setLocalExpansion] = useState<ExpansionCommand>({ sequence: 0, expanded: false });
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const { t } = useI18n();
  const expanded = localExpansion.sequence === expansion.sequence ? localExpansion.expanded : expansion.expanded;
  const fullMessage = entry.name || entry.id;
  const messageTitle = getMessageTitle(fullMessage, entry.id);
  const treeNodes = useMemo(
    () => (viewMode === 'tree' ? buildTree(entry.files) : null),
    [entry.files, viewMode],
  );

  const branchName = entry.branch;
  const branchColorHex = branchName ? branchColor(branchName) : '#6aaed0';

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
        onDoubleClick={() => onUnshelve(repoId, entry.id)}
        title={t('{0} — double-click to unshelve', entry.name)}
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
        <Codicon name="archive" style={{ fontSize: '13px', flexShrink: 0 }} />
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
            <span style={rowStyle.fileCount}>
              {entry.files.length === 1
                ? t('{0} file', entry.files.length)
                : t('{0} files', entry.files.length)}
            </span>
            <span style={rowStyle.date}>{formatDate(entry.createdAt, t)}</span>
          </span>
        </div>
        {hovered && (
          <div style={rowStyle.actions}>
            <button
              type="button"
              style={rowStyle.btn}
              title={t('Unshelve (apply and keep)')}
              onClick={(e) => {
                e.stopPropagation();
                onUnshelve(repoId, entry.id);
              }}
            >
              <Codicon name="desktop-download" />
            </button>
            <button
              type="button"
              style={{
                ...rowStyle.btn,
                color: 'var(--versiondock-danger, var(--vscode-errorForeground, #f48771))',
              }}
              title={t('Delete shelve')}
              onClick={(e) => {
                e.stopPropagation();
                onDrop(repoId, entry.id);
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
          {viewMode === 'tree' && treeNodes
            ? treeNodes.map((node) =>
                node.kind === 'dir' ? (
                  <TreeDirNode
                    key={node.path}
                    node={node}
                    depth={0}
                    repoId={repoId}
                    entry={entry}
                  expansion={expansion}
                  onManualExpansionChange={onManualExpansionChange}
                    onUnshelveFile={onUnshelveFile}
                    onOpenFileDiff={onOpenFileDiff}
                  />
                ) : (
                  <FileRow
                    key={node.file.path}
                    file={node.file}
                    repoId={repoId}
                    entry={entry}
                    depth={0}
                    onUnshelveFile={onUnshelveFile}
                    onOpenFileDiff={onOpenFileDiff}
                  />
                ),
              )
            : entry.files.map((f) => (
                <FileRow
                  key={f.path}
                  file={f}
                  repoId={repoId}
                  entry={entry}
                  onUnshelveFile={onUnshelveFile}
                  onOpenFileDiff={onOpenFileDiff}
                />
              ))}
        </div>
      )}

      {ctxMenu && (
        <div
          className="context-menu"
          style={{ position: 'fixed', left: ctxMenu.x, top: ctxMenu.y, zIndex: 1000 }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => {
              setCtxMenu(null);
              onUnshelve(repoId, entry.id);
            }}
          >
            <Codicon name="desktop-download" />
            {t('Unshelve')}
          </button>
          <button
            type="button"
            className="danger"
            onClick={() => {
              setCtxMenu(null);
              onDrop(repoId, entry.id);
            }}
          >
            <Codicon name="trash" />
            {t('Delete')}
          </button>
        </div>
      )}
    </div>
  );
}

const rowStyle = {
  root: {
    borderBottom: '1px solid var(--versiondock-border, var(--vscode-panel-border, #333))',
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
  info: { display: 'flex', flexDirection: 'column' as const, flex: 1, minWidth: 0 },
  name: {
    fontSize: '12px',
    minWidth: 0,
    overflow: 'hidden',
    whiteSpace: 'nowrap' as const,
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
  } as React.CSSProperties,
  message: {
    flex: '0 1 auto',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    fontWeight: 500,
  } as React.CSSProperties,
  meta: { display: 'flex', gap: '8px', marginTop: '2px' } as React.CSSProperties,
  fileCount: {
    fontSize: '10px',
    color: 'var(--versiondock-muted, var(--vscode-descriptionForeground, #888))',
  },
  date: {
    fontSize: '10px',
    color: 'var(--versiondock-muted, var(--vscode-descriptionForeground, #888))',
    whiteSpace: 'nowrap' as const,
  },
  actions: { display: 'flex', gap: '2px', flexShrink: 0 } as React.CSSProperties,
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
    borderTop: '1px solid var(--versiondock-border, var(--vscode-panel-border, #333))',
    background: 'var(--versiondock-surface-soft, var(--vscode-sideBar-background, rgba(0,0,0,0.15)))',
  } as React.CSSProperties,
};

// ── Public component ──────────────────────────────────────────────────────────

export function ShelfPanel({
  repos,
  viewMode = 'tree',
  expansion = { sequence: 0, expanded: false },
  onManualExpansionChange = () => undefined,
  onOpenFileDiff,
}: {
  repos: RepositoryStatus[];
  selectedPaths?: Map<string, string[]>;
  viewMode?: 'tree' | 'list';
  expansion?: ExpansionCommand;
  onManualExpansionChange?: () => void;
  onOpenFileDiff?: (repoId: string, shelfId: string, filePath: string) => void;
}) {
  const shelves = useAppStore((state) => state.shelves);
  const loadShelves = useAppStore((state) => state.loadShelves);
  const shelfOperation = useAppStore((state) => state.shelfOperation);
  const { t } = useI18n();

  useEffect(() => {
    for (const repo of repos) {
      void loadShelves(repo.meta.id);
    }
  }, [loadShelves, repos]);

  const handleUnshelve = async (repoId: string, shelveId: string) => {
    await shelfOperation(repoId, { type: 'apply', shelf_id: shelveId });
  };

  const handleUnshelveFile = async (
    repoId: string,
    shelveId: string,
    filePath: string,
  ) => {
    await shelfOperation(repoId, {
      type: 'apply',
      shelf_id: shelveId,
      paths: [filePath],
    });
  };

  const handleDrop = async (repoId: string, shelveId: string) => {
    const entry = (shelves[repoId] ?? []).find((s) => s.id === shelveId);
    const title = entry?.name ?? shelveId;
    if (await confirmDialog({ title: t('Drop shelf {0}?', title), message: title, danger: true })) {
      await shelfOperation(repoId, { type: 'drop', shelf_id: shelveId });
    }
  };

  return (
    <div style={css.root}>
      <div style={css.list}>
        {repos.map((repo) => {
          const repoShelves = shelves[repo.meta.id] ?? [];
          const projectColor = repo.meta.color || '#4aaa9a';
          const worktreeBranch = repo.meta.isWorktree ? repo.branch : undefined;
          return (
            <section key={repo.meta.id} style={css.repoSection}>
              {repos.length >= 1 && (
                <div style={css.repoHeader(projectColor)}>
                  <span style={css.dot(projectColor)} />
                  <span style={css.repoName}>{repo.meta.name}</span>
                  {worktreeBranch && (
                    <BranchRefBadge label={worktreeBranch} kind="worktree" color={branchColor(worktreeBranch)} />
                  )}
                </div>
              )}

              {repoShelves.length === 0 ? (
                <div style={css.empty}>
                  <Codicon name="archive" style={{ marginRight: '6px' }} />
                  {t('No shelved changes')}
                </div>
              ) : (
                repoShelves.map((entry) => (
                  <ShelfRow
                    key={entry.id}
                    entry={entry}
                    repoId={repo.meta.id}
                    viewMode={viewMode}
                    expansion={expansion}
                    onManualExpansionChange={onManualExpansionChange}
                    onUnshelve={handleUnshelve}
                    onUnshelveFile={handleUnshelveFile}
                    onOpenFileDiff={onOpenFileDiff}
                    onDrop={handleDrop}
                  />
                ))
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

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
  repoHeader: (color: string): React.CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '4px 8px',
    minHeight: '26px',
    background: `color-mix(in srgb, ${color} 18%, var(--versiondock-surface))`,
    borderBottom: '1px solid var(--versiondock-border, var(--vscode-panel-border, #333))',
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
