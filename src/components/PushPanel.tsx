import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { RepositoryStatus, UnpushedCommit, BranchInfo, CommitDetail, CommitFile } from '../bindings/generated';
import { useI18n } from '../i18n';
import { capabilityAvailable, capabilityReason, isOperationActive, useAppStore } from '../store/appStore';
import { Codicon } from './Codicon';
import { BranchRefBadge } from './BranchRefBadge';
import { FileIcon } from './FileIcon';
import { branchColor, readableAccentColor } from './branchColor';
import { choiceDialog, confirmDialog, promptDialog } from './dialogService';
import { isBranchProtected } from '../history/branchProtection';
import { openUrl } from '@tauri-apps/plugin-opener';
import { buildPullRequestUrl } from '../history/prUrlHelper';

export interface PushCommitFile {
  path: string;
  status: string;
  added?: number | null;
  removed?: number | null;
}

type PushViewMode = 'commits' | 'changes';
type PushFileViewMode = 'tree' | 'flat';

const PUSH_COLOR = 'var(--versiondock-success, #81c784)';
const PULL_COLOR = 'var(--versiondock-info, #64b5f6)';

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
  file: PushCommitFile;
}

type FileTreeNode = FileTreeDir | FileTreeLeaf;

interface CommitCtxMenuState {
  x: number;
  y: number;
  repoId: string;
  selectedHashes: string[];
  commits: UnpushedCommit[];
  isHead: boolean;
  singleHash: string | null;
}

const TREE_BASE_PAD = 16;
const TREE_LEVEL_PAD = 18;

function baseNameFromPath(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.replace(/[\\/]+$/, '');
  if (!trimmed) return value;
  const parts = trimmed.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? trimmed;
}

function nativeCheckboxBorderStyle(): React.CSSProperties {
  return {
    borderRadius: '3px',
    boxShadow: 'inset 0 0 0 0px var(--vscode-checkbox-border, var(--vscode-focusBorder, var(--versiondock-accent)))',
  };
}

function formatDate(iso: string, t: (key: string, ...args: Array<string | number>) => string): string {
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
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: diffD > 365 ? 'numeric' : undefined });
  } catch {
    return iso;
  }
}

function formatFileCount(count: number, t: (key: string, ...args: Array<string | number>) => string): string {
  return count === 1 ? t('{0} file', count) : t('{0} files', count);
}

function splitCommitBody(body?: string): { bodyText: string; footerText: string } {
  const text = body?.trim() ?? '';
  if (!text) return { bodyText: '', footerText: '' };

  const lines = text.split(/\r?\n/);
  let splitIndex = lines.length;
  const footerPattern = /^(?:[A-Za-z][A-Za-z0-9-]*(?:-[A-Za-z0-9]+)*|BREAKING CHANGE):\s.+$/;

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line) {
      if (splitIndex < lines.length) break;
      continue;
    }
    if (footerPattern.test(line)) {
      splitIndex = i;
      continue;
    }
    break;
  }

  if (splitIndex === lines.length) return { bodyText: text, footerText: '' };
  return {
    bodyText: lines.slice(0, splitIndex).join('\n').trim(),
    footerText: lines.slice(splitIndex).join('\n').trim(),
  };
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

