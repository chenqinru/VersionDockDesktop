import { Codicon } from './Codicon';
import { useAppStore } from '../store/appStore';
import { useI18n } from '../i18n';

export function MergeWorkspace() {
  const merge = useAppStore((state) => state.merge);
  const result = useAppStore((state) => state.mergeResult);
  const setResult = useAppStore((state) => state.setMergeResult);
  const save = useAppStore((state) => state.saveMerge);
  const back = useAppStore((state) => state.backToHistory);
  const busy = useAppStore((state) => state.busy);
  const accept = useAppStore((state) => state.acceptConflict);
  const { t } = useI18n();
  if (!merge) return null;
  return <section className="merge-workspace">
    <header><button onClick={back}><Codicon name="arrow-left" />{t('Back to history')}</button><span><Codicon name="git-merge" />{merge.path}</span><button disabled={busy || merge.binary} className="primary" onClick={() => void save()}><Codicon name="save" />{t('Save resolution')}</button></header>
    {merge.binary ? <div className="workspace-empty conflict-choice"><Codicon name="file-binary" /><strong>{t('Binary conflict cannot be edited')}</strong><span>{t('Choose which complete version to keep.')}</span><div><button disabled={busy} onClick={() => { if (confirm(t('Keep mine and mark resolved?'))) void accept('mine'); }}>{t('Keep mine')}</button><button disabled={busy} onClick={() => { if (confirm(t('Keep theirs and mark resolved?'))) void accept('theirs'); }}>{t('Keep theirs')}</button><button disabled={busy} onClick={() => { if (confirm(t('Keep working file and mark resolved?'))) void accept('working'); }}>{t('Keep working')}</button></div></div> : <>
      <div className="merge-toolbar"><button onClick={() => setResult(merge.ours)}>{t('Apply ours')}</button><button onClick={() => setResult(merge.theirs)}>{t('Apply theirs')}</button><button onClick={() => setResult(merge.working)}>{t('Reset')}</button></div>
      <div className="merge-columns">
        <CodeColumn title={t('Ours')} value={merge.ours} /><div className="result-column"><strong>{t('Result')}</strong><textarea spellCheck={false} value={result} onChange={(event) => setResult(event.target.value)} /></div><CodeColumn title={t('Theirs')} value={merge.theirs} />
      </div>
    </>}
  </section>;
}

function CodeColumn({ title, value }: { title: string; value: string }) {
  return <div className="merge-source"><strong>{title}</strong><pre>{value}</pre></div>;
}
