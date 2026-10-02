import { IconButton } from './IconButton';
import { useEffect, useMemo, useState } from 'react';
import { Codicon } from './Codicon';
import { FileIcon } from './FileIcon';
import { buildFileTree, type FileTreeNode } from './fileTree';
import { useAppStore, type WorkingChangeTarget } from '../store/appStore';
import { useI18n } from '../i18n';
import type { DetailFileTarget } from '../history/commitDetails';
import { resolveDiffRevisions } from '../history/diffRevisions';
import { ContextMenu, type ContextMenuEntry } from './ContextMenu';
import { DiffPlaceholder } from './DiffPlaceholder';
import { UnifiedDiffView } from './UnifiedDiffView';

type ChangeTarget = DetailFileTarget | WorkingChangeTarget;

function isWorking(target: ChangeTarget): target is WorkingChangeTarget { return 'section' in target; }

function targetKey(target: ChangeTarget): string {
  return isWorking(target) ? `${target.repoId}\0${target.section}\0${target.path}` : `${target.repoId}\0${target.path}\0${target.fromRevision ?? ''}\0${target.toRevision ?? target.commitHash}`;
}

function fileGroupKey(target: ChangeTarget): string {
  return `${target.repoId}\0${isWorking(target) ? target.section : 'commits'}`;
}

const fileViewPreference = 'versiondock:changesFileView';

function statusClass(status: string): string {
  const value = status.slice(0, 1).toUpperCase();
  return value === 'A' ? 'added' : value === 'D' ? 'deleted' : value === 'R' ? 'renamed' : 'modified';
}