function buildFileTree(files: PushCommitFile[]): FileTreeNode[] {
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

function collectDirectoryKeys(files: PushCommitFile[]): string[] {
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

function mergeUniqueFiles(fileGroups: PushCommitFile[][]): PushCommitFile[] {
  const merged = new Map<string, PushCommitFile>();
  for (const files of fileGroups) {
    for (const file of files) {
      if (!merged.has(file.path)) merged.set(file.path, file);
    }
  }
  return [...merged.values()];
}

function findSourceCommitHash(commits: UnpushedCommit[], filesByHash: Record<string, PushCommitFile[]>, file: PushCommitFile): string | null {
  for (const commit of commits) {
    if ((filesByHash[commit.hash] ?? []).some((item) => item.path === file.path)) return commit.hash;
  }
  return null;
}

function MenuItem({ icon, label, danger, onClick }: { icon: string; label: string; danger?: boolean; onClick: () => void }) {
  return (
    <div
      style={{ ...ctxStyles.item, ...(danger ? { color: 'var(--vscode-errorForeground, var(--versiondock-danger))' } : {}) }}
      onMouseEnter={(event) => (event.currentTarget.style.background = 'var(--vscode-list-hoverBackground, var(--versiondock-hover))')}
      onMouseLeave={(event) => (event.currentTarget.style.background = 'transparent')}
      onClick={onClick}
    >
      <Codicon name={icon} style={{ fontSize: '13px' }} />
      {label}
    </div>
  );
}

function CommitContextMenu({
  state,
  onSquash,
  onDropCommits,
  onRevertCommits,
  onEditMsg,
  onUndo,
  onRevertSingle,
  onDropSingle,
  onViewInLog,
  onClose,
}: {
  state: CommitCtxMenuState;
  onSquash: () => void;
  onDropCommits: () => void;
  onRevertCommits: () => void;
  onEditMsg: () => void;
  onUndo: () => void;
  onRevertSingle: () => void;
  onDropSingle: () => void;
  onViewInLog: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const n = state.selectedHashes.length;
  const { t } = useI18n();

  useEffect(() => {
    const outsideHandler = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    const blurHandler = () => onClose();
    const visibilityHandler = () => {
      if (document.visibilityState !== 'visible') onClose();
    };
    document.addEventListener('mousedown', outsideHandler, true);
    document.addEventListener('visibilitychange', visibilityHandler);
    window.addEventListener('blur', blurHandler);
    window.addEventListener('pagehide', blurHandler);
    return () => {
      document.removeEventListener('mousedown', outsideHandler, true);
      document.removeEventListener('visibilitychange', visibilityHandler);
      window.removeEventListener('blur', blurHandler);
      window.removeEventListener('pagehide', blurHandler);
    };
  }, [onClose]);

  const [pos, setPos] = useState({ x: state.x, y: state.y });

  useLayoutEffect(() => {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) sel.removeAllRanges();
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const margin = 6;
    setPos({
      x: state.x + rect.width > vw - margin ? Math.max(margin, vw - rect.width - margin) : Math.max(margin, state.x),
      y: state.y + rect.height > vh - margin ? Math.max(margin, vh - rect.height - margin) : Math.max(margin, state.y),
    });
  }, [state.x, state.y]);

  const wrap = (fn: () => void) => () => {
    fn();
    onClose();
  };

  return createPortal(
    <div ref={ref} style={{ ...ctxStyles.menu, left: pos.x, top: pos.y, zIndex: 99999 }} onContextMenu={(event) => event.preventDefault()}>
      {n === 1 && (
        <>
          <MenuItem icon="go-to-file" label={t('View in Git Log')} onClick={wrap(onViewInLog)} />
          {state.isHead && <MenuItem icon="edit" label={t('Edit Commit Message…')} onClick={wrap(onEditMsg)} />}
          <MenuItem icon="discard" label={t('Revert Commit')} onClick={wrap(onRevertSingle)} />
          {state.isHead && (
            <>
              <div style={ctxStyles.separator} />
              <MenuItem icon="arrow-left" label={t('Undo Commit')} onClick={wrap(onUndo)} />
              <MenuItem icon="trash" label={t('Drop Commit')} danger onClick={wrap(onDropSingle)} />
            </>
          )}
        </>
      )}
      {n >= 2 && (
        <>
          <MenuItem icon="discard" label={t('Revert {0} commits', n)} onClick={wrap(onRevertCommits)} />
          <div style={ctxStyles.separator} />
          <MenuItem icon="trash" label={t('Drop {0} commits', n)} danger onClick={wrap(onDropCommits)} />
          <MenuItem icon="fold" label={t('Squash {0} commits…', n)} onClick={wrap(onSquash)} />
        </>
      )}
    </div>,
    document.body,
  );
}

function PushFileRow({ file, depth, onOpenFile }: {
  file: PushCommitFile;
  depth: number;
  onOpenFile: (file: PushCommitFile) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const fileName = fileNameOf(file.path);
  const dir = directoryOf(file.path);
  const color = statusColor(file.status);

  return (
    <div
      style={styles.fileRow(depth, hovered)}
      title={file.path}
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

function PushFileTreeNode({ node, depth, collapsed, onToggle, onOpenFile }: {
  node: FileTreeNode;
  depth: number;
  collapsed: Record<string, boolean>;
  onToggle: (key: string) => void;
  onOpenFile: (file: PushCommitFile) => void;
}) {
  if (node.kind === 'file') {
    return <PushFileRow file={node.file} depth={depth} onOpenFile={onOpenFile} />;
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
        <PushFileTreeNode
          key={child.kind === 'dir' ? child.path : child.file.path}
          node={child}
          depth={depth + 1}
          collapsed={collapsed}
          onToggle={onToggle}
          onOpenFile={onOpenFile}
        />
      ))}
    </div>
  );
}

function PushFileList({ files, loading, viewMode, onViewModeChange, onOpenFile, description }: {
  files: PushCommitFile[];
  loading: boolean;
  viewMode: PushFileViewMode;
  onViewModeChange: (mode: PushFileViewMode) => void;
  onOpenFile: (file: PushCommitFile) => void;
  description?: string;
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const directoryKeys = useMemo(() => collectDirectoryKeys(files), [files]);
  const canToggleFolders = viewMode === 'tree' && directoryKeys.length > 0;
  const { t } = useI18n();

  const collapseAllFolders = () => {
    if (!canToggleFolders) return;
    setCollapsed(Object.fromEntries(directoryKeys.map((key) => [key, true])));
  };

  return (
    <div style={styles.fileListRoot}>
      {description && <div style={styles.fileListDescription}>{description}</div>}
      <div style={styles.filesHeader}>
        <span style={styles.filesTitle}>{loading ? '' : formatFileCount(files.length, t)}</span>
        <div style={styles.filesHeaderActions}>
          <div style={styles.expandBtns}>
            <button
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
            </button>
            <button
              data-action-btn=""
              type="button"
              style={styles.toolbarButton(false, !canToggleFolders)}
              title={t('Collapse all')}
              disabled={!canToggleFolders}
              onClick={collapseAllFolders}
            >
              <Codicon name="collapse-all" style={{ fontSize: '13px' }} />
            </button>
          </div>
          <div style={styles.viewToggle}>
            <button
              data-action-btn=""
              type="button"
              style={styles.toolbarButton(viewMode === 'tree', false)}
              title={t('Tree view')}
              onClick={() => onViewModeChange('tree')}
            >
              <Codicon name="list-tree" style={{ fontSize: '13px' }} />
            </button>
            <button
              data-action-btn=""
              type="button"
              style={styles.toolbarButton(viewMode === 'flat', false)}
              title={t('Flat list')}
              onClick={() => onViewModeChange('flat')}
            >
              <Codicon name="list-flat" style={{ fontSize: '13px' }} />
            </button>
          </div>
        </div>
      </div>
      {loading ? (
        <div style={styles.loadingRow}>{t('Loading files...')}</div>
      ) : files.length === 0 ? (
        <div style={styles.loadingRow}>{t('No changed files')}</div>
      ) : viewMode === 'tree' ? (
        <div style={styles.treeRoot}>
          {buildFileTree(files).map((node) => (
            <PushFileTreeNode
              key={node.kind === 'dir' ? node.path : node.file.path}
              node={node}
              depth={0}
              collapsed={collapsed}
              onToggle={(key) => setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }))}
              onOpenFile={onOpenFile}
            />
          ))}
        </div>
      ) : (
        <div style={styles.treeRoot}>
          {files.map((file) => (
            <PushFileRow key={file.path} file={file} depth={0} onOpenFile={onOpenFile} />
          ))}
        </div>
      )}
    </div>
  );
}

function AggregatedChangesView({ commits, filesByHash, files, loading, fileViewMode, onFileViewModeChange, onOpenCommitFile }: {
  commits: UnpushedCommit[];
  filesByHash: Record<string, PushCommitFile[]>;
  files: PushCommitFile[];
  loading: boolean;
  fileViewMode: PushFileViewMode;
  onFileViewModeChange: (mode: PushFileViewMode) => void;
  onOpenCommitFile: (hash: string, file: PushCommitFile) => void;
}) {
  const { t } = useI18n();
  return (
    <PushFileList
      files={files}
      loading={loading}
      viewMode={fileViewMode}
      description={t('Aggregated changes from all commits to push')}
      onViewModeChange={onFileViewModeChange}
      onOpenFile={(file) => {
        const hash = findSourceCommitHash(commits, filesByHash, file);
        if (hash) onOpenCommitFile(hash, file);
      }}
    />
  );
}

