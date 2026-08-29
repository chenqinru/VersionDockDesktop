import { Codicon } from './Codicon';
import { isOperationActive, useAppStore } from '../store/appStore';
import { useI18n } from '../i18n';
import { confirmDialog } from './dialogService';
import { ContextMenu } from './ContextMenu';
import { useState } from 'react';

export function MergeWorkspace() {
  const merge = useAppStore((state) => state.merge);
  const result = useAppStore((state) => state.mergeResult);
  const setResult = useAppStore((state) => state.setMergeResult);
  const save = useAppStore((state) => state.saveMerge);
  const back = useAppStore((state) => state.backToHistory);
  const busy = useAppStore((state) => isOperationActive(state.operations, {
    repositoryId: state.selectedFile?.repoId,
    domain: 'conflict',
  }));
  const accept = useAppStore((state) => state.acceptConflict);
  const [context, setContext] = useState<{ x: number; y: number }>();
  const { t } = useI18n();
  if (!merge) return null;
  return <section className="merge-workspace">
    <header><button onClick={back}><Codicon name="arrow-left" />{t('Back to history')}</button><span><Codicon name="git-merge" />{merge.path}</span><button disabled={busy || merge.binary} className="primary" onClick={() => void save()}><Codicon name="save" />{t('Save resolution')}</button></header>
    {merge.binary ? <div className="workspace-empty conflict-choice"><Codicon name="file-binary" /><strong>{t('Binary conflict cannot be edited')}</strong><span>{t('Choose which complete version to keep.')}</span><div><button disabled={busy} onClick={() => void confirmDialog({ title: t('Keep mine and mark resolved?'), message: merge.path, danger: true }).then((yes) => { if (yes) return accept('mine'); })}>{t('Keep mine')}</button><button disabled={busy} onClick={() => void confirmDialog({ title: t('Keep theirs and mark resolved?'), message: merge.path, danger: true }).then((yes) => { if (yes) return accept('theirs'); })}>{t('Keep theirs')}</button><button disabled={busy} onClick={() => void confirmDialog({ title: t('Keep working file and mark resolved?'), message: merge.path, danger: true }).then((yes) => { if (yes) return accept('working'); })}>{t('Keep working')}</button></div></div> : <>
      <div className="merge-toolbar"><button onClick={() => setResult(merge.ours)}>{t('Apply ours')}</button><button onClick={() => setResult(merge.theirs)}>{t('Apply theirs')}</button><button onClick={() => setResult(merge.working)}>{t('Reset')}</button></div>
      <div className="merge-columns">
        <CodeColumn title={t('Ours')} value={merge.ours} apply={() => setResult(merge.ours)} /><div className="result-column"><strong>{t('Result')}</strong><textarea spellCheck={false} value={result} onContextMenu={(event) => { event.preventDefault(); setContext({ x: event.clientX, y: event.clientY }); }} onChange={(event) => setResult(event.target.value)} />{context && <ContextMenu x={context.x} y={context.y} items={[{ id: 'copy', label: t('Copy Result'), icon: 'copy' }, { id: 'reset', label: t('Reset'), icon: 'discard' }]} onSelect={(id) => { if (id === 'copy') void navigator.clipboard?.writeText(result).catch(() => undefined); else setResult(merge.working); setContext(undefined); }} onClose={() => setContext(undefined)} />}</div><CodeColumn title={t('Theirs')} value={merge.theirs} apply={() => setResult(merge.theirs)} />
      </div>
    </>}
  </section>;
}

function CodeColumn({ title, value, apply }: { title: string; value: string; apply: () => void }) {
  const [context, setContext] = useState<{ x: number; y: number }>();
  const { t } = useI18n();
  return <div className="merge-source"><strong>{title}</strong><pre onContextMenu={(event) => { event.preventDefault(); setContext({ x: event.clientX, y: event.clientY }); }}>{value}</pre>{context && <ContextMenu x={context.x} y={context.y} items={[{ id: 'apply', label: t('Apply {0}', title), icon: 'arrow-right' }, { id: 'copy', label: t('Copy {0}', title), icon: 'copy' }]} onSelect={(id) => { if (id === 'apply') apply(); else void navigator.clipboard?.writeText(value).catch(() => undefined); setContext(undefined); }} onClose={() => setContext(undefined)} />}</div>;
}
