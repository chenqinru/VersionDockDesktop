import { useMemo, useState } from 'react';
import { Codicon } from './Codicon';
import { FileIcon } from './FileIcon';
import { useAppStore, type AppStore } from '../store/appStore';
import { useI18n } from '../i18n';
import { buildCommitFileTargets, commitKey, type DetailFileTarget } from '../history/commitDetails';
import type { CommitDetail, CommitNode, CommitPathOperationEntry, MergeParentChange, RepositoryStatus } from '../bindings/generated';
import { ContextMenu, type ContextMenuEntry } from './ContextMenu';
import { confirmDialog } from './dialogService';
import { AuthorAvatar } from './AuthorAvatar';

type DetailTreeNode = { name: string; path: string; children: DetailTreeNode[]; file?: DetailFileTarget; fileCount: number };

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date);
}

function statusClass(status: string): string {
  const value = status.replace(/\d+$/, '').slice(0, 1).toUpperCase();
  return value === 'A' || value === 'C' ? 'added' : value === 'D' ? 'deleted' : value === 'R' ? 'renamed' : 'modified';
}

function refLabel(ref: string): string {
  return ref.replace('HEAD -> ', '').replace('tag: ', '').replace('refs/heads/', '').replace('refs/remotes/', '');
}

type DetailRef = { value: string; kind: 'branch' | 'remote' | 'tag' | 'head' };

function refsFor(detail: CommitDetail): DetailRef[] {
  const local = new Set(detail.branches.local);
  const remote = new Set(detail.branches.remote);
  const tags = new Set(detail.branches.tags);
  const existingLabels = new Set(detail.commit.refs.map(refLabel));
  const refs = [...new Set([
    ...detail.commit.refs,
    ...detail.branches.local.filter((branch) => !existingLabels.has(refLabel(branch))),
    ...detail.branches.remote.filter((branch) => !existingLabels.has(refLabel(branch))),
    ...detail.branches.tags.map((tag) => `tag: ${tag}`).filter((tag) => !existingLabels.has(refLabel(tag))),
  ])];
  return refs.map((value) => {
    if (value.includes('HEAD')) return { value, kind: 'head' };
    if (value.startsWith('tag: ') || value.startsWith('refs/tags/') || tags.has(value)) return { value, kind: 'tag' };
    if (remote.has(value) || value.startsWith('refs/remotes/')) return { value, kind: 'remote' };
    return { value, kind: local.has(value) ? 'branch' : value.includes('/') ? 'remote' : 'branch' };
  });
}

function sortTreeNodes(nodes: DetailTreeNode[]): DetailTreeNode[] {
  return nodes
    .map((node) => ({
      ...node,
      children: sortTreeNodes(node.children),
    }))
    .sort((left, right) => {
      if (!left.file && right.file) return -1;
      if (left.file && !right.file) return 1;
      return left.name.localeCompare(right.name);
    });
}

function buildTree(files: DetailFileTarget[]): DetailTreeNode[] {
  const root: DetailTreeNode[] = [];
  for (const file of files) {
    const parts = file.path.split('/');
    let nodes = root;
    parts.forEach((name, index) => {
      const path = parts.slice(0, index + 1).join('/');
      let node = nodes.find((item) => item.name === name);
      if (!node) {
        node = { name, path, children: [], fileCount: 0 };
        nodes.push(node);
      }
      if (index === parts.length - 1) node.file = file;
      nodes = node.children;
    });
  }
  const count = (node: DetailTreeNode): number => node.file ? 1 : node.children.reduce((total, child) => total + count(child), 0);
  const visit = (nodes: DetailTreeNode[]) => nodes.forEach((node) => { node.fileCount = count(node); visit(node.children); });
  visit(root);
  return sortTreeNodes(root);
}

function collapseTree(node: DetailTreeNode): DetailTreeNode {
  if (node.file) return node;
  let current = { ...node, children: node.children.map(collapseTree) };
  while (!current.file && current.children.length === 1 && !current.children[0].file) {
    const child = current.children[0];
    current = { ...child, name: `${current.name}/${child.name}`, path: child.path };
  }
  return current;
}

function descendantFiles(node: DetailTreeNode): DetailFileTarget[] {
  if (node.file) return [node.file];
  return node.children.flatMap(descendantFiles);
}