function CommitRow({
  commit,
  repoId,
  isHead,
  expanded,
  selected,
  files,
  loadingFiles,
  fileViewMode,
  onToggle,
  onSelect,
  onContextMenu,
  onFileViewModeChange,
  onOpenFile,
  onOpenInLog,
  onUndoCommit,
}: {
  commit: UnpushedCommit;
  repoId: string;
  isHead: boolean;
  expanded: boolean;
  selected: boolean;
  files: PushCommitFile[];
  loadingFiles: boolean;
  fileViewMode: PushFileViewMode;
  onToggle: () => void;
  onSelect: (event: React.MouseEvent) => void;
  onContextMenu: (event: React.MouseEvent) => void;
  onFileViewModeChange: (mode: PushFileViewMode) => void;
  onOpenFile: (file: PushCommitFile) => void;
  onOpenInLog: (hash: string, repoId: string) => void;
  onUndoCommit: (repoId: string) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const { t } = useI18n();
  const { bodyText, footerText } = splitCommitBody((commit as { body?: string }).body);
  const hasBody = bodyText.length > 0 || footerText.length > 0;
  let background = 'transparent';
  if (selected) background = 'var(--vscode-list-inactiveSelectionBackground, var(--versiondock-selected))';
  else if (hovered) background = 'var(--vscode-list-hoverBackground, var(--versiondock-hover))';

  const handleRowClick = (event: React.MouseEvent) => {
    if (event.ctrlKey || event.metaKey) {
      onSelect(event);
      return;
    }
    onToggle();
  };

  return (
    <div style={styles.commitCard(expanded, selected)}>
      <div
        data-commit-row="true"
        role="button"
        tabIndex={0}
        style={{ ...styles.commitRow, background }}
        onClick={handleRowClick}
        onContextMenu={onContextMenu}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onToggle();
          }
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <span style={styles.commitHash}>{commit.shortHash}</span>
        <span style={styles.commitMessage} title={hasBody ? `${commit.message}\n\n${(commit as { body?: string }).body}` : commit.message}>
          {commit.message}
        </span>
        <span style={styles.commitMeta}>
          {commit.author} · {formatDate(commit.date, t)}
          {commit.filesChanged != null && (
            <span style={styles.commitStats}>
              &nbsp;·&nbsp;{formatFileCount(commit.filesChanged, t)}
              {commit.additions != null && commit.additions > 0 && <span style={styles.statAdd}>&nbsp;+{commit.additions}</span>}
              {commit.deletions != null && commit.deletions > 0 && <span style={styles.statDel}>&nbsp;-{commit.deletions}</span>}
            </span>
          )}
        </span>
        <div style={styles.commitActions(hovered || expanded || selected)}>
          {isHead && (
            <button
              data-action-btn=""
              style={styles.actionBtn}
              title={t('Undo this commit (keeps changes as unstaged)')}
              onClick={(event) => {
                event.stopPropagation();
                onUndoCommit(repoId);
              }}
            >
              <Codicon name="arrow-left" style={{ fontSize: '16px' }} />
            </button>
          )}
          <button
            data-action-btn=""
            style={styles.actionBtn}
            title={t('Open in Log')}
            onClick={(event) => {
              event.stopPropagation();
              onOpenInLog(commit.hash, repoId);
            }}
          >
            <Codicon name="go-to-file" style={{ fontSize: '16px' }} />
          </button>
        </div>
      </div>

      {expanded && (
        <div style={styles.commitDetails}>
          {hasBody && (
            <div style={styles.messagePanel}>
              <div style={styles.bodyBlock}>
                {bodyText && <div style={styles.bodyText}>{bodyText}</div>}
                {footerText && <pre style={styles.footerText(bodyText.length > 0)}>{footerText}</pre>}
              </div>
            </div>
          )}
          <PushFileList
            files={files}
            loading={loadingFiles}
            viewMode={fileViewMode}
            onViewModeChange={onFileViewModeChange}
            onOpenFile={onOpenFile}
          />
        </div>
      )}
    </div>
  );
}

