import { useEffect, useMemo, useState } from 'react';
import { Codicon } from './Codicon';
import { FileIcon } from './FileIcon';
import { useAppStore, type WorkingChangeTarget } from '../store/appStore';
import { useI18n } from '../i18n';
import type { DetailFileTarget } from '../history/commitDetails';
import { ContextMenu, type ContextMenuEntry } from './ContextMenu';
import { DiffPlaceholder } from './DiffPlaceholder';
import { UnifiedDiffView } from './UnifiedDiffView';

type ChangeTarget = DetailFileTarget | WorkingChangeTarget;

function isWorking(target: ChangeTarget): target is WorkingChangeTarget { return 'section' in target; }

function targetKey(target: ChangeTarget): string {
  return isWorking(target) ? `${target.repoId}\0${target.section}\0${target.path}` : `${target.repoId}\0${target.path}\0${target.fromRevision ?? ''}\0${target.toRevision ?? target.commitHash}`;
}

function statusClass(status: string): string {
  const value = status.slice(0, 1).toUpperCase();
  return value === 'A' ? 'added' : value === 'D' ? 'deleted' : value === 'R' ? 'renamed' : 'modified';
}

export function CommitChangesWorkspace() {
  const changes = useAppStore((state) => state.changes);
  const diff = useAppStore((state) => state.changesDiff);
  const loadDiff = useAppStore((state) => state.loadChangesDiff);
  const back = useAppStore((state) => state.backToHistory);
  const systemOpen = useAppStore((state) => state.systemOpen);
  const openFileHistory = useAppStore((state) => state.openFileHistory);
  const openHistoryForPath = useAppStore((state) => state.openHistoryForPath);
  const externalEditor = useAppStore((state) => state.bootstrap?.state.settings?.externalEditor ?? state.bootstrap?.state.externalEditor);
  const repositories = useAppStore((state) => state.snapshot?.repositories ?? []);
  const { t } = useI18n();
  const [selectedKey, setSelectedKey] = useState('');
  const [context, setContext] = useState<{ x: number; y: number; target: ChangeTarget }>();
  const selected = useMemo(
    () => changes?.files.find((target) => targetKey(target) === selectedKey) ?? changes?.files[0],
    [changes, selectedKey],
  );
  const repoNames = useMemo(() => Object.fromEntries(repositories.map((repo) => [repo.meta.id, repo.meta.name])), [repositories]);
  const oldRevision = selected
    ? isWorking(selected)
      ? 'HEAD'
      : selected.fromRevision ?? (selected.commitHash ? `${selected.commitHash}~1` : undefined)
    : undefined;
  const newRevision = selected
    ? isWorking(selected)
      ? undefined
      : selected.toRevision ?? selected.commitHash
    : undefined;
  const commitFiles = (commitHash: string, files: DetailFileTarget[]) => files.filter((target) => (target.commitHashes ?? [target.commitHash]).includes(commitHash));
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
  const runContext = (id: string) => {
    const target = context?.target;
    if (!target) return;
    if (id === 'diff') { setSelectedKey(targetKey(target)); void loadDiff(target); }
    if (id === 'history') openFileHistory(target.repoId, target.path);
    if (id === 'commit-history') void openHistoryForPath(target.repoId, target.path);
    if (id === 'open') void systemOpen(target.repoId, target.path, false);
    if (id === 'external') void systemOpen(target.repoId, target.path, false, true);
    if (id === 'reveal') void systemOpen(target.repoId, target.path, true);
    setContext(undefined);
  };

  useEffect(() => {
    if (!changes?.files.length) {
      return;
    }
    const first = changes.files[0];
    void loadDiff(first);
  }, [changes, loadDiff]);

  useEffect(() => {
    if (!selected || !changes?.files.length || targetKey(selected) === targetKey(changes.files[0])) return;
    void loadDiff(selected);
  }, [changes, loadDiff, selected]);

  if (!changes) return <div className="workspace-empty"><Codicon name="diff-multiple" />{t('Select a commit')}</div>;
  const title = changes.kind === 'workingTree' ? t('Working Tree Changes') : changes.commits.length === 1 ? changes.commits[0]?.message : `${changes.commits.length} ${t('commits')}`;
  return <section className="changes-workspace">
    <header>
      <button onClick={back}><Codicon name="arrow-left" />{t('Back to history')}</button>
      <span title={title}><Codicon name="diff-multiple" />{title}</span>
      <b>{changes.files.length} {t('files')}</b>
      {selected && externalEditor && <button title={t('Open in external editor')} onClick={() => void systemOpen(selected.repoId, selected.path, false, true)}><Codicon name="code" /></button>}
      {selected && <button title={t('Open')} onClick={() => void systemOpen(selected.repoId, selected.path, false)}><Codicon name="go-to-file" /></button>}
      {selected && <button title={t('Reveal')} onClick={() => void systemOpen(selected.repoId, selected.path, true)}><Codicon name="folder-opened" /></button>}
    </header>
    <div className="changes-columns">
      <aside className="changes-files">
        {changes.kind === 'commits' && repositories.map((repo) => {
          const files = changes.files.filter((target) => target.repoId === repo.meta.id);
          if (!files.length) return null;
          return <section key={repo.meta.id}>
            <h3><i style={{ background: repo.meta.color }} />{repo.meta.name}<b>{files.length}</b></h3>
            {changes.commits.filter((commit) => commit.repoId === repo.meta.id).map((commit) => {
              const groupedFiles = commitFiles(commit.hash, files);
              if (!groupedFiles.length) return null;
              return <div className="changes-commit-group" key={commit.hash}><h4><code>{commit.shortHash}</code><span>{commit.message}</span><b>{groupedFiles.length}</b></h4>{groupedFiles.map((target) => <button key={`${commit.hash}:${targetKey(target)}`} className={`changes-file-row ${selected && targetKey(target) === targetKey(selected) ? 'selected' : ''}`} onContextMenu={(event) => openContext(event, target)} onClick={() => { setSelectedKey(targetKey(target)); void loadDiff(target); }}>
                <FileIcon name={target.path.split('/').pop() ?? target.path} />
                <span className="changes-file-name">{target.path}</span>
                {target.added !== null && <em className="added">+{target.added}</em>}
                {target.removed !== null && <em className="removed">-{target.removed}</em>}
                <em className={`change-status ${statusClass(target.status)}`}>{target.status.slice(0, 1).toUpperCase()}</em>
              </button>)}</div>;
            })}
          </section>;
        })}
        {changes.kind === 'workingTree' && (['staged', 'unstaged', 'untracked'] as const).map((section) => {
          const files = changes.files.filter((target) => target.section === section);
          if (!files.length) return null;
          return <section key={section}><h3><Codicon name={section === 'staged' ? 'diff-added' : section === 'untracked' ? 'new-file' : 'diff'} />{t(section === 'staged' ? 'Staged Changes' : section === 'untracked' ? 'Untracked Files' : 'Unstaged Changes')}<b>{files.length}</b></h3>{files.map((target) => <button key={targetKey(target)} className={`changes-file-row ${selected && targetKey(target) === targetKey(selected) ? 'selected' : ''}`} onContextMenu={(event) => openContext(event, target)} onClick={() => { setSelectedKey(targetKey(target)); void loadDiff(target); }}><FileIcon name={target.path.split('/').pop() ?? target.path} /><span className="changes-file-name">{target.path}</span><em className={`change-status ${statusClass(target.status)}`}>{target.status.slice(0, 1).toUpperCase()}</em></button>)}</section>;
        })}
        {changes.kind === 'commits' && changes.files.some((target) => !repoNames[target.repoId]) && <section><h3><Codicon name="repo" />{t('Repository')}</h3>{changes.files.filter((target) => !repoNames[target.repoId]).map((target) => <button key={targetKey(target)} className="changes-file-row" onContextMenu={(event) => openContext(event, target)} onClick={() => { setSelectedKey(targetKey(target)); void loadDiff(target); }}><FileIcon name={target.path} /><span className="changes-file-name">{target.path}</span></button>)}</section>}
      </aside>
      <div className="changes-preview">
        {diff?.truncated ? <DiffPlaceholder kind="truncated" path={diff.path} lineCount={diff.lineCount} /> : diff?.binary ? <DiffPlaceholder kind="binary" path={diff.path} /> : selected && diff?.content ? <UnifiedDiffView repoId={selected.repoId} oldRevision={oldRevision} newRevision={newRevision} content={diff.content} path={diff.path} language={diff.language} /> : selected && diff ? <DiffPlaceholder kind="empty" path={diff.path} /> : <DiffPlaceholder kind="select" />}
      </div>
    </div>
    {context && <ContextMenu x={context.x} y={context.y} items={contextItems} onSelect={runContext} onClose={() => setContext(undefined)} />}
  </section>;
}
