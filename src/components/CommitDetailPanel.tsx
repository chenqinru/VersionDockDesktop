import { useEffect, useMemo, useState } from 'react';
import { Codicon } from './Codicon';
import { FileIcon } from './FileIcon';
import { useAppStore, type AppStore } from '../store/appStore';
import { useI18n } from '../i18n';
import { buildCommitFileTargets, commitKey, type DetailFileTarget } from '../history/commitDetails';
import { branchColor } from './branchColor';
import type { CommitDetail, CommitNode } from '../bindings/generated';

type DetailTreeNode = { name: string; path: string; children: DetailTreeNode[]; file?: DetailFileTarget; fileCount: number };

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date);
}

function initials(value: string): string {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? `${parts[0][0]}${parts[1][0]}` : parts[0]?.slice(0, 2) || '?').toUpperCase();
}

function avatarColor(value: string): string {
  return branchColor(value || 'author');
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
  return root;
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

function openTarget(target: DetailFileTarget, openDiff: AppStore['openDiff']): void {
  const range = target.fromRevision && target.toRevision ? { fromRevision: target.fromRevision, toRevision: target.toRevision } : undefined;
  void openDiff(target.repoId, target.path, false, range ? undefined : target.commitHash, range);
}

function DetailTreeNodeView({ node, depth, openDiff, allExpanded, clearAllExpanded }: { node: DetailTreeNode; depth: number; openDiff: AppStore['openDiff']; allExpanded: boolean | null; clearAllExpanded: () => void }) {
  const [expanded, setExpanded] = useState(true);
  if (node.file) {
    const file = node.file;
    return <button className={`detail-file-row status-${statusClass(file.status)}`} style={{ paddingLeft: 18 + depth * 14 }} title={file.path} onClick={() => openTarget(file, openDiff)}>
      <FileIcon name={node.name} />
      <span className="detail-file-name">{node.name}</span>
      {file.added !== null && <b className="added">+{file.added}</b>}
      {file.removed !== null && <b className="removed">-{file.removed}</b>}
      <em>{file.status.replace(/\d+$/, '').slice(0, 1).toUpperCase()}</em>
    </button>;
  }
  const isExpanded = allExpanded ?? expanded;
  return <div className="detail-tree-dir">
    <button style={{ paddingLeft: depth * 14 }} title={node.path} onClick={() => { if (allExpanded !== null) clearAllExpanded(); setExpanded((value) => !value); }}>
      <Codicon name={isExpanded ? 'chevron-down' : 'chevron-right'} /><FileIcon name={node.name.split('/').pop() ?? node.name} folder open={isExpanded} /><span className="detail-node-label">{node.name}</span><b className="detail-directory-count">{node.fileCount}</b>
    </button>
    {isExpanded && node.children.map((child) => <DetailTreeNodeView key={child.path} node={child} depth={depth + 1} openDiff={openDiff} allExpanded={allExpanded} clearAllExpanded={clearAllExpanded} />)}
  </div>;
}

function DetailRepoGroup({ files, repoName, repoColor, openDiff, allExpanded, clearAllExpanded }: { files: DetailFileTarget[]; repoName: string; repoColor?: string; openDiff: AppStore['openDiff']; allExpanded: boolean | null; clearAllExpanded: () => void }) {
  const [expanded, setExpanded] = useState(true);
  const isExpanded = allExpanded ?? expanded;
  return <div className="detail-repo-group">
      <button className="detail-root-label" title={repoName} onClick={() => { if (allExpanded !== null) clearAllExpanded(); setExpanded((value) => !value); }}>
      <Codicon name={isExpanded ? 'chevron-down' : 'chevron-right'} /><i style={{ background: repoColor ?? 'var(--versiondock-accent)' }} /><strong>{repoName}</strong><b>{files.length}</b>
    </button>
    {isExpanded && buildTree(files).map((node) => <DetailTreeNodeView key={node.path} node={collapseTree(node)} depth={1} openDiff={openDiff} allExpanded={allExpanded} clearAllExpanded={clearAllExpanded} />)}
  </div>;
}

function RefBadges({ detail }: { detail: CommitDetail }) {
  return <div className="detail-refs">{refsFor(detail).map((ref) => <em className={ref.kind} key={`${ref.kind}:${ref.value}`}><Codicon name={ref.kind === 'tag' ? 'tag' : ref.kind === 'remote' ? 'cloud' : ref.kind === 'head' ? 'arrow-right' : 'git-branch'} />{refLabel(ref.value)}</em>)}</div>;
}

function CommitMessage({ detail, expanded, toggle }: { detail: CommitDetail; expanded: boolean; toggle: () => void }) {
  const { t } = useI18n();
  const messageLines = detail.fullMessage.replace(/\r\n/g, '\n').split('\n');
  const body = messageLines[0]?.trim() === detail.commit.message.trim()
    ? messageLines.slice(1).join('\n').replace(/^\s*\n/, '').trimEnd()
    : detail.fullMessage.trim();
  const hasBody = body.length > 0;
  return <div className="detail-message-card">
    <div className="detail-message-title"><strong>{detail.commit.message}</strong>{hasBody && <button title={expanded ? t('Collapse') : t('Expand')} onClick={toggle}><Codicon name={expanded ? 'chevron-up' : 'chevron-down'} /></button>}</div>
    {expanded && hasBody && <pre>{body}</pre>}
  </div>;
}

function AuthorMeta({ commit }: { commit: CommitNode }) {
  return <div className="detail-author-meta"><span className="avatar" style={{ background: avatarColor(commit.email || commit.author) }}>{initials(commit.author)}</span><span className="detail-author-line"><strong>{commit.author}</strong><i>·</i><time>{formatDate(commit.authorDate || commit.committerDate)}</time><i>·</i><code><Codicon name="git-commit" />{commit.shortHash}</code></span></div>;
}

function MergeSection({ commit, details, files, openDiff, loadDetail }: { commit: CommitNode; details: Record<string, CommitDetail>; files: Record<string, DetailFileTarget[]>; openDiff: AppStore['openDiff']; loadDetail: AppStore['loadCommitDetail'] }) {
  const { t } = useI18n();
  const mergeValues = useAppStore((state) => state.mergeCommits[commitKey(commit.repoId, commit.hash)] ?? []);
  const loading = useAppStore((state) => state.mergeCommitsLoading[commitKey(commit.repoId, commit.hash)]);
  const [expandedHash, setExpandedHash] = useState<string>();
  if (commit.parents.length < 2) return null;
  return <section className="detail-merge-section">
    <header><Codicon name="git-merge" /><strong>{t('Merged commits')}</strong><b>{mergeValues.length}</b></header>
    {loading && <div className="detail-loading">{t('Loading...')}</div>}
    {!loading && !mergeValues.length && <div className="detail-loading">{t('No commits found')}</div>}
    {!loading && mergeValues.map((merge) => {
      const expanded = expandedHash === merge.hash;
      const key = commitKey(commit.repoId, merge.hash);
      const detail = details[key];
      const nestedCommit: CommitNode = detail?.commit ?? { repoId: commit.repoId, hash: merge.hash, shortHash: merge.shortHash, parents: [], author: merge.author, email: '', authorDate: merge.authorDate, committerDate: merge.authorDate, message: merge.message, refs: [] };
      const nestedFiles = files[key] ?? [];
      return <div key={merge.hash}>
        <button className={`merge-commit-row ${expanded ? 'expanded' : ''}`} onClick={() => { setExpandedHash(expanded ? undefined : merge.hash); if (!detail) void loadDetail(nestedCommit); }}>
          <Codicon name={expanded ? 'chevron-down' : 'chevron-right'} /><span className="merge-commit-hash"><Codicon name="git-commit" className="merge-commit-icon" /><code>{merge.shortHash}</code></span><span className="merge-commit-message">{merge.message}</span><small>{merge.author}</small>
        </button>
        {expanded && detail && <div className="merge-file-list">{nestedFiles.length ? nestedFiles.map((file) => <button key={file.path} className={`detail-file-row status-${statusClass(file.status)}`} title={file.path} onClick={() => openTarget(file, openDiff)}><FileIcon name={file.path.split('/').pop() ?? file.path} /><span className="detail-file-name">{file.path.split('/').pop() ?? file.path}</span>{file.added !== null && <b className="added">+{file.added}</b>}{file.removed !== null && <b className="removed">-{file.removed}</b>}<em>{file.status.slice(0, 1).toUpperCase()}</em></button>) : <div className="detail-loading">{t('No changed files')}</div>}</div>}
      </div>;
    })}
  </section>;
}

export function CommitDetailPanel({ onCollapse }: { onCollapse: () => void }) {
  const detail = useAppStore((state) => state.selectedCommit);
  const selectedCommits = useAppStore((state) => state.selectedCommits);
  const selectedDetails = useAppStore((state) => state.selectedCommitDetails);
  const loading = useAppStore((state) => Object.values(state.selectedCommitLoading).some(Boolean));
  const repositories = useAppStore((state) => state.snapshot?.repositories ?? []);
  const openDiff = useAppStore((state) => state.openDiff);
  const openChanges = useAppStore((state) => state.openCommitChanges);
  const loadMerge = useAppStore((state) => state.loadMergeCommits);
  const loadDetail = useAppStore((state) => state.loadCommitDetail);
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
  const mergeFiles = useMemo(() => {
    const values: Record<string, DetailFileTarget[]> = {};
    for (const [key, value] of Object.entries(selectedDetails)) values[key] = buildCommitFileTargets([value.commit], selectedDetails, repositories);
    return values;
  }, [repositories, selectedDetails]);

  useEffect(() => {
    if (detail && detail.commit.parents.length >= 2) void loadMerge(detail.commit);
  }, [detail, loadMerge]);

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

  if (!selectedCommits.length || (!detail && !loading)) return <aside className="commit-detail empty-detail"><Codicon name="git-commit" /><span>{t('Select a commit')}</span></aside>;

  const repoIds = [...targetsByRepo.keys()];
  const selectedPrimary = detail?.commit;
  const singleKey = selectedPrimary ? commitKey(selectedPrimary.repoId, selectedPrimary.hash) : '';
  const key = singleKey;
  const allMessagesExpanded = selectedCommits.length > 0 && selectedCommits.every((commit) => expandedMessages.has(commitKey(commit.repoId, commit.hash)));
  const toggleAllMessages = () => setExpandedMessages(allMessagesExpanded ? new Set() : new Set(selectedCommits.map((commit) => commitKey(commit.repoId, commit.hash))));
  const groupedTargets = repoIds.length > 1 ? [...targetsByRepo.entries()] : [[repoIds[0] ?? selectedPrimary?.repoId ?? '', targets]] as Array<[string, DetailFileTarget[]]>;
  const openPreview = () => { const target = targets[0]; if (target) openTarget(target, openDiff); };

  return <aside className="commit-detail">
    <section className="detail-file-section">
      <div className="detail-files-title"><strong>{targets.length} {t('files')}</strong><span className="detail-files-spacer" />{fileMode === 'tree' && <><button title={t('Expand all')} onClick={() => setAllTreeExpanded(true)}><Codicon name="expand-all" /></button><button title={t('Collapse all')} onClick={() => setAllTreeExpanded(false)}><Codicon name="collapse-all" /></button><i className="detail-view-divider" /></>}<button className={fileMode === 'tree' ? 'selected' : ''} title={t('Tree view')} onClick={() => { setFileMode('tree'); setAllTreeExpanded(null); }}><Codicon name="list-tree" /></button><button className={fileMode === 'list' ? 'selected' : ''} title={t('List view')} onClick={() => { setFileMode('list'); setAllTreeExpanded(null); }}><Codicon name="list-flat" /></button></div>
      <div className="detail-files">
        {loading && !targets.length && <div className="detail-loading">{t('Loading files...')}</div>}
        {fileMode === 'tree' ? groupedTargets.map(([repoId, files]) => <DetailRepoGroup key={repoId} files={files} repoName={repoMap.get(repoId)?.meta.name ?? repoId} repoColor={repoMap.get(repoId)?.meta.color} openDiff={openDiff} allExpanded={allTreeExpanded} clearAllExpanded={() => setAllTreeExpanded(null)} />) : targets.map((file) => <button key={`${file.repoId}:${file.path}`} className={`detail-file-row detail-list-row status-${statusClass(file.status)}`} onClick={() => openTarget(file, openDiff)}><FileIcon name={file.path.split('/').pop() ?? file.path} /><span className="detail-file-name">{file.path}</span>{selectedCommits.length > 1 && <small className="detail-repo-pill">{repoMap.get(file.repoId)?.meta.name ?? file.repoId}</small>}{file.added !== null && <b className="added">+{file.added}</b>}{file.removed !== null && <b className="removed">-{file.removed}</b>}<em>{file.status.slice(0, 1).toUpperCase()}</em></button>)}
      </div>
    </section>
    <div className="detail-info-resize" role="separator" aria-label={t('Resize commit detail')} onPointerDown={resizeInfo}><i /></div>
    <section className="detail-summary" style={infoHeight ? { height: infoHeight } : undefined}>
      <header className="detail-toolbar"><span className="detail-toolbar-label" style={selectedCommits.length === 1 ? { color: repoMap.get(selectedPrimary?.repoId ?? '')?.meta.color } : undefined}><Codicon name={selectedCommits.length > 1 ? 'git-commit' : 'repo'} />{selectedCommits.length > 1 ? t('Aggregated commit selection') : repoMap.get(selectedPrimary?.repoId ?? '')?.meta.name}</span><div className="detail-actions"><button disabled={!targets.length} title={t('Open preview')} onClick={openPreview}><Codicon name="open-preview" /></button><button title={t('Open Changes')} onClick={openChanges}><Codicon name="diff-multiple" /></button><button title={allMessagesExpanded ? t('Collapse commit messages by default') : t('Expand commit messages by default')} onClick={toggleAllMessages}><Codicon name={allMessagesExpanded ? 'collapse-all' : 'expand-all'} /></button><button title={t('Close commit detail')} onClick={onCollapse}><Codicon name="layout-sidebar-right" /></button></div></header>
      {selectedCommits.length > 1 ? <div className="detail-aggregate"><div className="detail-aggregate-meta"><div className="detail-aggregate-meta-row"><span>{t('{0} commits selected', selectedCommits.length)}</span><span>{t('repositories involved', new Set(selectedCommits.map((commit) => commit.repoId)).size)}</span></div><div className="detail-aggregate-meta-row"><span>{t('Selected time range')}</span><span>{formatDate(selectedCommits[selectedCommits.length - 1]?.authorDate ?? '')} - {formatDate(selectedCommits[0]?.authorDate ?? '')}</span></div></div>{selectedCommits.map((commit) => { const value = selectedDetails[commitKey(commit.repoId, commit.hash)]; const key = commitKey(commit.repoId, commit.hash); const repo = repoMap.get(commit.repoId); return <article className="aggregate-item" key={key}><div className="aggregate-repo"><Codicon name="repo" /><span style={{ color: repo?.meta.color }}>{repo?.meta.name ?? commit.repoId}</span></div>{value ? <><CommitMessage detail={value} expanded={expandedMessages.has(key)} toggle={() => setExpandedMessages((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; })} /><AuthorMeta commit={commit} /><RefBadges detail={value} /></> : <div className="detail-loading">{t('Loading files...')}</div>}</article>; })}</div> : detail && <div className="detail-single"><CommitMessage detail={detail} expanded={expandedMessages.has(singleKey)} toggle={() => setExpandedMessages((current) => { const next = new Set(current); if (next.has(singleKey)) next.delete(key); else next.add(key); return next; })} /><AuthorMeta commit={detail.commit} /><RefBadges detail={detail} /><MergeSection commit={detail.commit} details={selectedDetails} files={mergeFiles} openDiff={openDiff} loadDetail={loadDetail} /></div>}
    </section>
  </aside>;
}