function RepoSection({
  repo,
  branch,
  commits,
  checked,
  canCheck,
  onToggle,
  onOpenInLog,
  onUndoCommit,
  onRequestCommitFiles,
  onOpenCommitFile,
  singleRepo,
}: {
  repo: RepositoryStatus;
  branch?: BranchInfo;
  commits: UnpushedCommit[];
  checked: boolean;
  canCheck: boolean;
  onToggle: (repoId: string) => void;
  onOpenInLog: (hash: string, repoId: string) => void;
  onUndoCommit: (repoId: string) => void;
  onRequestCommitFiles: (repoId: string, hash: string) => Promise<PushCommitFile[]>;
  onOpenCommitFile: (repoId: string, hash: string, file: PushCommitFile) => void;
  singleRepo?: boolean;
}) {
  const [expanded, setExpanded] = useState(true);
  const [pushViewMode, setPushViewMode] = useState<PushViewMode>('commits');
  const [fileViewMode, setFileViewMode] = useState<PushFileViewMode>('tree');
  const [expandedCommitHash, setExpandedCommitHash] = useState<string | null>(null);
  const [filesByHash, setFilesByHash] = useState<Record<string, PushCommitFile[]>>({});
  const [multiSelectHashes, setMultiSelectHashes] = useState<Set<string>>(new Set());
  const [ctxMenu, setCtxMenu] = useState<CommitCtxMenuState | null>(null);
  const [hovered, setHovered] = useState(false);
  const { t } = useI18n();
  const unpushedOperation = useAppStore((state) => state.unpushedOperation);

  const rawName = repo.meta.name ?? baseNameFromPath(repo.meta.id) ?? repo.meta.id;
  const repoName = rawName;
  const branchLabel = branch?.detachedTag ?? branch?.detachedHash ?? branch?.name ?? repo.branch;
  const branchClr = branchColor(branchLabel, false, Boolean(branch?.detachedTag));
  const repoColor = readableAccentColor(repo.meta.color ?? '#4ec9b0');
  const ahead = branch?.ahead ?? repo.ahead;
  const behind = branch?.behind ?? repo.behind;
  const hasUpstream = Boolean(branch?.upstream);
  const commitCount = hasUpstream ? ahead : commits.length;

  const selectedCommitFiles = expandedCommitHash ? (filesByHash[expandedCommitHash] ?? []) : [];
  const canTogglePushView = commits.length > 0;
  const branchTitle = branch?.detachedTag
    ? t('Tag: {0} (detached HEAD)', branch.detachedTag)
    : branch?.detachedHash
      ? t('Detached HEAD at {0}', branch.detachedHash)
      : branchLabel;

  useEffect(() => {
    let active = true;
    if (!expandedCommitHash || filesByHash[expandedCommitHash]) return;

    void onRequestCommitFiles(repo.meta.id, expandedCommitHash).then((files) => {
      if (active) {
        setFilesByHash((prev) => ({ ...prev, [expandedCommitHash]: files }));
      }
    });

    return () => {
      active = false;
    };
  }, [expandedCommitHash, filesByHash, onRequestCommitFiles, repo.meta.id]);

  useEffect(() => {
    let active = true;
    if (pushViewMode !== 'changes' || commits.length === 0) return;

    const missing = commits.filter((c) => !filesByHash[c.hash]);
    if (missing.length === 0) return;

    void Promise.all(missing.map((c) => onRequestCommitFiles(repo.meta.id, c.hash))).then((groups) => {
      if (active) {
        const fetched = Object.fromEntries(missing.map((c, i) => [c.hash, groups[i] ?? []]));
        setFilesByHash((prev) => ({ ...prev, ...fetched }));
      }
    });

    return () => {
      active = false;
    };
  }, [commits, filesByHash, onRequestCommitFiles, pushViewMode, repo.meta.id]);

  const aggregatedFiles = useMemo(() => {
    if (pushViewMode !== 'changes') return [];
    const cachedGroups = commits.map((c) => filesByHash[c.hash]).filter((f): f is PushCommitFile[] => Array.isArray(f));
    return mergeUniqueFiles(cachedGroups);
  }, [commits, filesByHash, pushViewMode]);

  const toggleCommitSelection = (hash: string) => {
    setMultiSelectHashes((prev) => {
      const next = new Set(prev);
      if (next.has(hash)) next.delete(hash);
      else next.add(hash);
      return next;
    });
  };

  const handleCommitContextMenu = (event: React.MouseEvent, commit: UnpushedCommit, isHead: boolean) => {
    event.preventDefault();
    event.stopPropagation();
    window.getSelection()?.removeAllRanges();
    let selectedHashes: Set<string>;
    if (multiSelectHashes.has(commit.hash) && multiSelectHashes.size > 1) {
      selectedHashes = multiSelectHashes;
    } else {
      selectedHashes = new Set([commit.hash]);
      setMultiSelectHashes(selectedHashes);
    }
    const isSingle = selectedHashes.size === 1;
    setCtxMenu({
      x: event.clientX,
      y: event.clientY,
      repoId: repo.meta.id,
      selectedHashes: Array.from(selectedHashes),
      commits,
      isHead: isSingle && isHead,
      singleHash: isSingle ? commit.hash : null,
    });
  };

  const handleBodyClick = (event: React.MouseEvent) => {
    if (!(event.target as HTMLElement).closest('[data-commit-row]')) {
      setMultiSelectHashes(new Set());
    }
  };
  const operate = async (operation: Parameters<typeof unpushedOperation>[1]) => {
    await unpushedOperation(repo.meta.id, operation);
    setMultiSelectHashes(new Set());
  };
  const confirmRewrite = async (title: string, hashes: string[], action: () => Promise<void>) => {
    const selectedCommits = commits.filter((commit) => hashes.includes(commit.hash));
    const message = `${selectedCommits.map((commit) => `${commit.shortHash} ${commit.message}`).join('\n')}\n\n${t('History rewriting requires a clean working tree and can require a force push.')}`;
    if (await confirmDialog({ title, message, danger: true })) await action();
  };

  return (
    <div style={styles.repoRoot}>
      <div
        style={styles.repoHeader(repoColor)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        {!singleRepo && (
          <input
            type="checkbox"
            checked={checked}
            disabled={!canCheck}
            onChange={() => onToggle(repo.meta.id)}
            onClick={(event) => event.stopPropagation()}
            style={{ ...styles.checkbox, ...nativeCheckboxBorderStyle(), opacity: canCheck ? 1 : 0.35, cursor: canCheck ? 'pointer' : 'default' }}
            title={!canCheck ? t('Nothing to push') : checked ? t('Exclude from push') : t('Include in push')}
          />
        )}
        <div style={styles.headerMain} onClick={() => setExpanded((value) => !value)}>
          <Codicon name={expanded ? 'chevron-down' : 'chevron-right'} style={{ fontSize: '11px', flexShrink: 0 }} />
          <span style={styles.dot(repoColor)} />
          <span style={styles.repoName}>{repoName}</span>
          <BranchRefBadge
            label={branchLabel}
            kind={repo.meta.isWorktree ? 'worktree' : branch?.detachedTag ? 'tag' : branch?.detachedHash ? 'head' : 'branch'}
            color={branchClr}
            title={branchTitle}
            style={{ marginLeft: 4 }}
          />
          {(commitCount > 0 || canTogglePushView || behind > 0 || !hasUpstream) && (
            <div style={styles.repoRightGroup}>
              <button
                type="button"
                data-action-btn=""
                style={styles.repoModeButton(!canTogglePushView, hovered)}
                disabled={!canTogglePushView}
                title={pushViewMode === 'commits' ? t('Show aggregated changes') : t('Show commit list')}
                onClick={(event) => {
                  event.stopPropagation();
                  if (!canTogglePushView) return;
                  setPushViewMode((value) => (value === 'commits' ? 'changes' : 'commits'));
                  setExpanded(true);
                }}
              >
                <Codicon name={pushViewMode === 'commits' ? 'diff-multiple' : 'list-unordered'} />
              </button>
              {commitCount > 0 ? (
                <span style={styles.directionBadge(PUSH_COLOR)}>
                  <Codicon name="arrow-up" style={{ fontSize: '10px', marginRight: '2px' }} />
                  {commitCount}
                </span>
              ) : behind > 0 ? (
                <span style={styles.directionBadge(PULL_COLOR)}>
                  <Codicon name="arrow-down" style={{ fontSize: '10px', marginRight: '2px' }} />
                  {behind}
                </span>
              ) : !hasUpstream ? (
                <span style={styles.publishBadge}>
                  <Codicon name="cloud-upload" style={{ fontSize: '10px', marginRight: '3px' }} />
                  {t('Unpublished')}
                </span>
              ) : null}
            </div>
          )}
        </div>
      </div>

      {expanded && (
        <div style={styles.repoBody} onClick={handleBodyClick}>
          {hasUpstream && ahead === 0 && behind === 0 ? (
            <div style={styles.upToDate}>
              <Codicon name="check" style={{ marginRight: '6px' }} />
              {t('Up to date')}
            </div>
          ) : hasUpstream && ahead === 0 && behind > 0 ? (
            <div style={styles.behindRow}>
              <Codicon name="arrow-down" style={{ marginRight: '6px', flexShrink: 0 }} />
              <span>{t('{0} commits to pull from {1}', behind, branch?.upstream ?? '')}</span>
            </div>
          ) : commits.length > 0 ? (
            pushViewMode === 'changes' ? (
              <AggregatedChangesView
                commits={commits}
                filesByHash={filesByHash}
                files={aggregatedFiles}
                loading={false}
                fileViewMode={fileViewMode}
                onFileViewModeChange={setFileViewMode}
                onOpenCommitFile={(hash, file) => onOpenCommitFile(repo.meta.id, hash, file)}
              />
            ) : (
              <div style={styles.commitList}>
                {commits.map((commit, index) => (
                  <CommitRow
                    key={commit.hash}
                    commit={commit}
                    repoId={repo.meta.id}
                    isHead={index === 0}
                    expanded={commit.hash === expandedCommitHash}
                    selected={multiSelectHashes.has(commit.hash)}
                    files={commit.hash === expandedCommitHash ? selectedCommitFiles : []}
                    loadingFiles={false}
                    fileViewMode={fileViewMode}
                    onToggle={() => {
                      setMultiSelectHashes(new Set());
                      setExpandedCommitHash((current) => (current === commit.hash ? null : commit.hash));
                    }}
                    onSelect={() => toggleCommitSelection(commit.hash)}
                    onContextMenu={(event) => handleCommitContextMenu(event, commit, index === 0)}
                    onFileViewModeChange={setFileViewMode}
                    onOpenFile={(file) => onOpenCommitFile(repo.meta.id, commit.hash, file)}
                    onOpenInLog={onOpenInLog}
                    onUndoCommit={onUndoCommit}
                  />
                ))}
              </div>
            )
          ) : !hasUpstream ? (
            <div style={styles.unpublishedRow}>
              <Codicon name="cloud-upload" style={{ marginRight: '6px', flexShrink: 0 }} />
              <span>{t('Local branch — not published to any remote yet')}</span>
            </div>
          ) : (
            <div style={styles.loadingRow}>{t('No commits found')}</div>
          )}
        </div>
      )}

      {ctxMenu && (
        <CommitContextMenu
          state={ctxMenu}
          onSquash={() => { const hashes = ctxMenu.selectedHashes; const initial = commits.filter((commit) => hashes.includes(commit.hash)).map((commit) => commit.message).reverse().join('\n\n'); void promptDialog({ title: t('Squash {0} commits…', hashes.length), message: t('The selection must be contiguous and include HEAD.'), inputLabel: t('Combined commit message'), initialValue: initial }).then((message) => { if (message) return confirmRewrite(t('Squash commits?'), hashes, () => operate({ type: 'squash', hashes, message })); }); }}
          onDropCommits={() => { const hashes = ctxMenu.selectedHashes; void confirmRewrite(t('Drop {0} commits?', hashes.length), hashes, () => operate({ type: 'drop', hashes })); }}
          onRevertCommits={() => { const hashes = ctxMenu.selectedHashes; void confirmRewrite(t('Revert {0} commits?', hashes.length), hashes, () => operate({ type: 'revert', hashes })); }}
          onEditMsg={() => { const commit = commits.find((item) => item.hash === ctxMenu.singleHash); if (commit) void promptDialog({ title: t('Edit Commit Message…'), message: commit.shortHash, inputLabel: t('Commit message'), initialValue: commit.message }).then((message) => { if (message) return operate({ type: 'editMessage', hash: commit.hash, message }); }); }}
          onUndo={() => { void confirmRewrite(t('Undo HEAD commit?'), ctxMenu.selectedHashes, () => operate({ type: 'undoHead' })); }}
          onRevertSingle={() => { const hashes = ctxMenu.selectedHashes; void confirmRewrite(t('Revert commit?'), hashes, () => operate({ type: 'revert', hashes })); }}
          onDropSingle={() => { const hashes = ctxMenu.selectedHashes; void confirmRewrite(t('Drop commit?'), hashes, () => operate({ type: 'drop', hashes })); }}
          onViewInLog={() => {
            if (ctxMenu.singleHash) onOpenInLog(ctxMenu.singleHash, repo.meta.id);
          }}
          onClose={() => {
            setCtxMenu(null);
            setMultiSelectHashes(new Set());
          }}
        />
      )}
    </div>
  );
}

export function PushPanel({ repos }: { repos: RepositoryStatus[] }) {
  const unpushedMap = useAppStore((state) => state.unpushedCommits);
  const branchesByRepo = useAppStore((state) => state.branchesByRepo);
  const loadUnpushedCommits = useAppStore((state) => state.loadUnpushedCommits);
  const sync = useAppStore((state) => state.sync);
  const openDiff = useAppStore((state) => state.openDiff);
  const operations = useAppStore((state) => state.operations);
  const workspaceId = useAppStore((state) => state.snapshot?.workspace.id);
  const isRepoBusy = (repoId: string) => isOperationActive(operations, {
    workspaceId,
    repositoryId: repoId,
    domain: 'sync',
  });
  const { t } = useI18n();
  const [checked, setChecked] = useState<Set<string>>(() => new Set<string>());
  const [pushButtonHovered, setPushButtonHovered] = useState(false);
  const [pushButtonPressed, setPushButtonPressed] = useState(false);

  const pushButtonFeedback = {
    onPointerEnter: () => setPushButtonHovered(true),
    onPointerLeave: () => { setPushButtonHovered(false); setPushButtonPressed(false); },
    onPointerDown: () => setPushButtonPressed(true),
    onPointerUp: () => setPushButtonPressed(false),
    onPointerCancel: () => setPushButtonPressed(false),
    onBlur: () => { setPushButtonHovered(false); setPushButtonPressed(false); },
  };

  useEffect(() => {
    void loadUnpushedCommits();
  }, [loadUnpushedCommits]);

  const canPushRepo = (repo: RepositoryStatus) => {
    if (!capabilityAvailable(repo.capabilities, 'syncPush', true)) return false;
    const branch = branchesByRepo[repo.meta.id]?.find((item) => item.current);
    const ahead = branch?.ahead ?? repo.ahead;
    const hasUpstream = Boolean(branch?.upstream);
    const commitCount = (unpushedMap[repo.meta.id]?.length ?? 0) || ahead;
    return (hasUpstream && ahead > 0) || (!hasUpstream && commitCount > 0) || !hasUpstream;
  };

  const toggleRepo = (repoId: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(repoId)) next.delete(repoId);
      else next.add(repoId);
      return next;
    });
  };

  const pushButtonLabel = (targets: RepositoryStatus[]) => {
    const hasPublish = targets.some((repo) => {
      const branch = branchesByRepo[repo.meta.id]?.find((item) => item.current);
      return !branch?.upstream;
    });
    const hasPush = targets.some((repo) => {
      const branch = branchesByRepo[repo.meta.id]?.find((item) => item.current);
      return Boolean(branch?.upstream);
    });
    const publishCount = targets.filter((repo) => {
      const branch = branchesByRepo[repo.meta.id]?.find((item) => item.current);
      return !branch?.upstream;
    }).length;

    if (hasPublish && hasPush) return publishCount === 1 ? t('Push & Publish Branch') : t('Push & Publish Branches');
    if (hasPublish) return targets.length === 1 ? t('Publish Branch') : t('Publish Branches');
    return t('Push');
  };

  const handleOpenInLog = (hash: string, repoId: string) => {
    const store = useAppStore.getState();
    void store.selectRepo(repoId);
    store.backToHistory();
    store.setHistoryFilter(hash);
  };

  const handleUndoCommit = async (repoId: string) => {
    const repo = repos.find((candidate) => candidate.meta.id === repoId);
    const head = unpushedMap[repoId]?.[0];
    if (!repo || !head) return;
    const confirmed = await confirmDialog({
      title: t('Undo Commit'),
      message: `${head.shortHash} ${head.message}\n\n${t('The commit will be removed from history. Its file changes will remain staged.')}`,
      danger: true,
    });
    if (!confirmed) return;
    await useAppStore.getState().unpushedOperation(repoId, { type: 'undoHead' });
  };

  const requestCommitFiles = async (repoId: string, hash: string): Promise<PushCommitFile[]> => {
    try {
      const workspaceId = useAppStore.getState().snapshot?.workspace.id ?? '';
      const bridge = useAppStore.getState().bridge;
      if (!bridge) return [];
      const detail = await bridge.request<CommitDetail>({
        type: 'commitDetail',
        payload: {
          workspace_id: workspaceId,
          repo_id: repoId,
          revision: hash,
        },
      });
      return (detail.files ?? []).map((file: CommitFile) => ({
        path: file.path,
        status: file.status,
        added: file.added,
        removed: file.removed,
      }));
    } catch {
      return [];
    }
  };

  const handleOpenCommitFile = (repoId: string, hash: string, file: PushCommitFile) => {
    void openDiff(repoId, file.path, false, hash);
  };

  const handlePush = async (targets: RepositoryStatus[], force = false) => {
    if (targets.length === 0 || targets.some((repo) => isRepoBusy(repo.meta.id))) return;

    for (const repo of targets) {
      const branch = branchesByRepo[repo.meta.id]?.find((item) => item.current);
      const branchName = branch?.name || 'HEAD';
      if (isBranchProtected(branchName)) {
        if (force) {
          const confirmed = await confirmDialog({
            title: t('Protected Branch Force Push'),
            message: t('VersionDock [{0}]: You are about to Force Push to protected branch "{1}"! This may permanently overwrite remote commits. Are you sure you want to proceed?', repo.meta.name, branchName),
            confirmLabel: t('Force Push Anyway'),
            danger: true,
          });
          if (!confirmed) return;
        } else {
          const showPushDialog = useAppStore.getState().bootstrap?.state.settings?.showPushDialogForProtectedBranches ?? true;
          if (showPushDialog) {
            const confirmed = await confirmDialog({
              title: t('Push to Protected Branch'),
              message: t('VersionDock [{0}]: You are pushing to protected branch "{1}". Do you want to proceed?', repo.meta.name, branchName),
              confirmLabel: t('Push'),
            });
            if (!confirmed) return;
          }
        }
      }
    }

    for (const repo of targets) {
      let pushSuccess = false;
      const branch = branchesByRepo[repo.meta.id]?.find((item) => item.current);
      const branchName = branch?.name || 'HEAD';
      try {
        await sync(repo.meta.id, 'push', true, { force });
        pushSuccess = true;
      } catch (error: unknown) {
        const errStr = String(error);
        const isRejected = errStr.includes('[rejected]') || errStr.includes('non-fast-forward') || errStr.includes('fetch first');
        if (isRejected) {
          const onPushRejectedSetting = useAppStore.getState().bootstrap?.state.settings?.onPushRejected ?? 'prompt';
          if (onPushRejectedSetting === 'rebaseAndRetry') {
            await sync(repo.meta.id, 'pullRebase');
            await sync(repo.meta.id, 'push');
          } else if (onPushRejectedSetting === 'error') {
            throw error;
          } else {
            const choice = await choiceDialog({
              title: t('Push Rejected'),
              message: t('VersionDock [{0}]: Push was rejected because the remote contains work that you do not have locally.', repo.meta.name),
              choices: [
                { id: 'rebase', label: t('Rebase & Push'), icon: 'repo-forked' },
                { id: 'merge', label: t('Merge & Push'), icon: 'git-merge' },
                { id: 'force', label: t('Force Push'), icon: 'alert' },
              ],
            });
            if (choice === 'rebase') {
              await sync(repo.meta.id, 'pullRebase');
              await sync(repo.meta.id, 'push');
            } else if (choice === 'merge') {
              await sync(repo.meta.id, 'pull');
              await sync(repo.meta.id, 'push');
            } else if (choice === 'force') {
              await handlePush([repo], true);
            }
          }
        } else {
          throw error;
        }
      }
      if (pushSuccess && targets.length === 1 && branchName !== 'HEAD') {
        const remotesList = useAppStore.getState().remotes[repo.meta.id] ?? [];
        const matchingRemote = remotesList[0];
        const remoteUrl = matchingRemote?.pushUrl || matchingRemote?.fetchUrl || '';
        const prInfo = remoteUrl ? buildPullRequestUrl(remoteUrl, branchName) : undefined;
        if (prInfo) {
          void choiceDialog({
            title: t('Branch Pushed'),
            message: t('VersionDock: Branch "{0}" pushed to {1}.', branchName, prInfo.platform),
            choices: [
              { id: 'create-pr', label: t('Create Pull Request'), icon: 'link-external' },
              { id: 'dismiss', label: t('Dismiss'), icon: 'close' },
            ],
          }).then((choice) => {
            if (choice === 'create-pr') {
              void openUrl(prInfo.url);
            }
          });
        }
      }
    }
    await loadUnpushedCommits();
  };

  if (!repos.length) {
    return (
      <div style={css.root}>
        <div style={styles.loadingRow}>
          <Codicon name="cloud-upload" style={{ marginRight: '6px' }} />
          {t('No Git repositories')}
        </div>
      </div>
    );
  }

  const isSingleRepo = repos.length === 1;

  if (isSingleRepo) {
    const solo = repos[0];
    const canPush = canPushRepo(solo);
    const soloBusy = isRepoBusy(solo.meta.id);
    const pushReason = capabilityReason(solo.capabilities, 'syncPush');
    const branch = branchesByRepo[solo.meta.id]?.find((item) => item.current);
    return (
      <div style={css.root}>
        <div style={css.list}>
          <RepoSection
            key={solo.meta.id}
            repo={solo}
            branch={branch}
            commits={unpushedMap[solo.meta.id] ?? []}
            checked={false}
            canCheck={false}
            onToggle={toggleRepo}
            onOpenInLog={handleOpenInLog}
            onUndoCommit={handleUndoCommit}
            onRequestCommitFiles={requestCommitFiles}
            onOpenCommitFile={handleOpenCommitFile}
            singleRepo
          />
        </div>
        <div style={css.footer}>
          <button data-primary-action-btn="" title={!canPush ? pushReason : undefined} style={css.pushBtn(canPush && !soloBusy, pushButtonHovered, pushButtonPressed)} disabled={!canPush || soloBusy} onClick={() => void handlePush([solo])} {...pushButtonFeedback}>
            <Codicon name="cloud-upload" style={{ marginRight: '6px' }} />
            {pushButtonLabel([solo])}
          </button>
        </div>
      </div>
    );
  }

  const checkedRepos = repos.filter((repo) => checked.has(repo.meta.id) && canPushRepo(repo));
  const pushableChecked = checkedRepos;
  const canPush = pushableChecked.length > 0;
  const batchBusy = pushableChecked.some((repo) => isRepoBusy(repo.meta.id));
  const batchPushReason = checkedRepos.length === 0
    ? repos.map((repo) => capabilityReason(repo.capabilities, 'syncPush')).find(Boolean)
    : undefined;

  return (
    <div style={css.root}>
      <div style={css.list}>
        {repos.map((repo) => (
          <RepoSection
            key={repo.meta.id}
            repo={repo}
            branch={branchesByRepo[repo.meta.id]?.find((item) => item.current)}
            commits={unpushedMap[repo.meta.id] ?? []}
            checked={checked.has(repo.meta.id)}
            canCheck={canPushRepo(repo)}
            onToggle={toggleRepo}
            onOpenInLog={handleOpenInLog}
            onUndoCommit={handleUndoCommit}
            onRequestCommitFiles={requestCommitFiles}
            onOpenCommitFile={handleOpenCommitFile}
          />
        ))}
      </div>

      <div style={css.footer}>
        {checkedRepos.length > 0 && (
          <div style={css.pills}>
            {checkedRepos.map((repo) => {
              const color = readableAccentColor(repo.meta.color ?? '#4ec9b0');
              const displayName = repo.meta.name ?? repo.meta.id;
              const branch = branchesByRepo[repo.meta.id]?.find((item) => item.current);
              const ahead = branch?.ahead ?? repo.ahead;
              return (
                <span key={repo.meta.id} style={css.pill(color)}>
                  <button data-action-btn="" style={css.pillRemove(color)} title={t('Remove {0}', displayName)} onClick={() => toggleRepo(repo.meta.id)}>
                    <Codicon name="close" style={{ fontSize: '10px' }} />
                  </button>
                  {displayName}
                  {ahead > 0 && (
                    <span style={css.pillCount}>
                      <Codicon name="arrow-up" style={{ fontSize: '8px', marginRight: '1px' }} />
                      {ahead}
                    </span>
                  )}
                </span>
              );
            })}
          </div>
        )}
        <button data-primary-action-btn="" title={!canPush ? batchPushReason : undefined} style={css.pushBtn(canPush && !batchBusy, pushButtonHovered, pushButtonPressed)} disabled={!canPush || batchBusy} onClick={() => void handlePush(pushableChecked)} {...pushButtonFeedback}>
          <Codicon name="cloud-upload" style={{ marginRight: '6px' }} />
          {pushButtonLabel(pushableChecked)}
        </button>
      </div>
    </div>
  );
}