function commitPathEntries(
  files: DetailFileTarget[],
  selectedCommits: CommitNode[],
  selectedDetails: Record<string, CommitDetail>,
  direction: 'apply' | 'revert',
): CommitPathOperationEntry[] {
  const paths = new Set(files.map((file) => `${file.repoId}\0${file.path}`));
  const commits = direction === 'apply' ? [...selectedCommits].reverse() : selectedCommits;
  const entries = commits.flatMap((commit) => {
    const detail = selectedDetails[commitKey(commit.repoId, commit.hash)];
    return (detail?.files ?? [])
      .filter((file) => paths.has(`${commit.repoId}\0${file.path}`))
      .map((file) => ({ revision: commit.hash, path: file.path, status: file.status }));
  });
  if (entries.length > 0) {
    return [...new Map(entries.map((entry) => [`${entry.revision}\0${entry.path}`, entry])).values()];
  }
  return [...new Map(files.map((file) => [`${file.commitHash}\0${file.path}`, {
    revision: file.commitHash,
    path: file.path,
    status: file.status,
  }])).values()];
}

function openTarget(target: DetailFileTarget, openDiff: AppStore['openDiff']): void {
  const range = target.fromRevision && target.toRevision ? { fromRevision: target.fromRevision, toRevision: target.toRevision } : undefined;
  void openDiff(target.repoId, target.path, false, range ? undefined : target.commitHash, range);
}

function DetailFileContextMenu({ position, file, close, openDiff }: { position: { x: number; y: number }; file: DetailFileTarget; close: () => void; openDiff: AppStore['openDiff'] }) {
  const { t } = useI18n();
  const systemOpen = useAppStore((state) => state.systemOpen);
  const openFileHistory = useAppStore((state) => state.openFileHistory);
  const openHistoryForPath = useAppStore((state) => state.openHistoryForPath);
  const historyOperation = useAppStore((state) => state.historyOperation);
  const selectedCommits = useAppStore((state) => state.selectedCommits);
  const selectedDetails = useAppStore((state) => state.selectedCommitDetails);
  const repoKind = useAppStore((state) => state.snapshot?.repositories.find((repo) => repo.meta.id === file.repoId)?.meta.kind);
  const directCommitFile = !file.fromRevision && !file.toRevision || (file.commitHashes?.length ?? 0) > 1;
  const items: ContextMenuEntry[] = [
    { id: 'diff', label: t('Show Diff'), icon: 'diff' },
    { id: 'history', label: t('File history'), icon: 'history' },
    { id: 'commit-history', label: t('Show in commit history'), icon: 'git-commit' },
    { id: 'open', label: t('Open file'), icon: 'go-to-file' },
    { id: 'reveal', label: t('Reveal in File Manager'), icon: 'folder-opened' },
    ...(repoKind === 'git' && directCommitFile ? [
      { id: 'revert-file', label: t('Revert Selected Changes'), icon: 'discard', danger: true } as ContextMenuEntry,
      { id: 'checkout-file', label: t('Cherry-Pick Selected Changes'), icon: 'git-commit' } as ContextMenuEntry,
    ] : []),
  ];
  return <ContextMenu x={position.x} y={position.y} items={items} onSelect={(id) => {
    if (id === 'diff') openTarget(file, openDiff);
    if (id === 'history') openFileHistory(file.repoId, file.path);
    if (id === 'commit-history') void openHistoryForPath(file.repoId, file.path);
    if (id === 'open') void systemOpen(file.repoId, file.path, false);
    if (id === 'reveal') void systemOpen(file.repoId, file.path, true);
    if (id === 'checkout-file') void confirmDialog({ title: t('Get file from revision?'), message: `${file.path}\n${file.commitHash}`, danger: true }).then((yes) => { if (yes) return historyOperation(file.repoId, { type: 'applyPaths', entries: commitPathEntries([file], selectedCommits, selectedDetails, 'apply') }); });
    if (id === 'revert-file') void confirmDialog({ title: t('Revert file to parent revision?'), message: `${file.path}\n\n${t('Current working-copy content will be replaced.')}`, danger: true }).then((yes) => { if (yes) return historyOperation(file.repoId, { type: 'revertPaths', entries: commitPathEntries([file], selectedCommits, selectedDetails, 'revert') }); });
    close();
  }} onClose={close} />;
}

