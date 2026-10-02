import { IconButton } from './IconButton';
import React, { useMemo, useState } from 'react';
import { useI18n } from '../i18n';
import { Codicon } from './Codicon';
import { FileIcon } from './FileIcon';

export interface SyncCommitFile {
  path: string;
  status: string;
  added?: number | null;
  removed?: number | null;
}

export type SyncFileViewMode = 'tree' | 'flat';

interface FileTreeDir {
  kind: 'dir';
  name: string;
  path: string;
  children: FileTreeNode[];
  fileCount: number;
}

interface FileTreeLeaf {
  kind: 'file';
  name: string;
  file: SyncCommitFile;
}

type FileTreeNode = FileTreeDir | FileTreeLeaf;

const TREE_BASE_PAD = 16;

const TREE_LEVEL_PAD = 18;

function formatFileCount(count: number, t: (key: string, ...args: Array<string | number>) => string): string {
  return count === 1 ? t('{0} file', count) : t('{0} files', count);
}

function normalizeStatus(status: string): string {
  const code = status.charAt(0).toUpperCase();
  if (code === 'A') return 'added';
  if (code === 'D') return 'deleted';
  if (code === 'R') return 'renamed';
  if (code === 'C') return 'copied';
  return 'modified';
}

function statusLetter(status: string): string {
  const code = status.charAt(0).toUpperCase();
  if (code === 'A' || code === 'D' || code === 'R' || code === 'C') return code;
  return 'M';
}

function statusColor(status: string): string {
  switch (normalizeStatus(status)) {
    case 'added':
    case 'copied':
      return 'var(--vscode-gitDecoration-addedResourceForeground, var(--versiondock-success))';
    case 'deleted':
      return 'var(--vscode-gitDecoration-deletedResourceForeground, var(--versiondock-danger))';
    case 'renamed':
      return 'var(--vscode-gitDecoration-renamedResourceForeground, #73c991)';
    default:
      return 'var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d)';
  }
}

function fileNameOf(path: string): string {
  return path.split('/').pop() ?? path;
}

function directoryOf(path: string): string {
  const parts = path.split('/');
  return parts.length > 1 ? parts.slice(0, -1).join('/') : '';
}

function sortNodes(nodes: FileTreeNode[]): void {
  nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const node of nodes) {
    if (node.kind === 'dir') sortNodes(node.children);
  }
}

function computeFileCount(node: FileTreeDir): number {
  let count = 0;
  for (const child of node.children) {
    count += child.kind === 'file' ? 1 : computeFileCount(child);
  }
  node.fileCount = count;
  return count;
}

function collapseSingleChildDirs(nodes: FileTreeNode[]): FileTreeNode[] {
  return nodes.map((node) => {
    if (node.kind === 'file') return node;
    const children = collapseSingleChildDirs(node.children);
    if (children.length === 1 && children[0].kind === 'dir') {
      const only = children[0];
      return {
        kind: 'dir',
        name: `${node.name}/${only.name}`,
        path: only.path,
        children: only.children,
        fileCount: only.fileCount,
      };
    }
    return { ...node, children };
  });
}

function buildFileTree(files: SyncCommitFile[]): FileTreeNode[] {
  const root: FileTreeDir = { kind: 'dir', name: '', path: '', children: [], fileCount: 0 };
  for (const file of files) {
    const parts = file.path.split('/').filter(Boolean);
    if (parts.length === 0) continue;
    let current = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i];
      const dirPath = parts.slice(0, i + 1).join('/');
      let child = current.children.find((node): node is FileTreeDir => node.kind === 'dir' && node.name === part);
      if (!child) {
        child = { kind: 'dir', name: part, path: dirPath, children: [], fileCount: 0 };
        current.children.push(child);
      }
      current = child;
    }
    current.children.push({ kind: 'file', name: parts[parts.length - 1], file });
  }
  sortNodes(root.children);
  computeFileCount(root);
  return collapseSingleChildDirs(root.children);
}