export function CommitChangesWorkspace() {
  const changes = useAppStore((state) => state.changes);
  const diff = useAppStore((state) => state.changesDiff);
  const diffLoading = useAppStore((state) => state.changesDiffLoading);
  const diffError = useAppStore((state) => state.changesDiffError);
  const diffTarget = useAppStore((state) => state.changesDiffTarget);
  const loadDiff = useAppStore((state) => state.loadChangesDiff);
  const back = useAppStore((state) => state.backToHistory);
  const systemOpen = useAppStore((state) => state.systemOpen);
  const openFileHistory = useAppStore((state) => state.openFileHistory);
  const openHistoryForPath = useAppStore((state) => state.openHistoryForPath);
  const externalEditor = useAppStore((state) => state.bootstrap?.state.settings?.externalEditor ?? state.bootstrap?.state.externalEditor);
  const repositories = useAppStore((state) => state.snapshot?.repositories ?? []);
  const { t } = useI18n();
  const [selectedKey, setSelectedKey] = useState('');
  const [fileMode, setFileMode] = useState<'tree' | 'list'>(() => {
    try { return localStorage.getItem(fileViewPreference) === 'tree' ? 'tree' : 'list'; } catch { return 'list'; }
  });
  const [allExpanded, setAllExpanded] = useState(true);
  const [collapsedDirs, setCollapsedDirs] = useState<Record<string, boolean>>({});
  const trees = useMemo(() => {
    const groups = new Map<string, ChangeTarget[]>();
    for (const target of changes?.files ?? []) {
      const key = fileGroupKey(target);
      const files = groups.get(key) ?? [];
      files.push(target);
      groups.set(key, files);
    }
    return new Map([...groups].map(([key, files]) => [key, buildFileTree(files)]));
  }, [changes?.files]);
  useEffect(() => {
    try { localStorage.setItem(fileViewPreference, fileMode); } catch { /* Keep switching available without storage. */ }
  }, [fileMode]);
  const switchFileMode = (mode: 'tree' | 'list') => {
    setFileMode(mode);
    if (mode === 'tree') { setAllExpanded(true); setCollapsedDirs({}); }
  };
  const expandAll = (expanded: boolean) => { setAllExpanded(expanded); setCollapsedDirs({}); };
  const [context, setContext] = useState<{ x: number; y: number; target: ChangeTarget }>();
  const selected = useMemo(
    () => changes?.files.find((target) => targetKey(target) === selectedKey) ?? changes?.files[0],
    [changes, selectedKey],
  );
  const currentSelectedKey = selected ? targetKey(selected) : '';
  const isDiffMatchingSelected = Boolean(
    selected
    && diff
    && (!diffTarget || diffTarget === currentSelectedKey)
    && diff.path === selected.path
  );
  const repoNames = useMemo(() => Object.fromEntries(repositories.map((repo) => [repo.meta.id, repo.meta.name])), [repositories]);
  const selectedCommit = selected && !isWorking(selected) && changes?.kind === 'commits' ? changes.commits.find((commit) => commit.repoId === selected.repoId && commit.hash === selected.commitHash) : undefined;
  const selectedRepoKind = repositories.find((repo) => repo.meta.id === selected?.repoId)?.meta.kind ?? 'git';
  const { oldRevision, newRevision } = resolveDiffRevisions(selectedRepoKind, selected
    ? isWorking(selected) ? selected : { revision: selected.commitHash, fromRevision: selected.fromRevision, toRevision: selected.toRevision }
    : {}, selectedCommit);
  const openContext = (event: React.MouseEvent, target: ChangeTarget) => { event.preventDefault(); event.stopPropagation(); setContext({ x: event.clientX, y: event.clientY, target }); };
  const contextItems: ContextMenuEntry[] = [
    { id: 'diff', label: t('Show Diff'), icon: 'diff' },
    { id: 'history', label: t('File history'), icon: 'history' },
    { id: 'commit-history', label: t('Show in commit history'), icon: 'git-commit' },
    { separator: true },
    { id: 'open', label: t('Open'), icon: 'go-to-file' },
    ...(externalEditor ? [{ id: 'external', label: t('Open in external editor'), icon: 'code' } as ContextMenuEntry] : []),
    { id: 'reveal', label: t('Reveal'), icon: 'folder-opened' },
  ];
  const handleSelect = (target: ChangeTarget) => {
    const key = targetKey(target);
    if (key === currentSelectedKey) {
      if (diffLoading && diffTarget === key) return;
      if (diffError || !isDiffMatchingSelected) {
        void loadDiff(target);
      }
    } else {
      setSelectedKey(key);
    }
  };

  const renderFile = (target: ChangeTarget, depth?: number) => <button key={targetKey(target)} title={target.path} aria-label={target.path} aria-current={targetKey(target) === currentSelectedKey ? 'true' : undefined} style={depth === undefined ? undefined : { paddingLeft: 28 + depth * 14 }} className={`changes-file-row ${targetKey(target) === currentSelectedKey ? 'selected' : ''}`} onContextMenu={(event) => openContext(event, target)} onClick={() => handleSelect(target)}>
    <FileIcon name={target.path.split('/').pop() ?? target.path} />
    <span className="changes-file-name" title={target.path}>{depth === undefined ? target.path : target.path.split('/').pop()}</span>
    {!isWorking(target) && target.added !== null && <em className="added">+{target.added}</em>}
    {!isWorking(target) && target.removed !== null && <em className="removed">-{target.removed}</em>}
    <em className={`change-status ${statusClass(target.status)}`}>{target.status.slice(0, 1).toUpperCase()}</em>
  </button>;

  const renderTree = (nodes: FileTreeNode<ChangeTarget>[], groupKey: string, depth = 0): React.ReactNode => nodes.map((node) => {
    if (node.file) return renderFile(node.file, depth);
    const key = `${groupKey}\0${node.path}`;
    const expanded = collapsedDirs[key] === undefined ? allExpanded : !collapsedDirs[key];
    return <div key={key} className="changes-directory">
      <button className="changes-file-row changes-directory-row" style={{ paddingLeft: 8 + depth * 14 }} title={node.path} aria-label={node.path} aria-expanded={expanded} onClick={() => setCollapsedDirs((current) => ({ ...current, [key]: expanded }))}>
        <Codicon name={expanded ? 'chevron-down' : 'chevron-right'} />
        <FileIcon name={node.name} folder open={expanded} />
        <span className="changes-file-name">{node.name}</span>
        <b>{node.files.length}</b>
      </button>
      {expanded && <div role="group" aria-label={node.path}>{renderTree(node.children, groupKey, depth + 1)}</div>}
    </div>;
  });
  const renderFiles = (files: ChangeTarget[]) => fileMode === 'list'
    ? files.map((target) => renderFile(target))
    : [...new Set(files.map(fileGroupKey))].map((key) => <div key={key}>{renderTree(trees.get(key) ?? [], key)}</div>);

  const runContext = (id: string) => {
    const target = context?.target;
    if (!target) return;
    if (id === 'diff') handleSelect(target);
    if (id === 'history') openFileHistory(target.repoId, target.path);
    if (id === 'commit-history') void openHistoryForPath(target.repoId, target.path);
    if (id === 'open') void systemOpen(target.repoId, target.path, false);
    if (id === 'external') void systemOpen(target.repoId, target.path, false, true);
    if (id === 'reveal') void systemOpen(target.repoId, target.path, true);
    setContext(undefined);
  };

  useEffect(() => {
    if (!selected) return;
    void loadDiff(selected);
  }, [loadDiff, selected]);

  if (!changes) return <div className="workspace-empty"><Codicon name="diff-multiple" />{t('Select a commit')}</div>;
  const title = changes.kind === 'workingTree' ? t('Working Tree Changes') : changes.commits.length === 1 ? changes.commits[0]?.message : `${changes.commits.length} ${t('commits')}`;
  return <section className="changes-workspace">
    <header>
      <button onClick={back}><Codicon name="arrow-left" />{t('Back to history')}</button>
      <span title={title}><Codicon name="diff-multiple" />{title}</span>
      <b>{changes.files.length} {t('files')}</b>
      {selected && externalEditor && <IconButton title={t('Open in external editor')} onClick={() => void systemOpen(selected.repoId, selected.path, false, true)}><Codicon name="code" /></IconButton>}
      {selected && <IconButton title={t('Open')} onClick={() => void systemOpen(selected.repoId, selected.path, false)}><Codicon name="go-to-file" /></IconButton>}
      {selected && <IconButton title={t('Reveal')} onClick={() => void systemOpen(selected.repoId, selected.path, true)}><Codicon name="folder-opened" /></IconButton>}
    </header>
    <div className="changes-columns">
      <aside className="changes-files">
        <div className="changes-files-toolbar">
          <span>{t('Changed files')}</span>
          {fileMode === 'tree' && <>
            <IconButton title={t('Expand all')} onClick={() => expandAll(true)}><Codicon name="expand-all" /></IconButton>
            <IconButton title={t('Collapse all')} onClick={() => expandAll(false)}><Codicon name="collapse-all" /></IconButton>
            <span className="detail-view-divider" />
          </>}
          <IconButton title={t('Tree view')} className={fileMode === 'tree' ? 'selected' : ''} aria-pressed={fileMode === 'tree'} onClick={() => switchFileMode('tree')}><Codicon name="list-tree" /></IconButton>
          <IconButton title={t('Flat list')} className={fileMode === 'list' ? 'selected' : ''} aria-pressed={fileMode === 'list'} onClick={() => switchFileMode('list')}><Codicon name="list-flat" /></IconButton>
        </div>
        <div className="changes-files-content">
          {changes.kind === 'commits' && repositories.map((repo) => {
            const files = changes.files.filter((target) => target.repoId === repo.meta.id);
            if (!files.length) return null;
            const repoCommits = changes.commits.filter((commit) => commit.repoId === repo.meta.id);
            return <section key={repo.meta.id}>
              <h3><i style={{ background: repo.meta.color }} />{repo.meta.name}<b>{files.length}</b></h3>
              <div className="changes-commit-group">
                <h4 title={repoCommits.map((commit) => `${commit.shortHash} ${commit.message}`).join('\n')}>
                  {repoCommits.length === 1
                    ? <><code>{repoCommits[0]?.shortHash}</code><span>{repoCommits[0]?.message}</span></>
                    : <><Codicon name="diff-multiple" /><span>{t('Aggregated commit selection')}</span><b>{repoCommits.length} {t('commits')}</b></>}
                </h4>
                {renderFiles(files)}
              </div>
            </section>;
          })}
          {changes.kind === 'workingTree' && (['staged', 'unstaged', 'untracked'] as const).map((section) => {
            const files = changes.files.filter((target) => target.section === section);
            if (!files.length) return null;
            return <section key={section}><h3><Codicon name={section === 'staged' ? 'diff-added' : section === 'untracked' ? 'new-file' : 'diff'} />{t(section === 'staged' ? 'Staged Changes' : section === 'untracked' ? 'Untracked Files' : 'Unstaged Changes')}<b>{files.length}</b></h3>{renderFiles(files)}</section>;
          })}
          {changes.kind === 'commits' && changes.files.some((target) => !repoNames[target.repoId]) && <section><h3><Codicon name="repo" />{t('Repository')}</h3>{renderFiles(changes.files.filter((target) => !repoNames[target.repoId]))}</section>}
        </div>
      </aside>
      <div className="changes-preview">
        {selected && <header className="changes-preview-header">
          <div className="diff-file-heading" title={selected.path}><FileIcon name={selected.path.split('/').pop() ?? selected.path} /><span className="diff-file-path">{selected.path}</span></div>
          <span className="changes-preview-revisions" title={`${oldRevision ?? ''} → ${newRevision ?? ''}`}>{oldRevision?.length && oldRevision.length > 12 ? oldRevision.slice(0, 8) : oldRevision} → {newRevision?.length && newRevision.length > 12 ? newRevision.slice(0, 8) : newRevision}</span>
        </header>}
        {diffLoading ? (
          <DiffPlaceholder kind="loading" path={selected?.path} />
        ) : diffError && (!diff || diffTarget === currentSelectedKey) ? (
          <DiffPlaceholder
            kind="error"
            path={selected?.path}
            error={diffError}
            onRetry={() => selected && void loadDiff(selected)}
          />
        ) : isDiffMatchingSelected && diff && selected ? (
          diff.truncated ? (
            <DiffPlaceholder kind="truncated" path={diff.path} lineCount={diff.lineCount} />
          ) : diff.binary ? (
             <DiffPlaceholder kind="binary" path={diff.path} />
          ) : diff.content ? (
            <UnifiedDiffView repoId={selected.repoId} oldRevision={oldRevision} newRevision={newRevision} content={diff.content} path={diff.path} language={diff.language} />
          ) : (
            <DiffPlaceholder kind="empty" path={diff.path} />
          )
        ) : selected ? (
          <DiffPlaceholder kind="loading" path={selected.path} />
        ) : (
          <DiffPlaceholder kind="select" />
        )}
      </div>
    </div>
    {context && <ContextMenu x={context.x} y={context.y} items={contextItems} onSelect={runContext} onClose={() => setContext(undefined)} />}
  </section>;
}