function DetailDirectoryContextMenu({ position, files, close }: { position: { x: number; y: number }; files: DetailFileTarget[]; close: () => void }) {
  const { t } = useI18n();
  const repositories = useAppStore((state) => state.snapshot?.repositories ?? []);
  const historyOperation = useAppStore((state) => state.historyOperation);
  const selectedCommits = useAppStore((state) => state.selectedCommits);
  const selectedDetails = useAppStore((state) => state.selectedCommitDetails);
  const repoIds = new Set(files.map((file) => file.repoId));
  const repoId = files[0]?.repoId;
  const repoKind = repositories.find((repo) => repo.meta.id === repoId)?.meta.kind;
  const eligible = files.length > 0
    && repoIds.size === 1
    && repoKind === 'git'
    && files.every((file) => (!file.fromRevision && !file.toRevision) || (file.commitHashes?.length ?? 0) > 1);
  if (!eligible || !repoId) return null;
  const uniquePaths = [...new Set(files.map((file) => file.path))];
  const visiblePaths = uniquePaths.slice(0, 8);
  const remaining = uniquePaths.length - visiblePaths.length;
  const affected = `${t('{0} files', uniquePaths.length)}\n${visiblePaths.join('\n')}${remaining > 0 ? `\n${t('+{0} more', remaining)}` : ''}`;
  const items: ContextMenuEntry[] = [
    { id: 'revert-paths', label: t('Revert Selected Changes'), icon: 'discard' },
    { id: 'apply-paths', label: t('Cherry-Pick Selected Changes'), icon: 'git-commit' },
  ];
  return <ContextMenu x={position.x} y={position.y} items={items} onSelect={(id) => {
    const reverting = id === 'revert-paths';
    const entries = commitPathEntries(files, selectedCommits, selectedDetails, reverting ? 'revert' : 'apply');
    void confirmDialog({
      title: t(reverting ? 'Revert selected changes?' : 'Cherry-pick selected changes?'),
      message: `${affected}\n\n${t(reverting ? 'The selected commit changes will be reversed in the working copy.' : 'The selected commit versions will replace the working-copy files.')}`,
      danger: true,
    }).then((yes) => {
      if (!yes) return;
      return historyOperation(repoId, { type: reverting ? 'revertPaths' : 'applyPaths', entries });
    });
    close();
  }} onClose={close} />;
}

function isFileSelected(file: DetailFileTarget, selectedFile: AppStore['selectedFile']): boolean {
  if (!selectedFile) return false;
  return selectedFile.repoId === file.repoId
    && selectedFile.path === file.path
    && (selectedFile.fromRevision ?? null) === (file.fromRevision ?? null)
    && (selectedFile.toRevision ?? null) === (file.toRevision ?? null);
}

function DetailTreeNodeView({
  node,
  depth,
  openDiff,
  selectedFile,
  allExpanded,
  clearAllExpanded,
}: {
  node: DetailTreeNode;
  depth: number;
  openDiff: AppStore['openDiff'];
  selectedFile?: AppStore['selectedFile'];
  allExpanded: boolean | null;
  clearAllExpanded: () => void;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(true);
  const [context, setContext] = useState<{ x: number; y: number }>();
  if (node.file) {
    const file = node.file;
    const isSelected = isFileSelected(file, selectedFile);
    return (<>
      <button
        type="button"
        className={`detail-file-row status-${statusClass(file.status)} ${isSelected ? 'selected' : ''}`}
        style={{ paddingLeft: 18 + depth * 14 }}
        title={`${file.path}\n${t('Click to open diff')}`}
        onClick={() => openTarget(file, openDiff)}
        onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); setContext({ x: event.clientX, y: event.clientY }); }}
      >
        <FileIcon name={node.name} />
        <span className="detail-file-name">{node.name}</span>
        {(file.added !== null || file.removed !== null) && (
          <span className="detail-line-stats">
            {file.added !== null && <b className="added">+{file.added}</b>}
            {file.removed !== null && <b className="removed">-{file.removed}</b>}
          </span>
        )}
        <em>{file.status.replace(/\d+$/, '').slice(0, 1).toUpperCase()}</em>
      </button>
      {context && <DetailFileContextMenu position={context} file={file} openDiff={openDiff} close={() => setContext(undefined)} />}
    </>);
  }
  const isExpanded = allExpanded ?? expanded;
  const files = descendantFiles(node);
  return (
    <>
      <div className="detail-tree-dir">
        <button
          type="button"
          style={{ paddingLeft: depth * 14 }}
          title={node.path}
          onClick={() => {
            if (allExpanded !== null) clearAllExpanded();
            setExpanded((value) => !value);
          }}
          onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); setContext({ x: event.clientX, y: event.clientY }); }}
        >
          <Codicon name={isExpanded ? 'chevron-down' : 'chevron-right'} />
          <FileIcon name={node.name.split('/').pop() ?? node.name} folder open={isExpanded} />
          <span className="detail-node-label">{node.name}</span>
          <b className="detail-directory-count">{node.fileCount}</b>
        </button>
        {isExpanded && node.children.map((child) => (
          <DetailTreeNodeView
            key={child.path}
            node={child}
            depth={depth + 1}
            openDiff={openDiff}
            selectedFile={selectedFile}
            allExpanded={allExpanded}
            clearAllExpanded={clearAllExpanded}
          />
        ))}
      </div>
      {context && <DetailDirectoryContextMenu position={context} files={files} close={() => setContext(undefined)} />}
    </>
  );
}