function collectDirectoryKeys(files: SyncCommitFile[]): string[] {
  const keys: string[] = [];
  const walk = (nodes: FileTreeNode[]) => {
    for (const node of nodes) {
      if (node.kind !== 'dir') continue;
      keys.push(node.path);
      walk(node.children);
    }
  };
  walk(buildFileTree(files));
  return keys;
}

function SyncFileRow({ file, depth, onOpenFile, potentialConflicts }: {
  file: SyncCommitFile;
  depth: number;
  onOpenFile: (file: SyncCommitFile) => void;
  potentialConflicts?: Set<string>;
}) {
  const [hovered, setHovered] = useState(false);
  const fileName = fileNameOf(file.path);
  const dir = directoryOf(file.path);
  const color = statusColor(file.status);
  const { t } = useI18n();
  const potentialConflict = potentialConflicts?.has(file.path);

  return (
    <div
      style={styles.fileRow(depth, hovered)}
      title={potentialConflict ? `${file.path} (${t('Potential conflict: this file has local uncommitted modifications')})` : file.path}
      onClick={() => onOpenFile(file)}
      onDoubleClick={() => onOpenFile(file)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <FileIcon name={fileName} />
      <div style={styles.fileNameGroup}>
        <span style={styles.fileName(color)}>{fileName}</span>
        {depth === 0 && dir && <span style={styles.dirPath}>{dir}</span>}
      </div>
      <div style={styles.fileStats}>
        {potentialConflict && <Codicon name="warning" style={{ color: 'var(--versiondock-warning)', fontSize: 12 }} />}
        {typeof file.added === 'number' || typeof file.removed === 'number' ? (
          <span style={styles.lineStats}>
            {typeof file.added === 'number' && <span style={styles.added}>+{file.added}</span>}
            {typeof file.removed === 'number' && <span style={styles.removed}>-{file.removed}</span>}
          </span>
        ) : null}
        <span style={styles.statusLetter(color)}>{statusLetter(file.status)}</span>
      </div>
    </div>
  );
}

function SyncFileTreeNode({ node, depth, collapsed, onToggle, onOpenFile, potentialConflicts }: {
  node: FileTreeNode;
  depth: number;
  collapsed: Record<string, boolean>;
  onToggle: (key: string) => void;
  onOpenFile: (file: SyncCommitFile) => void;
  potentialConflicts?: Set<string>;
}) {
  if (node.kind === 'file') {
    return <SyncFileRow file={node.file} depth={depth} onOpenFile={onOpenFile} potentialConflicts={potentialConflicts} />;
  }

  const open = !collapsed[node.path];
  return (
    <div>
      <div style={styles.dirRow(depth)} onClick={() => onToggle(node.path)} title={node.path}>
        <Codicon name={open ? 'chevron-down' : 'chevron-right'} style={styles.folderChevron} />
        <FileIcon name={node.name} folder open={open} />
        <span style={styles.folderName}>{node.name}</span>
        <span style={styles.fileCountBadge}>{node.fileCount}</span>
      </div>
      {open && node.children.map((child) => (
        <SyncFileTreeNode
          key={child.kind === 'dir' ? child.path : child.file.path}
          node={child}
          depth={depth + 1}
          collapsed={collapsed}
          onToggle={onToggle}
          onOpenFile={onOpenFile}
          potentialConflicts={potentialConflicts}
        />
      ))}
    </div>
  );
}

export function SyncFileList({ files, loading, viewMode, onViewModeChange, onOpenFile, description, query, showToolbar = true, potentialConflicts }: {
  files: SyncCommitFile[];
  loading: boolean;
  viewMode: SyncFileViewMode;
  onViewModeChange: (mode: SyncFileViewMode) => void;
  onOpenFile: (file: SyncCommitFile) => void;
  description?: string;
  query?: string;
  showToolbar?: boolean;
  potentialConflicts?: Set<string>;
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const visibleFiles = useMemo(() => {
    const needle = query?.trim().toLocaleLowerCase();
    return needle ? files.filter((file) => file.path.toLocaleLowerCase().includes(needle)) : files;
  }, [files, query]);
  const directoryKeys = useMemo(() => collectDirectoryKeys(visibleFiles), [visibleFiles]);
  const canToggleFolders = viewMode === 'tree' && directoryKeys.length > 0;
  const { t } = useI18n();

  const collapseAllFolders = () => {
    if (!canToggleFolders) return;
    setCollapsed(Object.fromEntries(directoryKeys.map((key) => [key, true])));
  };

  return (
    <div style={styles.fileListRoot}>
      {description && <div style={styles.fileListDescription}>{description}</div>}
      {showToolbar && <div style={styles.filesHeader}>
        <span style={styles.filesTitle}>{loading ? '' : formatFileCount(visibleFiles.length, t)}</span>
        <div style={styles.filesHeaderActions}>
          <div style={styles.expandBtns}>
            <IconButton
              data-action-btn=""
              type="button"
              style={styles.toolbarButton(false, !canToggleFolders)}
              title={t('Expand all')}
              disabled={!canToggleFolders}
              onClick={() => {
                if (!canToggleFolders) return;
                setCollapsed({});
              }}
            >
              <Codicon name="expand-all" style={{ fontSize: '13px' }} />
            </IconButton>
            <IconButton
              data-action-btn=""
              type="button"
              style={styles.toolbarButton(false, !canToggleFolders)}
              title={t('Collapse all')}
              disabled={!canToggleFolders}
              onClick={collapseAllFolders}
            >
              <Codicon name="collapse-all" style={{ fontSize: '13px' }} />
            </IconButton>
          </div>
          <div style={styles.viewToggle}>
            <IconButton
              data-action-btn=""
              type="button"
              style={styles.toolbarButton(viewMode === 'tree', false)}
              aria-pressed={viewMode === 'tree'}
              title={t('Tree view')}
              onClick={() => onViewModeChange('tree')}
            >
              <Codicon name="list-tree" style={{ fontSize: '13px' }} />
            </IconButton>
            <IconButton
              data-action-btn=""
              type="button"
              style={styles.toolbarButton(viewMode === 'flat', false)}
              aria-pressed={viewMode === 'flat'}
              title={t('Flat list')}
              onClick={() => onViewModeChange('flat')}
            >
              <Codicon name="list-flat" style={{ fontSize: '13px' }} />
            </IconButton>
          </div>
        </div>
      </div>}
      {loading ? (
        <div style={styles.loadingRow}>{t('Loading files...')}</div>
      ) : visibleFiles.length === 0 ? (
        <div style={styles.loadingRow}>{t('No changed files')}</div>
      ) : viewMode === 'tree' ? (
        <div style={styles.treeRoot}>
          {buildFileTree(visibleFiles).map((node) => (
            <SyncFileTreeNode
              key={node.kind === 'dir' ? node.path : node.file.path}
              node={node}
              depth={0}
              collapsed={query?.trim() ? {} : collapsed}
              onToggle={(key) => setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }))}
              onOpenFile={onOpenFile}
              potentialConflicts={potentialConflicts}
            />
          ))}
        </div>
      ) : (
        <div style={styles.treeRoot}>
          {visibleFiles.map((file) => (
            <SyncFileRow key={file.path} file={file} depth={0} onOpenFile={onOpenFile} potentialConflicts={potentialConflicts} />
          ))}
        </div>
      )}
    </div>
  );
}

