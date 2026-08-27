import { useEffect, useState } from 'react';
import type { IgnoreRules } from '../bindings/generated';
import { useBridge } from '../platform/context';
import { useAppStore } from '../store/appStore';
import { useI18n } from '../i18n';
import { Codicon } from './Codicon';

export function IgnoreRulesPanel({ repoId, directory = '', close }: { repoId: string; directory?: string; close: () => void }) {
  const bridge = useBridge();
  const workspaceId = useAppStore((state) => state.snapshot?.workspace.id);
  const refresh = useAppStore((state) => state.refresh);
  const [rules, setRules] = useState<IgnoreRules>();
  const [text, setText] = useState('');
  const [error, setError] = useState<string>();
  const { t } = useI18n();
  useEffect(() => {
    if (!workspaceId) return;
    const controller = new AbortController();
    void bridge.request<IgnoreRules>({ type: 'ignoreRules', payload: { workspace_id: workspaceId, repo_id: repoId, directory } }, { signal: controller.signal })
      .then((value) => { setRules(value); setText(value.patterns.join('\n')); })
      .catch((reason) => { if (reason?.name !== 'AbortError') setError(String(reason)); });
    return () => controller.abort();
  }, [bridge, directory, repoId, workspaceId]);
  if (!workspaceId) return null;
  const save = async () => {
    try {
      setError(undefined);
      await bridge.request({ type: 'updateIgnoreRules', payload: { workspace_id: workspaceId, repo_id: repoId, directory, patterns: text.split('\n') } });
      await refresh();
      close();
    } catch (reason) { setError(String(reason)); }
  };
  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}><section className="app-dialog ignore-dialog" role="dialog" aria-modal="true" aria-label="Manage Ignore Rules"><header><Codicon name="exclude" /><strong>Manage Ignore Rules</strong></header><p>{rules ? `${rules.source}${rules.directory ? ` · ${rules.directory}` : ''}` : 'Loading…'}</p><label><span>One pattern per line</span><textarea autoFocus value={text} onChange={(event) => setText(event.target.value)} /></label>{error && <div className="error-row">{error}</div>}<footer><button onClick={close}>{t('Close')}</button><button className="primary" disabled={!rules} onClick={() => void save()}>{t('Save')}</button></footer></section></div>;
}