function DetailFlatFileRow({
  file,
  repoName,
  showRepo,
  selectedFile,
  openDiff,
}: {
  file: DetailFileTarget;
  repoName?: string;
  showRepo?: boolean;
  selectedFile?: AppStore['selectedFile'];
  openDiff: AppStore['openDiff'];
}) {
  const { t } = useI18n();
  const [context, setContext] = useState<{ x: number; y: number }>();
  const fileName = file.path.split('/').pop() ?? file.path;
  const dir = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';
  const isSelected = isFileSelected(file, selectedFile);
  return (<>
    <button
      type="button"
      key={`${file.repoId}:${file.fromRevision ?? ''}:${file.path}`}
      className={`detail-file-row detail-list-row status-${statusClass(file.status)} ${isSelected ? 'selected' : ''}`}
      title={`${file.path}\n${t('Click to open diff')}`}
      onClick={() => openTarget(file, openDiff)}
      onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); setContext({ x: event.clientX, y: event.clientY }); }}
    >
      <FileIcon name={fileName} />
      <span className="detail-file-name">{fileName}</span>
      {dir && <span className="detail-dir-path">{dir}</span>}
      {showRepo && repoName && <small className="detail-repo-pill">{repoName}</small>}
      {(file.added !== null || file.removed !== null) && (
        <span className="detail-line-stats">
          {file.added !== null && <b className="added">+{file.added}</b>}
          {file.removed !== null && <b className="removed">-{file.removed}</b>}
        </span>
      )}
      <em>{file.status.replace(/\d+$/, '').slice(0, 1).toUpperCase()}</em>
    </button>
    {context && <DetailFileContextMenu position={context} file={file} openDiff={openDiff} close={() => setContext(undefined)} />}
  </>);
}

function DetailRepoGroup({
  files,
  repoName,
  repoColor,
  openDiff,
  selectedFile,
  allExpanded,
  clearAllExpanded,
}: {
  files: DetailFileTarget[];
  repoName: string;
  repoColor?: string;
  openDiff: AppStore['openDiff'];
  selectedFile?: AppStore['selectedFile'];
  allExpanded: boolean | null;
  clearAllExpanded: () => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const [context, setContext] = useState<{ x: number; y: number }>();
  const isExpanded = allExpanded ?? expanded;
  return (
    <>
      <div className="detail-repo-group">
        <button
          type="button"
          className="detail-root-label"
          title={repoName}
          onClick={() => {
            if (allExpanded !== null) clearAllExpanded();
            setExpanded((value) => !value);
          }}
          onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); setContext({ x: event.clientX, y: event.clientY }); }}
        >
          <Codicon name={isExpanded ? 'chevron-down' : 'chevron-right'} />
          <i style={{ background: repoColor ?? 'var(--versiondock-accent)' }} />
          <strong>{repoName}</strong>
          <b>{files.length}</b>
        </button>
        {isExpanded && buildTree(files).map((node) => (
          <DetailTreeNodeView
            key={node.path}
            node={collapseTree(node)}
            depth={1}
            openDiff={openDiff}
            selectedFile={selectedFile}
            allExpanded={allExpanded}
            clearAllExpanded={clearAllExpanded}
          />
        ))}
      </div>
      {context && <DetailDirectoryContextMenu position={context} files={files} close={() => setContext(undefined)} />}
    </>
  );
}

function MergeParentChangeGroup({
  change,
  commitHash,
  repoId,
  viewMode,
  allExpanded,
  clearAllExpanded,
  selectedFile,
  openDiff,
}: {
  change: MergeParentChange;
  commitHash: string;
  repoId: string;
  viewMode: 'tree' | 'list';
  allExpanded: boolean | null;
  clearAllExpanded: () => void;
  selectedFile?: AppStore['selectedFile'];
  openDiff: AppStore['openDiff'];
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const loadParentFiles = useAppStore((state) => state.loadMergeParentFiles);
  const cacheKey = `${repoId}\0${commitHash}\0${change.hash}`;
  const files = useAppStore((state) => state.mergeParentFiles[cacheKey]);
  const loading = useAppStore((state) => Boolean(state.mergeParentFilesLoading[cacheKey]));

  const parentTargets: DetailFileTarget[] = useMemo(() => {
    if (!files) return [];
    return files.map((file) => ({
      repoId,
      commitHash,
      path: file.path,
      status: file.status,
      added: file.added,
      removed: file.removed,
      fromRevision: change.hash,
      toRevision: commitHash,
    }));
  }, [files, repoId, commitHash, change.hash]);

  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    if (next && !files && !loading) {
      void loadParentFiles(repoId, commitHash, change.hash);
    }
  };

  return (
    <div className="merge-parent-group">
      <button
        type="button"
        className="merge-parent-row"
        data-selected={expanded}
        title={`${change.hash}\n${change.message}`}
        onClick={toggle}
      >
        <Codicon name={expanded ? 'chevron-down' : 'chevron-right'} className="merge-chevron" />
        <Codicon name="git-commit" className="merge-commit-icon" />
        <span className="merge-parent-title">{t('Changes from {0}', change.shortHash)}</span>
        {change.message && <span className="merge-parent-message" title={change.message}>{change.message}</span>}
        <span className="merge-parent-count">
          {change.fileCount === 1 ? t('{0} file', change.fileCount) : t('{0} files', change.fileCount)}
        </span>
      </button>
      {expanded && (
        <div className="merge-parent-files">
          {loading && <div className="detail-loading">{t('Loading files...')}</div>}
          {!loading && files && files.length === 0 && <div className="detail-loading">{t('No changed files')}</div>}
          {!loading && files && files.length > 0 && (
            viewMode === 'tree' ? (
              buildTree(parentTargets).map((node) => (
                <DetailTreeNodeView
                  key={node.path}
                  node={collapseTree(node)}
                  depth={0}
                  openDiff={openDiff}
                  selectedFile={selectedFile}
                  allExpanded={allExpanded}
                  clearAllExpanded={clearAllExpanded}
                />
              ))
            ) : (
              parentTargets.map((file) => (
                <DetailFlatFileRow
                  key={`${file.repoId}:${file.fromRevision ?? ''}:${file.path}`}
                  file={file}
                  selectedFile={selectedFile}
                  openDiff={openDiff}
                />
              ))
            )
          )}
        </div>
      )}
    </div>
  );
}