const styles = {

  loadingRow: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: '8px 12px', fontSize: '12px', color: 'var(--vscode-descriptionForeground, var(--versiondock-muted))',
    textAlign: 'center' as const,
  } as React.CSSProperties,

  fileListRoot: {
    background: 'var(--vscode-sideBar-background, var(--versiondock-surface))',
  } as React.CSSProperties,

  fileListDescription: {
    padding: '8px 12px 6px',
    color: 'var(--vscode-descriptionForeground, var(--versiondock-muted))',
    fontSize: '11px',
  } as React.CSSProperties,

  filesHeader: {
    borderBottom: '1px solid var(--vscode-panel-border, var(--versiondock-border))',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '5px 10px 5px 16px',
    minHeight: 30,
    boxSizing: 'border-box',
  } as React.CSSProperties,

  filesTitle: {
    color: 'var(--vscode-descriptionForeground, var(--versiondock-muted))',
    fontSize: '11px',
    fontWeight: 500,
    minWidth: 54,
  } as React.CSSProperties,

  filesHeaderActions: {
    display: 'flex',
    alignItems: 'center',
    gap: '2px',
  } as React.CSSProperties,

  expandBtns: {
    display: 'flex',
    gap: '2px',
  } as React.CSSProperties,

  viewToggle: {
    display: 'flex',
    gap: '2px',
    marginLeft: '4px',
    paddingLeft: '4px',
    borderLeft: '1px solid var(--vscode-panel-border, var(--versiondock-border))',
  } as React.CSSProperties,

  toolbarButton: (active: boolean, disabled: boolean): React.CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '2px 4px',
    border: 'none',
    borderRadius: '3px',
    background: active ? 'var(--vscode-toolbar-activeBackground, var(--versiondock-selected))' : 'transparent',
    color: disabled
      ? 'var(--vscode-disabledForeground, var(--versiondock-faint))'
      : active ? 'var(--vscode-foreground, var(--versiondock-text))' : 'var(--vscode-descriptionForeground, var(--versiondock-muted))',
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.3 : 1,
  }),

  treeRoot: {
    padding: '2px 0',
  } as React.CSSProperties,

  dirRow: (depth: number): React.CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    minHeight: 24,
    padding: `0 8px 0 ${TREE_BASE_PAD + depth * TREE_LEVEL_PAD}px`,
    cursor: 'pointer',
    boxSizing: 'border-box',
    minWidth: 0,
    overflow: 'hidden',
  }),

  folderChevron: {
    fontSize: '12px',
    flexShrink: 0,
  } as React.CSSProperties,

  folderName: {
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    fontSize: '12px',
    color: 'var(--vscode-descriptionForeground, var(--versiondock-muted))',
  },

  fileCountBadge: {
    marginLeft: 'auto',
    fontSize: '10px',
    padding: '0 6px',
    borderRadius: '999px',
    background: 'var(--versiondock-badge-background, var(--versiondock-accent-bg))',
    color: 'var(--versiondock-badge-foreground, #ffffff)',
    flexShrink: 0,
  } as React.CSSProperties,

  fileRow: (depth: number, hovered: boolean): React.CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    minHeight: 24,
    padding: `0 8px 0 ${TREE_BASE_PAD + depth * TREE_LEVEL_PAD + 18}px`,
    cursor: 'pointer',
    boxSizing: 'border-box',
    background: hovered ? 'var(--vscode-list-hoverBackground, var(--versiondock-hover))' : undefined,
  }),

  fileNameGroup: {
    display: 'flex',
    alignItems: 'baseline',
    minWidth: 0,
    gap: '6px',
    flex: 1,
  } as React.CSSProperties,

  fileName: (color: string): React.CSSProperties => ({
    color,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '12px',
  }),

  dirPath: {
    color: 'var(--vscode-descriptionForeground, var(--versiondock-muted))',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    fontSize: '11px',
  } as React.CSSProperties,

  fileStats: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    marginLeft: 'auto',
    flexShrink: 0,
  } as React.CSSProperties,

  lineStats: {
    display: 'flex',
    gap: '4px',
    alignItems: 'center',
    fontSize: '10px',
    flexShrink: 0,
  } as React.CSSProperties,

  added: {
    color: 'var(--vscode-gitDecoration-addedResourceForeground, var(--versiondock-success))',
  } as React.CSSProperties,

  removed: {
    color: 'var(--vscode-gitDecoration-deletedResourceForeground, var(--versiondock-danger))',
  } as React.CSSProperties,

  statusLetter: (color: string): React.CSSProperties => ({
    color,
    fontSize: '11px',
    fontFamily: 'var(--vscode-editor-font-family, monospace)',
    fontWeight: 700,
    minWidth: 12,
    textAlign: 'center',
  }),
};