const ctxStyles = {
  menu: {
    position: 'fixed' as const,
    zIndex: 9999,
    background: 'var(--vscode-menu-background, var(--versiondock-surface-alt))',
    border: '1px solid var(--vscode-menu-border, var(--versiondock-border))',
    borderRadius: '4px',
    padding: '3px 0',
    minWidth: '170px',
    boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
    fontSize: '12px',
    color: 'var(--vscode-menu-foreground, var(--versiondock-text))',
    userSelect: 'none' as const,
  },
  item: {
    display: 'flex',
    alignItems: 'center',
    gap: '7px',
    padding: '5px 12px',
    cursor: 'pointer',
    background: 'transparent',
    userSelect: 'none' as const,
  },
  separator: {
    height: '1px',
    background: 'var(--vscode-menu-separatorBackground, var(--versiondock-border-soft))',
    margin: '3px 0',
  } as React.CSSProperties,
};

const css = {
  root: { display: 'flex', flexDirection: 'column' as const, flex: 1, height: '100%', minHeight: 0, overflow: 'hidden' },
  list: { flex: 1, overflowY: 'auto' as const, minHeight: 0 },
  footer: {
    flexShrink: 0,
    display: 'flex', flexDirection: 'column' as const, gap: '6px',
    padding: '8px',
    borderTop: '1px solid var(--vscode-panel-border, var(--versiondock-border))',
    background: 'var(--vscode-sideBar-background, var(--versiondock-surface))',
    position: 'sticky' as const,
    bottom: 0,
    zIndex: 2,
  } as React.CSSProperties,
  pills: { display: 'flex', flexWrap: 'wrap' as const, gap: '4px' } as React.CSSProperties,
  pill: (color: string): React.CSSProperties => ({
    display: 'inline-flex', alignItems: 'center', gap: '3px',
    padding: '1px 7px 1px 4px', borderRadius: '10px',
    fontSize: '11px', lineHeight: '16px',
    background: color + '28', color,
    border: `1px solid ${color}60`,
  }),
  pillRemove: (color: string): React.CSSProperties => ({
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'transparent', border: 'none', color,
    cursor: 'pointer', padding: '0 1px', borderRadius: '50%', lineHeight: 1,
  }),
  pillCount: {
    display: 'inline-flex', alignItems: 'center',
    background: 'rgba(255,255,255,0.15)', borderRadius: '7px',
    padding: '0 3px', fontSize: '10px', minWidth: '14px', height: '14px',
    justifyContent: 'center', boxSizing: 'border-box' as const,
  } as React.CSSProperties,
  pushBtn: (enabled: boolean, hovered: boolean, pressed: boolean): React.CSSProperties => ({
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: enabled && hovered
      ? 'var(--vscode-button-hoverBackground, var(--versiondock-accent))'
      : 'var(--vscode-button-background, var(--versiondock-accent-bg))',
    color: 'var(--vscode-button-foreground, #ffffff)',
    border: 'none', borderRadius: '3px', padding: '6px 12px',
    cursor: enabled ? 'pointer' : 'default',
    fontSize: '12px', fontFamily: 'var(--vscode-font-family, inherit)',
    opacity: enabled ? 1 : 0.45, width: '100%',
    transform: enabled && pressed ? 'translateY(1px) scale(0.995)' : 'none',
    filter: enabled && pressed ? 'brightness(0.92)' : 'none',
    transition: 'background-color 80ms ease, transform 60ms ease, filter 60ms ease',
  }),
};