function RefBadges({ detail }: { detail: CommitDetail }) {
  return (
    <div className="detail-refs">
      {refsFor(detail).map((ref) => (
        <em className={ref.kind} key={`${ref.kind}:${ref.value}`}>
          <Codicon name={ref.kind === 'tag' ? 'tag' : ref.kind === 'remote' ? 'cloud' : ref.kind === 'head' ? 'arrow-right' : 'git-branch'} />
          {refLabel(ref.value)}
        </em>
      ))}
    </div>
  );
}

function splitCommitMessage(detail: CommitDetail): { subject: string; body: string } {
  const messageLines = detail.fullMessage.replace(/\r\n/g, '\n').split('\n');
  const subject = messageLines[0]?.trim() || detail.commit.message.trim();
  const body = messageLines[0]?.trim() === detail.commit.message.trim()
    ? messageLines.slice(1).join('\n').replace(/^\s*\n/, '').trimEnd()
    : detail.fullMessage.trim();
  return { subject, body };
}

function CommitMessage({
  detail,
  expanded,
  toggle,
}: {
  detail: CommitDetail;
  expanded: boolean;
  toggle: () => void;
}) {
  const { t } = useI18n();
  const { subject, body } = splitCommitMessage(detail);
  const hasBody = body.length > 0;

  return (
    <div className="detail-message-card">
      <div className="detail-message-title">
        <strong className={expanded ? 'expanded' : ''} title={subject}>
          {subject}
        </strong>
        {hasBody && (
          <button
            type="button"
            title={expanded ? t('Click to collapse') : t('Click to expand')}
            onClick={toggle}
          >
            <Codicon name={expanded ? 'chevron-up' : 'chevron-down'} />
          </button>
        )}
      </div>
      {expanded && hasBody && <pre>{body}</pre>}
    </div>
  );
}

