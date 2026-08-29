import { useEffect, useState } from 'react';
import type { IgnoreRules } from '../bindings/generated';
import { useBridge } from '../platform/context';
import { useAppStore } from '../store/appStore';
import { useI18n } from '../i18n';
import { Codicon } from './Codicon';
import { isAbortError } from '../platform/bridge';

export function IgnoreRulesPanel({ repoId, directory = '', close }: { repoId: string; directory?: string; close: () => void }) {
  const bridge = useBridge();
  const workspaceId = useAppStore((state) => state.snapshot?.workspace.id);
  const refresh = useAppStore((state) => state.refresh);
  const [rules, setRules] = useState<IgnoreRules>();
  const [text, setText] = useState('');
  const [error, setError] = useState<string>();
  const { t } = useI18n();
  useEffect(() => {
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      trigger?.focus();
    };
  }, [close]);
  useEffect(() => {
    if (!workspaceId) return;
    const controller = new AbortController();
    void bridge.request<IgnoreRules>({ type: 'ignoreRules', payload: { workspace_id: workspaceId, repo_id: repoId, directory } }, { signal: controller.signal })
      .then((value) => { setRules(value); setText(value.patterns.join('\n')); })
      .catch((reason) => { if (!isAbortError(reason)) setError(String(reason)); });
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
  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}><section className="app-dialog ignore-dialog" role="dialog" aria-modal="true" aria-labelledby="ignore-rules-title"><header><Codicon name="exclude" /><strong id="ignore-rules-title">{t('Manage Ignore Rules')}</strong></header><p>{rules ? `${rules.source}${rules.directory ? ` · ${rules.directory}` : ''}` : t('Loading…')}</p><label><span>{t('One pattern per line')}</span><textarea aria-label={t('Ignore patterns')} autoFocus value={text} onChange={(event) => setText(event.target.value)} /></label>{error && <div className="error-row" role="alert">{error}</div>}<footer><button onClick={close}>{t('Close')}</button><button className="primary" disabled={!rules} onClick={() => void save()}>{t('Save')}</button></footer></section></div>;
}
