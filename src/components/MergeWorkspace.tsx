import { useEffect, useMemo, useRef, useState } from 'react';
import { Codicon } from './Codicon';
import { isOperationActive, useAppStore } from '../store/appStore';
import { useI18n } from '../i18n';
import { buildMergeContent, mergeCounts, type MergeResolution, type NonConflictScope } from './mergeEditorModel';

export function MergeWorkspace() {
  const merge = useAppStore((state) => state.merge);
  const result = useAppStore((state) => state.mergeResult);
  const setResult = useAppStore((state) => state.setMergeResult);
  const save = useAppStore((state) => state.saveMerge);
  const back = useAppStore((state) => state.backToHistory);
  const busy = useAppStore((state) => isOperationActive(state.operations, { repositoryId: state.selectedFile?.repoId, domain: 'conflict' }));
  const accept = useAppStore((state) => state.acceptConflict);
  const [mergeKey, setMergeKey] = useState(merge?.fingerprint);
  const [resolutions, setResolutions] = useState<Record<number, MergeResolution>>(() => Object.fromEntries((merge?.conflicts ?? []).map((conflict) => [conflict.index, 'unresolved'])));
  const [scope, setScope] = useState<NonConflictScope>('all');
  const [current, setCurrent] = useState(0);
  const [syncScroll, setSyncScroll] = useState(true);
  const conflictRefs = useRef<Record<number, HTMLElement | null>>({});
  const paneRefs = useRef<Array<HTMLDivElement | null>>([]);
  const syncing = useRef(false);
  const { t } = useI18n();

  if (merge && mergeKey !== merge.fingerprint) {
    setMergeKey(merge.fingerprint);
    setResolutions(Object.fromEntries(merge.conflicts.map((conflict) => [conflict.index, 'unresolved'])));
    setScope('all');
    setCurrent(0);
  }
  useEffect(() => {
    if (merge && !merge.binary) setResult(buildMergeContent(merge, resolutions, scope));
  }, [merge, resolutions, scope, setResult]);

  const unresolved = useMemo(() => merge?.conflicts.map((item) => item.index).filter((index) => (resolutions[index] ?? 'unresolved') === 'unresolved') ?? [], [merge, resolutions]);
  const counts = useMemo(() => merge ? mergeCounts(merge) : { compatible: false, conflicts: 0, nonConflicting: 0 }, [merge]);
  if (!merge) return null;
  const go = (direction: -1 | 1) => {
    const next = direction < 0 ? [...unresolved].reverse().find((index) => index < current) : unresolved.find((index) => index > current);
    if (next === undefined) return;
    setCurrent(next);
    conflictRefs.current[next]?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };
  const update = (index: number, resolution: MergeResolution) => {
    setCurrent(index);
    setResolutions((values) => ({ ...values, [index]: resolution }));
  };
  const onPaneScroll = (source: number) => (event: React.UIEvent<HTMLDivElement>) => {
    if (!syncScroll || syncing.current) return;
    syncing.current = true;
    const element = event.currentTarget;
    const ratio = element.scrollTop / Math.max(1, element.scrollHeight - element.clientHeight);
    const groupStart = Math.floor(source / 3) * 3;
    paneRefs.current.forEach((pane, index) => {
      if (pane && index !== source && index >= groupStart && index < groupStart + 3) pane.scrollTop = ratio * Math.max(0, pane.scrollHeight - pane.clientHeight);
    });
    requestAnimationFrame(() => { syncing.current = false; });
  };
  return <section className="merge-workspace advanced-merge-workspace">
    <header><button onClick={back}><Codicon name="arrow-left" />{t('Back to history')}</button><span><Codicon name="git-merge" />{merge.path}</span><span className="merge-counts">{t('{0} conflicts remaining', unresolved.length)} · {t('{0} non-conflicting changes', counts.nonConflicting)}</span><button disabled={busy || merge.binary || unresolved.length > 0} className="primary" onClick={() => void save()}><Codicon name="save" />{t('Save resolution')}</button></header>
    {merge.binary ? <div className="workspace-empty conflict-choice"><Codicon name="file-binary" /><strong>{t('Binary conflict cannot be edited')}</strong><span>{t('Choose which complete version to keep.')}</span><div><button disabled={busy} onClick={() => void accept('mine')}>{t('Keep mine')}</button><button disabled={busy} onClick={() => void accept('theirs')}>{t('Keep theirs')}</button><button disabled={busy} onClick={() => void accept('working')}>{t('Keep working')}</button></div></div> : <>
      <div className="merge-toolbar advanced"><button disabled={!unresolved.some((index) => index < current)} onClick={() => go(-1)}>↑ {t('Previous Unresolved Conflict')}</button><button disabled={!unresolved.some((index) => index > current)} onClick={() => go(1)}>↓ {t('Next Unresolved Conflict')}</button><span />{(['left', 'all', 'right', 'base'] as const).map((value) => <button key={value} disabled={!counts.compatible} className={scope === value ? 'active' : ''} onClick={() => setScope(value)}>{t(value === 'left' ? 'Apply Left Changes' : value === 'right' ? 'Apply Right Changes' : value === 'all' ? 'Apply All Non-conflicting Changes' : 'Restore Non-conflicting Changes to Base')}</button>)}<label><input type="checkbox" checked={syncScroll} onChange={(event) => setSyncScroll(event.target.checked)} />{t('Synchronous Scrolling')}</label></div>
      {!counts.compatible && <div className="merge-warning">{t('Three-way non-conflicting analysis is unavailable; conflict blocks can still be resolved.')}</div>}
      <div className="merge-conflict-list">
        {merge.conflicts.map((conflict) => {
          const resolution = resolutions[conflict.index] ?? 'unresolved';
          const custom = typeof resolution === 'object' ? resolution.lines.join('\n') : resolution === 'ours' ? conflict.oursLines.join('\n') : resolution === 'theirs' ? conflict.theirsLines.join('\n') : resolution === 'both' ? [...conflict.oursLines, ...conflict.theirsLines].join('\n') : conflict.baseLines.join('\n');
          return <article key={conflict.index} ref={(element) => { conflictRefs.current[conflict.index] = element; }} className={`merge-conflict-block ${resolution === 'unresolved' ? 'unresolved' : 'resolved'} ${current === conflict.index ? 'current' : ''}`} onClick={() => setCurrent(conflict.index)}><div className="merge-conflict-heading"><strong>{t('Conflict {0}', conflict.index + 1)}</strong><div><button className={resolution === 'ours' ? 'active' : ''} onClick={() => update(conflict.index, 'ours')}>{t('Ours')}</button><button className={resolution === 'both' ? 'active' : ''} onClick={() => update(conflict.index, 'both')}>{t('Both')}</button><button className={resolution === 'theirs' ? 'active' : ''} onClick={() => update(conflict.index, 'theirs')}>{t('Theirs')}</button><button onClick={() => update(conflict.index, 'unresolved')}>{t('Reset')}</button></div></div><div className="merge-block-columns"><div ref={(element) => { paneRefs.current[conflict.index * 3] = element; }} onScroll={onPaneScroll(conflict.index * 3)}><strong>{conflict.oursLabel || t('Ours')}</strong><pre>{conflict.oursLines.join('\n')}</pre></div><div ref={(element) => { paneRefs.current[conflict.index * 3 + 1] = element; }} onScroll={onPaneScroll(conflict.index * 3 + 1)}><strong>{t('Result')}</strong><textarea aria-label={`${t('Conflict')} ${conflict.index + 1}`} value={custom} onChange={(event) => update(conflict.index, { type: 'custom', lines: event.target.value.split('\n') })} /></div><div ref={(element) => { paneRefs.current[conflict.index * 3 + 2] = element; }} onScroll={onPaneScroll(conflict.index * 3 + 2)}><strong>{conflict.theirsLabel || t('Theirs')}</strong><pre>{conflict.theirsLines.join('\n')}</pre></div></div>{conflict.baseLines.length > 0 && <details><summary>{t('Base')}</summary><pre>{conflict.baseLines.join('\n')}</pre></details>}</article>;
        })}
      </div>
      <details className="merge-result-preview"><summary>{t('Resolved file preview')}</summary><pre>{result}</pre></details>
    </>}
  </section>;
}