function ExtendedCommitSummary({
  detail,
  selectedCommits,
  selectedDetails,
  loading,
  repoMap,
}: {
  detail?: CommitDetail;
  selectedCommits: CommitNode[];
  selectedDetails: Record<string, CommitDetail>;
  loading: boolean;
  repoMap: Map<string, RepositoryStatus>;
}) {
  const { t } = useI18n();
  const multiple = selectedCommits.length > 1;

  if (multiple) {
    const oldest = selectedCommits[selectedCommits.length - 1];
    const newest = selectedCommits[0];
    return (
      <section className="extended-commit-summary" aria-label={t('Aggregated commit selection')}>
        <div className="extended-detail-block">
          <h3>{t('Details')}</h3>
          <dl className="extended-detail-grid">
            <dt>{t('Aggregated commit selection')}</dt>
            <dd>{t('{0} commits selected', selectedCommits.length)}</dd>
            <dt>{t('Repository')}</dt>
            <dd>{t('{0} repositories involved', new Set(selectedCommits.map((commit) => commit.repoId)).size)}</dd>
            <dt>{t('Selected time range')}</dt>
            <dd>{formatDate(oldest?.authorDate ?? '')} - {formatDate(newest?.authorDate ?? '')}</dd>
          </dl>
        </div>
        <div className="extended-detail-block">
          <h3>{t('Aggregated commit selection')}</h3>
          <div className="extended-commit-list">
            {selectedCommits.map((commit) => {
              const key = commitKey(commit.repoId, commit.hash);
              const current = selectedDetails[key];
              const repo = repoMap.get(commit.repoId);
              if (!current) return <article className="extended-commit-item" key={key}><div className="detail-loading">{t('Loading...')}</div></article>;
              const message = splitCommitMessage(current);
              return (
                <article className="extended-commit-item" key={key}>
                  <div className="extended-commit-repo" style={{ color: repo?.meta.color }}><Codicon name="repo" />{repo?.meta.name ?? commit.repoId}</div>
                  <div className="extended-message-card">
                    <strong>{message.subject}</strong>
                    {message.body && <pre>{message.body}</pre>}
                  </div>
                  <AuthorMeta commit={commit} />
                  <RefBadges detail={current} />
                </article>
              );
            })}
          </div>
        </div>
        {loading && <div className="detail-loading">{t('Loading...')}</div>}
      </section>
    );
  }

  if (!detail) return <section className="extended-commit-summary"><div className="detail-loading">{t('Loading...')}</div></section>;
  const commit = detail.commit;
  const repo = repoMap.get(commit.repoId);
  return (
    <section className="extended-commit-summary" aria-label={t('Open Commit Detail')}>
      <div className="extended-detail-block">
        <h3>{t('Author')}</h3>
        <div className="extended-author">
          <AuthorAvatar name={commit.author} email={commit.email} size={24} />
          <span><strong>{commit.author}</strong><small>{commit.email}</small></span>
        </div>
      </div>
      <div className="extended-detail-block">
        <h3>{t('Details')}</h3>
        <dl className="extended-detail-grid">
          <dt>{t('Hash')}</dt><dd><code title={commit.hash}>{commit.hash}</code></dd>
          <dt>{t('Author date')}</dt><dd>{formatDate(commit.authorDate)}</dd>
          <dt>{t('Commit date')}</dt><dd>{formatDate(commit.committerDate)}</dd>
          <dt>{t('Repository')}</dt><dd style={{ color: repo?.meta.color }}>{repo?.meta.name ?? commit.repoId}</dd>
        </dl>
      </div>
      {refsFor(detail).length > 0 && <div className="extended-detail-block"><h3>{t('Branches & tags')}</h3><RefBadges detail={detail} /></div>}
      <div className="extended-detail-block">
        <h3>{t('Commit message')}</h3>
        <pre className="extended-full-message">{detail.fullMessage.trim() || commit.message}</pre>
      </div>
    </section>
  );
}

function AuthorMeta({ commit }: { commit: CommitNode }) {
  return (
    <div className="detail-author-meta">
      <AuthorAvatar name={commit.author} email={commit.email} size={36} />
      <span className="detail-author-line">
        <strong>{commit.author}</strong>
        <i>·</i>
        <time>{formatDate(commit.authorDate || commit.committerDate)}</time>
        <i>·</i>
        <code><Codicon name="git-commit" />{commit.shortHash}</code>
      </span>
    </div>
  );
}