const styles = {
  repoRoot: { borderBottom: '1px solid var(--vscode-panel-border, var(--versiondock-border))' } as React.CSSProperties,
  repoHeader: (color: string): React.CSSProperties => ({
    display: 'flex', alignItems: 'center',
    padding: '4px 8px', minHeight: '26px',
    background: color + '22', borderBottom: '1px solid var(--vscode-panel-border, var(--versiondock-border))',
    boxSizing: 'border-box',
  }),
  checkbox: {
    margin: '0 2px 0 0', flexShrink: 0,
    accentColor: 'var(--vscode-button-background, var(--versiondock-accent-bg))',
  } as React.CSSProperties,
  headerMain: {
    display: 'flex', alignItems: 'center', gap: '6px',
    flex: 1, minWidth: 0, cursor: 'pointer',
  } as React.CSSProperties,
  dot: (color: string): React.CSSProperties => ({
    width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0,
  }),
  repoName: {
    fontSize: '11px', fontWeight: 'bold' as const,
    textTransform: 'uppercase' as const, letterSpacing: 0, minWidth: 0,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, flexShrink: 1,
  },
  directionBadge: (color: string): React.CSSProperties => ({
    display: 'inline-flex', alignItems: 'center',
    color,
    border: `1px solid color-mix(in srgb, ${color} 38%, transparent)`,
    background: `color-mix(in srgb, ${color} 12%, transparent)`,
    borderRadius: '8px', padding: '1px 6px', fontSize: '10px', fontWeight: 'bold' as const,
    lineHeight: '14px',
    flexShrink: 0,
  }),
  publishBadge: {
    display: 'inline-flex', alignItems: 'center',
    background: 'var(--versiondock-badge-background, var(--versiondock-accent-bg))',
    color: 'var(--versiondock-badge-foreground, #ffffff)',
    borderRadius: '8px', padding: '1px 6px', fontSize: '10px', fontWeight: 500 as const,
    flexShrink: 0,
  } as React.CSSProperties,
  repoRightGroup: {
    display: 'flex',
    alignItems: 'center',
    gap: '2px',
    marginLeft: 'auto',
    flexShrink: 0,
  } as React.CSSProperties,
  repoModeButton: (disabled: boolean, visible: boolean): React.CSSProperties => ({
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: 22, height: 22, padding: 0, border: 'none', borderRadius: '3px',
    background: 'transparent', color: 'var(--vscode-icon-foreground, var(--versiondock-muted))',
    cursor: disabled ? 'default' : 'pointer',
    opacity: visible ? (disabled ? 0.35 : 1) : 0,
    pointerEvents: visible && !disabled ? 'auto' : 'none',
    transition: 'opacity 0.1s',
    flexShrink: 0,
  }),
  repoBody: { background: 'var(--vscode-sideBar-background, var(--versiondock-surface))' } as React.CSSProperties,
  upToDate: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '8px 12px', fontSize: '12px', color: 'var(--vscode-descriptionForeground, var(--versiondock-muted))',
  } as React.CSSProperties,
  behindRow: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: '12px 8px', fontSize: '12px',
    color: 'var(--vscode-descriptionForeground, var(--versiondock-muted))',
  } as React.CSSProperties,
  unpublishedRow: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: '12px 8px', fontSize: '12px', color: 'var(--vscode-descriptionForeground, var(--versiondock-muted))',
  } as React.CSSProperties,
  loadingRow: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: '8px 12px', fontSize: '12px', color: 'var(--vscode-descriptionForeground, var(--versiondock-muted))',
    textAlign: 'center' as const,
  } as React.CSSProperties,
  errorRow: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '6px 10px', fontSize: '11px',
    color: 'var(--vscode-errorForeground, var(--versiondock-danger))',
    textAlign: 'center' as const,
  } as React.CSSProperties,
  commitList: { display: 'flex', flexDirection: 'column' as const } as React.CSSProperties,
  commitCard: (_expanded: boolean, selected: boolean): React.CSSProperties => ({
    borderBottom: '1px solid var(--vscode-panel-border, var(--versiondock-border))',
    background: selected ? 'var(--vscode-list-inactiveSelectionBackground, var(--versiondock-selected))' : 'transparent',
  }),
  commitRow: {
    display: 'grid',
    gridTemplateColumns: '48px 1fr auto',
    gridTemplateRows: 'auto auto',
    gap: '0 8px',
    padding: '7px 12px',
    alignItems: 'center',
    cursor: 'pointer',
    boxSizing: 'border-box',
    userSelect: 'none' as const,
  } as React.CSSProperties,
  commitHash: {
    fontFamily: 'var(--vscode-editor-font-family, var(--versiondock-code))', fontSize: '10px',
    color: 'var(--vscode-descriptionForeground, var(--versiondock-muted))', gridRow: '1', gridColumn: '1',
    display: 'flex', alignItems: 'center',
  } as React.CSSProperties,
  commitMessage: {
    fontSize: '12px', fontWeight: 500, gridRow: '1', gridColumn: '2',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const,
  } as React.CSSProperties,
  commitMeta: {
    fontSize: '10px', color: 'var(--vscode-descriptionForeground, var(--versiondock-muted))', gridRow: '2', gridColumn: '2',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const,
    display: 'flex', alignItems: 'center',
  } as React.CSSProperties,
  commitStats: {
    display: 'inline-flex',
    alignItems: 'center',
    flexShrink: 0,
  } as React.CSSProperties,
  statAdd: { color: 'var(--vscode-gitDecoration-addedResourceForeground, var(--versiondock-success))' } as React.CSSProperties,
  statDel: { color: 'var(--vscode-gitDecoration-deletedResourceForeground, var(--versiondock-danger))' } as React.CSSProperties,
  commitActions: (visible: boolean): React.CSSProperties => ({
    gridRow: '1 / 3', gridColumn: '3',
    display: 'flex', alignItems: 'center', gap: '4px', alignSelf: 'center',
    opacity: visible ? 1 : 0, transition: 'opacity 0.1s',
  }),
  actionBtn: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'transparent', border: 'none',
    color: 'var(--vscode-foreground, var(--versiondock-text))',
    cursor: 'pointer', padding: '2px', borderRadius: '3px',
  } as React.CSSProperties,
  commitDetails: {
    paddingBottom: '6px',
  } as React.CSSProperties,
  messagePanel: {
    padding: '8px 26px',
    borderBottom: '1px dashed var(--vscode-panel-border, var(--versiondock-border))',
  } as React.CSSProperties,
  bodyBlock: {
    marginBottom: 0,
    color: 'var(--vscode-foreground, var(--versiondock-text))',
    fontFamily: 'var(--vscode-editor-font-family, var(--versiondock-code))',
  } as React.CSSProperties,
  bodyText: {
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    fontSize: '11px',
    lineHeight: 1.45,
  } as React.CSSProperties,
  footerText: (withTopBorder: boolean): React.CSSProperties => ({
    margin: withTopBorder ? '8px 0 0' : 0,
    paddingTop: withTopBorder ? 8 : 0,
    borderTop: withTopBorder ? '1px dashed var(--vscode-panel-border, var(--versiondock-border))' : 'none',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    fontFamily: 'var(--vscode-editor-font-family, var(--versiondock-code))',
    fontSize: '11px',
    lineHeight: 1.45,
  }),
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
