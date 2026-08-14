import { useEffect, useMemo, useState } from 'react';
import { codeToHtml } from 'shiki';
import { Codicon } from './Codicon';
import { FileIcon } from './FileIcon';
import { useAppStore } from '../store/appStore';
import { useI18n } from '../i18n';
import type { DetailFileTarget } from '../history/commitDetails';

function targetKey(target: DetailFileTarget): string {
  return `${target.repoId}\0${target.path}\0${target.fromRevision ?? ''}\0${target.toRevision ?? target.commitHash}`;
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
  const externalEditor = useAppStore((state) => state.bootstrap?.state.externalEditor);
  const repositories = useAppStore((state) => state.snapshot?.repositories ?? []);
  const { t } = useI18n();
  const [selectedKey, setSelectedKey] = useState('');
  const [html, setHtml] = useState('');
  const selected = useMemo(
    () => changes?.files.find((target) => targetKey(target) === selectedKey) ?? changes?.files[0],
    [changes, selectedKey],
  );
  const repoNames = useMemo(() => Object.fromEntries(repositories.map((repo) => [repo.meta.id, repo.meta.name])), [repositories]);
  const commitFiles = (commitHash: string, files: DetailFileTarget[]) => files.filter((target) => (target.commitHashes ?? [target.commitHash]).includes(commitHash));

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

  useEffect(() => {
    let active = true;
    if (!diff?.content) {
      return () => { active = false; };
    }
    void codeToHtml(diff.content, { lang: diff.language || 'text', theme: document.documentElement.dataset.theme === 'light' ? 'light-plus' : 'dark-plus' })
      .then((value) => { if (active) setHtml(value); })
      .catch(() => { if (active) setHtml(''); });
    return () => { active = false; };
  }, [diff?.content, diff?.language]);

  if (!changes) return <div className="workspace-empty"><Codicon name="diff-multiple" />{t('Select a commit')}</div>;
  const title = changes.commits.length === 1 ? changes.commits[0]?.message : `${changes.commits.length} ${t('commits')}`;
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
        {repositories.map((repo) => {
          const files = changes.files.filter((target) => target.repoId === repo.meta.id);
          if (!files.length) return null;
          return <section key={repo.meta.id}>
            <h3><i style={{ background: repo.meta.color }} />{repo.meta.name}<b>{files.length}</b></h3>
            {changes.commits.filter((commit) => commit.repoId === repo.meta.id).map((commit) => {
              const groupedFiles = commitFiles(commit.hash, files);
              if (!groupedFiles.length) return null;
              return <div className="changes-commit-group" key={commit.hash}><h4><code>{commit.shortHash}</code><span>{commit.message}</span><b>{groupedFiles.length}</b></h4>{groupedFiles.map((target) => <button key={`${commit.hash}:${targetKey(target)}`} className={`changes-file-row ${selected && targetKey(target) === targetKey(selected) ? 'selected' : ''}`} onClick={() => { setSelectedKey(targetKey(target)); void loadDiff(target); }}>
                <FileIcon name={target.path.split('/').pop() ?? target.path} />
                <span className="changes-file-name">{target.path}</span>
                {target.added !== null && <em className="added">+{target.added}</em>}
                {target.removed !== null && <em className="removed">-{target.removed}</em>}
                <em className={`change-status ${statusClass(target.status)}`}>{target.status.slice(0, 1).toUpperCase()}</em>
              </button>)}</div>;
            })}
          </section>;
        })}
        {changes.files.some((target) => !repoNames[target.repoId]) && <section><h3><Codicon name="repo" />{t('Repository')}</h3>{changes.files.filter((target) => !repoNames[target.repoId]).map((target) => <button key={targetKey(target)} className="changes-file-row" onClick={() => { setSelectedKey(targetKey(target)); void loadDiff(target); }}><FileIcon name={target.path} /><span className="changes-file-name">{target.path}</span></button>)}</section>}
      </aside>
      <div className="changes-preview">
        {selected && diff?.content && !diff.truncated && !diff.binary ? <div className="code-view" dangerouslySetInnerHTML={{ __html: html }} /> : <div className="workspace-empty"><Codicon name={diff?.binary ? 'file-binary' : diff?.truncated ? 'warning' : 'diff'} />{diff?.binary ? t('Binary diff cannot be displayed') : diff?.truncated ? t('Diff is too large to display') : t('Select a changed file to inspect its diff.')}</div>}
      </div>
    </div>
  </section>;
}