export function CommitDetailPanel({ onCollapse, variant = 'sidebar' }: { onCollapse: () => void; variant?: 'sidebar' | 'workspace' }) {
  const detail = useAppStore((state) => state.selectedCommit);
  const selectedCommits = useAppStore((state) => state.selectedCommits);
  const selectedDetails = useAppStore((state) => state.selectedCommitDetails);
  const selectedFile = useAppStore((state) => state.selectedFile);
  const loading = useAppStore((state) => state.selectedCommits.some((commit) =>
    state.selectedCommitLoading[commitKey(commit.repoId, commit.hash)] === true
  ));
  const repositories = useAppStore((state) => state.snapshot?.repositories ?? []);
  const openDiff = useAppStore((state) => state.openDiff);
  const openFileHistory = useAppStore((state) => state.openFileHistory);
  const openCommitDetail = useAppStore((state) => state.openCommitDetail);
  const openChanges = useAppStore((state) => state.openCommitChanges);
  const { t } = useI18n();
  const [fileMode, setFileMode] = useState<'tree' | 'list'>('tree');
  const [allTreeExpanded, setAllTreeExpanded] = useState<boolean | null>(null);
  const [expandedMessages, setExpandedMessages] = useState<Set<string>>(new Set());
  const [infoHeight, setInfoHeight] = useState<number>();
  const repoMap = useMemo(() => new Map(repositories.map((repo) => [repo.meta.id, repo])), [repositories]);
  const targets = useMemo(() => buildCommitFileTargets(selectedCommits, selectedDetails, repositories), [selectedCommits, selectedDetails, repositories]);
  const targetsByRepo = useMemo(() => {
    const groups = new Map<string, DetailFileTarget[]>();
    for (const target of targets) groups.set(target.repoId, [...(groups.get(target.repoId) ?? []), target]);
    return groups;
  }, [targets]);

  const resizeInfo = (event: React.PointerEvent) => {
    event.preventDefault();
    const startY = event.clientY;
    const initial = infoHeight ?? Math.max(160, Math.round(window.innerHeight * .28));
    const move = (next: PointerEvent) => setInfoHeight(Math.min(Math.max(150, initial - (next.clientY - startY)), Math.max(230, window.innerHeight - 120)));
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); document.body.classList.remove('is-resizing'); };
    document.body.classList.add('is-resizing');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  if (!selectedCommits.length || (!detail && !loading)) {
    return (
      <aside className="commit-detail empty-detail">
        <Codicon name="git-commit" />
        <span>{t('Select a commit')}</span>
      </aside>
    );
  }

  const repoIds = [...targetsByRepo.keys()];
  const selectedPrimary = detail?.commit;
  const singleKey = selectedPrimary ? commitKey(selectedPrimary.repoId, selectedPrimary.hash) : '';
  const isMultiSelection = selectedCommits.length > 1;
  const isMergeCommit = !isMultiSelection && Boolean(detail && detail.commit.parents.length >= 2);
  const mergeParentChanges = (isMergeCommit && detail?.mergeParentChanges) ? detail.mergeParentChanges : [];

  const allMessagesExpanded = selectedCommits.length > 0 && selectedCommits.every((commit) => expandedMessages.has(commitKey(commit.repoId, commit.hash)));
  const toggleAllMessages = () => setExpandedMessages(allMessagesExpanded ? new Set() : new Set(selectedCommits.map((commit) => commitKey(commit.repoId, commit.hash))));
  const groupedTargets = repoIds.length > 1 ? [...targetsByRepo.entries()] : [[repoIds[0] ?? selectedPrimary?.repoId ?? '', targets]] as Array<[string, DetailFileTarget[]]>;
  const workspaceView = variant === 'workspace';

  return (
    <aside className={`commit-detail ${workspaceView ? 'commit-detail-expanded' : ''}`}>
      <section className="detail-file-section">
        <div className="detail-files-title">
          <strong>{targets.length} {t('files')}</strong>
          <span className="detail-files-spacer" />
          {targets[0] && <button type="button" title={t('File history')} onClick={() => openFileHistory(targets[0].repoId, targets[0].path)}><Codicon name="history" /></button>}
          {fileMode === 'tree' && (
            <>
              <button type="button" title={t('Expand all')} onClick={() => setAllTreeExpanded(true)}><Codicon name="expand-all" /></button>
              <button type="button" title={t('Collapse all')} onClick={() => setAllTreeExpanded(false)}><Codicon name="collapse-all" /></button>
              <i className="detail-view-divider" />
            </>
          )}
          <button type="button" className={fileMode === 'tree' ? 'selected' : ''} title={t('Tree view')} onClick={() => { setFileMode('tree'); setAllTreeExpanded(null); }}><Codicon name="list-tree" /></button>
          <button type="button" className={fileMode === 'list' ? 'selected' : ''} title={t('List view')} onClick={() => { setFileMode('list'); setAllTreeExpanded(null); }}><Codicon name="list-flat" /></button>
        </div>
        <div className="detail-files">
          {loading && !targets.length && <div className="detail-loading">{t('Loading files...')}</div>}
          {!loading && isMergeCommit && targets.length === 0 && (
            <div className="no-merge-conflicts">{t('No merge conflicts')}</div>
          )}
          {!loading && !isMergeCommit && targets.length === 0 && (
            <div className="detail-loading">{t('No changed files')}</div>
          )}
          {!loading && targets.length > 0 && (
            fileMode === 'tree' ? (
              groupedTargets.map(([repoId, files]) => (
                <DetailRepoGroup
                  key={repoId}
                  files={files}
                  repoName={repoMap.get(repoId)?.meta.name ?? repoId}
                  repoColor={repoMap.get(repoId)?.meta.color}
                  openDiff={openDiff}
                  selectedFile={selectedFile}
                  allExpanded={allTreeExpanded}
                  clearAllExpanded={() => setAllTreeExpanded(null)}
                />
              ))
            ) : (
              targets.map((file) => (
                <DetailFlatFileRow
                  key={`${file.repoId}:${file.fromRevision ?? ''}:${file.path}`}
                  file={file}
                  repoName={repoMap.get(file.repoId)?.meta.name ?? file.repoId}
                  showRepo={selectedCommits.length > 1}
                  selectedFile={selectedFile}
                  openDiff={openDiff}
                />
              ))
            )
          )}
          {!loading && isMergeCommit && mergeParentChanges.map((parentChange) => (
            <MergeParentChangeGroup
              key={`${detail!.commit.repoId}:${detail!.commit.hash}:${parentChange.hash}`}
              change={parentChange}
              commitHash={detail!.commit.hash}
              repoId={detail!.commit.repoId}
              viewMode={fileMode}
              allExpanded={allTreeExpanded}
              clearAllExpanded={() => setAllTreeExpanded(null)}
              selectedFile={selectedFile}
              openDiff={openDiff}
            />
          ))}
        </div>
      </section>
      {!workspaceView && <div className="detail-info-resize" role="separator" tabIndex={0} aria-label={t('Resize commit detail')} aria-orientation="horizontal" aria-valuemin={150} aria-valuemax={Math.max(230, window.innerHeight - 120)} aria-valuenow={Math.round(infoHeight ?? Math.max(160, window.innerHeight * .28))} onPointerDown={resizeInfo} onKeyDown={(event) => { if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); setInfoHeight((value) => Math.max(150, Math.min(Math.max(230, window.innerHeight - 120), (value ?? Math.max(160, window.innerHeight * .28)) + (event.key === 'ArrowUp' ? 10 : -10)))); } }}><i /></div>}
      {workspaceView ? <ExtendedCommitSummary detail={detail} selectedCommits={selectedCommits} selectedDetails={selectedDetails} loading={loading} repoMap={repoMap} /> : <section className="detail-summary" style={infoHeight ? { height: infoHeight } : undefined}>
        <header className="detail-toolbar">
          <span className="detail-toolbar-label" style={selectedCommits.length === 1 ? { color: repoMap.get(selectedPrimary?.repoId ?? '')?.meta.color } : undefined}>
            <Codicon name={selectedCommits.length > 1 ? 'git-commit' : 'repo'} />
            {selectedCommits.length > 1 ? t('Aggregated commit selection') : repoMap.get(selectedPrimary?.repoId ?? '')?.meta.name}
          </span>
          <div className="detail-actions">
            <button type="button" title={t('Open Commit Detail')} onClick={openCommitDetail}><Codicon name="open-preview" /></button>
            <button type="button" title={t('Open Changes')} onClick={openChanges}><Codicon name="diff-multiple" /></button>
            <button type="button" title={allMessagesExpanded ? t('Collapse commit messages by default') : t('Expand commit messages by default')} onClick={toggleAllMessages}><Codicon name={allMessagesExpanded ? 'collapse-all' : 'expand-all'} /></button>
            <button type="button" title={t('Close commit detail')} onClick={onCollapse}><Codicon name="layout-sidebar-right" /></button>
          </div>
        </header>
        {selectedCommits.length > 1 ? (
          <div className="detail-aggregate">
            <div className="detail-aggregate-meta">
              <div className="detail-aggregate-meta-row">
                <span>{t('{0} commits selected', selectedCommits.length)}</span>
                <span>{t('{0} repositories involved', new Set(selectedCommits.map((commit) => commit.repoId)).size)}</span>
              </div>
              <div className="detail-aggregate-meta-row">
                <span>{t('Selected time range')}</span>
                <span>{formatDate(selectedCommits[selectedCommits.length - 1]?.authorDate ?? '')} - {formatDate(selectedCommits[0]?.authorDate ?? '')}</span>
              </div>
            </div>
            {selectedCommits.map((commit) => {
              const value = selectedDetails[commitKey(commit.repoId, commit.hash)];
              const key = commitKey(commit.repoId, commit.hash);
              const repo = repoMap.get(commit.repoId);
              return (
                <article className="aggregate-item" key={key}>
                  <div className="aggregate-repo"><Codicon name="repo" /><span style={{ color: repo?.meta.color }}>{repo?.meta.name ?? commit.repoId}</span></div>
                  {value ? (
                    <>
                      <CommitMessage
                        detail={value}
                        expanded={expandedMessages.has(key)}
                        toggle={() => setExpandedMessages((current) => {
                          const next = new Set(current);
                          if (next.has(key)) next.delete(key);
                          else next.add(key);
                          return next;
                        })}
                      />
                      <AuthorMeta commit={commit} />
                      <RefBadges detail={value} />
                    </>
                  ) : (
                    <div className="detail-loading">{t('Loading files...')}</div>
                  )}
                </article>
              );
            })}
          </div>
        ) : detail && (
          <div className="detail-single">
            <CommitMessage
              detail={detail}
              expanded={expandedMessages.has(singleKey)}
              toggle={() => setExpandedMessages((current) => {
                const next = new Set(current);
                if (next.has(singleKey)) next.delete(singleKey);
                else next.add(singleKey);
                return next;
              })}
            />
            <AuthorMeta commit={detail.commit} />
            <RefBadges detail={detail} />
          </div>
        )}
      </section>}
    </aside>
  );
}
