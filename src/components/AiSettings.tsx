import { DialogSurface } from './DialogSurface';
import { SettingSelect } from './SettingSelect';
import { SettingsCard, SettingNumber, SettingText } from './SettingsControls';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AiConfig, AiRuntime, AiTask, AiPrompt } from '../bindings/generated';
import { useAppStore } from '../store/appStore';
import { useI18n } from '../i18n';
import { Codicon } from './Codicon';
import { aiErrorText } from '../ai/errors';
import { IconButton } from './IconButton';
import { type SettingPath, effectiveAiConfig } from '../settings/defaults';

export function AiSettings({ focusSetting }: { focusSetting?: SettingPath } = {}) {
  const { t } = useI18n();
  const storedConfig = useAppStore((s) => s.bootstrap?.state.settings?.aiConfig);
  const config = useMemo(() => effectiveAiConfig(storedConfig), [storedConfig]);
  const update = useAppStore((s) => s.updateSettings);
  const bridge = useAppStore((s) => s.bridge);
  const [secretState, setSecretState] = useState({ owner: '', text: '' });
  const credentialOwner = `${config.provider}:${config.apiUrl}`;
  const secret = secretState.owner === credentialOwner ? secretState.text : '';
  const setSecret = (text: string) => setSecretState({ owner: credentialOwner, text });
  const runtimeKey = JSON.stringify(config);
  const detectionEpoch = useRef(0);
  const [runtimeState, setRuntimeState] = useState<{ key: string; value: AiRuntime }>();
  const runtime = runtimeState?.key === runtimeKey ? runtimeState.value : undefined;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [prompt, setPrompt] = useState<AiTask>();
  const inspectedCli = focusSetting?.startsWith('aiConfig.cliExecutablePaths.') ? focusSetting.split('.').at(-1)! : config.cliProvider;
  const showCli = config.executionMode === 'agent-cli' || focusSetting?.startsWith('aiConfig.cli');
  const showProvider = config.executionMode === 'provider' || Boolean(focusSetting && !focusSetting.startsWith('aiConfig.cli'));
  const save = (patch: Partial<AiConfig>) => void update({ aiConfig: { ...config, ...patch } });
  const check = async (refreshKey = false) => {
    if (!bridge) return;
    const epoch = ++detectionEpoch.current;
    setBusy(true);
    setError('');
    try {
      const value = await bridge.request<AiRuntime>({ type: refreshKey ? 'aiRefreshKey' : 'aiRuntime' });
      if (epoch === detectionEpoch.current) setRuntimeState({ key: runtimeKey, value });
    } catch (e) {
      if (epoch === detectionEpoch.current) setError(aiErrorText(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    let active = true;
    const epoch = ++detectionEpoch.current;
    const control = new AbortController();
    void bridge
      ?.request<AiRuntime>({ type: 'aiRuntime' }, { signal: control.signal })
      .then((value) => {
        if (active && epoch === detectionEpoch.current) setRuntimeState({ key: runtimeKey, value });
      })
      .catch(e => { if (active && epoch === detectionEpoch.current) setError(aiErrorText(e)); });
    return () => {
      active = false;
      control.abort();
    };
  }, [bridge, runtimeKey]);
  const saveKey = async (remove = false) => {
    if (!bridge) return;
    setBusy(true);
    setError('');
    try {
      await bridge.request({
        type: 'aiSaveKey',
        payload: { provider: config.provider, api_url: config.apiUrl, key: remove ? null : secret },
      });
      setSecret('');
      if (JSON.stringify(effectiveAiConfig(useAppStore.getState().bootstrap?.state.settings?.aiConfig)) === runtimeKey) await check();
    } catch (e) {
      setError(aiErrorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="ai-settings">
      <SettingsCard title={t('AI execution')}>
        <SettingSelect setting="aiConfig.executionMode" label={t('Execution mode')} value={config.executionMode} options={[["provider", t('API provider')], ["agent-cli", t('Agent CLI')]]} onChange={executionMode => save({ executionMode })} />
        {showProvider && (
          <>
            <SettingSelect setting="aiConfig.provider" label={t('Provider')} value={config.provider} options={['openai', 'claude', 'gemini', 'custom'].map(p => [p, p === 'custom' ? t('Custom') : p === 'openai' ? 'OpenAI' : p === 'claude' ? 'Claude' : 'Gemini'])} onChange={provider => { setSecret(''); save({ provider, apiUrl: '', model: '' }); }} />
            {(['openai', 'custom'].includes(config.provider) || focusSetting === 'aiConfig.apiProtocol') && (
              <SettingSelect setting="aiConfig.apiProtocol" label={t('API protocol')} value={config.apiProtocol} options={[["chat-completions", t('Chat Completions')], ["responses", t('Responses')]]} onChange={apiProtocol => save({ apiProtocol })} />
            )}
            <SettingText setting="aiConfig.apiUrl" label={t('API URL')} value={config.apiUrl} spellCheck={false}
              placeholder={config.provider === 'claude' ? 'https://api.anthropic.com/v1/messages' : config.provider === 'gemini' ? 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions' : 'https://api.openai.com/v1'}
              onChange={e => save({ apiUrl: e.target.value })} />
            <SettingText setting="aiConfig.model" label={t('Model')} value={config.model} placeholder={t('Enter a model ID')} onChange={e => save({ model: e.target.value })} />
            <SettingText label={t('API key')} type="password" autoComplete="new-password" spellCheck={false} value={secret}
              placeholder={runtime?.keySaved ? t('Key saved in system secure storage') : t('Enter API key')}
              onChange={e => setSecret(e.target.value)}
              actions={<>
                <button className="settings-action-btn" disabled={busy || !secret.trim()} onClick={() => void saveKey()}>{t('Save key')}</button>
                <button className="settings-action-btn" disabled={busy || !runtime?.keySaved} onClick={() => void saveKey(true)}>{t('Remove key')}</button>
              </>} />
          </>
        )}
        {showCli && (
          <>
            <SettingSelect setting="aiConfig.cliProvider" label={t('Agent CLI')} value={config.cliProvider} options={['claude', 'codex', 'antigravity', 'opencode'].map(p => [p, p])} onChange={cliProvider => save({ cliProvider })} />
            <SettingText setting={`aiConfig.cliExecutablePaths.${inspectedCli as 'claude' | 'codex' | 'antigravity' | 'opencode'}`} label={t(focusSetting?.startsWith('aiConfig.cliExecutablePaths.') ? `${inspectedCli === 'claude' ? 'Claude' : inspectedCli === 'codex' ? 'Codex' : inspectedCli === 'antigravity' ? 'Antigravity' : 'OpenCode'} executable path` : 'Executable path')} value={config.cliExecutablePaths[inspectedCli] ?? ''}
              onChange={e => save({ cliExecutablePaths: { ...config.cliExecutablePaths, [inspectedCli]: e.target.value } })}
              accessory={<IconButton title={t('Choose executable')} onClick={() => void bridge?.selectExecutable(t('Choose executable')).then(path => {
                if (path) save({ cliExecutablePaths: { ...config.cliExecutablePaths, [inspectedCli]: path } });
              })}><Codicon name="folder-opened" /></IconButton>} />
            <SettingText setting="aiConfig.cliModel" label={t('CLI model')} value={config.cliModel} placeholder={t('Use CLI default model')} onChange={e => save({ cliModel: e.target.value })} />
            <SettingNumber setting="aiConfig.cliTimeoutSeconds" label={t('Timeout (seconds)')} min={30} max={1800} value={config.cliTimeoutSeconds} onChange={cliTimeoutSeconds => save({ cliTimeoutSeconds })} />
          </>
        )}
        <div className="settings-row ai-settings-runtime">
          <div className="ai-settings-status" role="status">
            {runtime && <><Codicon name={runtime.available ? 'check' : 'info'} /><span>{t(runtime.message)}</span>{runtime.version && <small>{runtime.version}</small>}</>}
          </div>
          {config.executionMode === 'provider' && <div className="settings-control-actions">
            <button className="settings-action-btn" disabled={busy} onClick={() => void check(true)}>{t('Recheck key access')}</button>
          </div>}
          {config.executionMode === 'agent-cli' && <div className="settings-control-actions">
            <button className="settings-action-btn" disabled={busy} onClick={() => void check()}>{t('Check CLI')}</button>
            {config.cliProvider === 'antigravity' && <button className="settings-action-btn" disabled={busy} onClick={() => void bridge?.request({ type: 'aiResetCliSession' }).catch(e => setError(aiErrorText(e)))}>{t('Reset Antigravity session')}</button>}
          </div>}
        </div>
        {error && <div role="alert" className="ai-error ai-settings-error">{error}</div>}
      </SettingsCard>
      <SettingsCard title={t('Token limits')}>
        <SettingNumber setting="aiConfig.maxInputTokens" label={t('Maximum input tokens')} min={4096} value={config.maxInputTokens} step={1024} onChange={maxInputTokens => save({ maxInputTokens })} />
        <SettingNumber setting="aiConfig.maxOutputTokens" label={t('Maximum output tokens')} min={1024} max={128000} value={config.maxOutputTokens} step={1024} onChange={maxOutputTokens => save({ maxOutputTokens })} />
      </SettingsCard>
      <SettingsCard title={t('AI prompts')}>
        {(['commit-message', 'commit-explanation', 'code-review', 'commit-composer', 'merge-conflict'] as const).map(task => (
          <div className="settings-row" key={task}>
            <span className="settings-label"><strong>{t(task)}</strong></span>
            <button className="settings-action-btn" aria-label={`${t('Edit AI prompt')}: ${t(task)}`} onClick={() => setPrompt(task)}>
              <Codicon name="edit" />{t('Edit…')}
            </button>
          </div>
        ))}
      </SettingsCard>
      {prompt && <AiPromptEditor task={prompt} onClose={() => setPrompt(undefined)} />}
    </section>
  );
}
export function AiPromptEditor({ task, onClose }: { task: AiTask; onClose: () => void }) {
  const { t } = useI18n();
  const bridge = useAppStore((s) => s.bridge);
  const snapshot = useAppStore((s) => s.snapshot);
  const [scope, setScope] = useState('global');
  const [repoId, setRepoId] = useState(snapshot?.repositories[0]?.meta.id ?? '');
  const [text, setText] = useState('');
  const [info, setInfo] = useState<AiPrompt>();
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState('');
  const dialog = useRef<HTMLElement>(null);
  const key = `${task}:${scope}:${repoId}:${snapshot?.workspace.id}`;
  const busy = saving || loaded !== key;
  useEffect(() => {
    let active = true;
    const control = new AbortController();
    void bridge
      ?.request<AiPrompt>(
        {
          type: 'aiPrompt',
          payload: {
            task,
            scope,
            action: 'read',
            workspace_id: snapshot?.workspace.id ?? null,
            repo_id: repoId || null,
            text: null,
          },
        },
        { signal: control.signal },
      )
      .then((value) => {
        if (active) {
          setText(value.text);
          setInfo(value);
          setError('');
          setLoaded(key);
        }
      })
      .catch((e) => {
        if (active) {
          setText('');
          setInfo(undefined);
          setError(aiErrorText(e));
          setLoaded(key);
        }
      });
    return () => {
      active = false;
      control.abort();
    };
  }, [bridge, task, scope, repoId, snapshot?.workspace.id, key]);
  const apply = async (action: string) => {
    if (!bridge || busy) return;
    setSaving(true);
    setError('');
    try {
      const value = await bridge.request<AiPrompt>({
        type: 'aiPrompt',
        payload: {
          task,
          scope,
          action,
          workspace_id: snapshot?.workspace.id ?? null,
          repo_id: repoId || null,
          text: action === 'save' ? text : null,
        },
      });
      setText(value.text);
      setInfo(value);
      if (action === 'save') onClose();
    } catch (e) {
      setError(aiErrorText(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <DialogSurface ref={dialog} className="ai-prompt-dialog" onClose={onClose} closeDisabled={saving} aria-label={t('Edit AI prompt')}>
        <header>
          <strong>{t(task)}</strong>
          <IconButton title={t('Close')} disabled={saving} onClick={onClose}>
            <Codicon name="close" />
          </IconButton>
        </header>
        <div className="ai-prompt-controls">
          <SettingSelect label={t('Prompt scope')} disabled={saving} value={scope} options={[["global", t('Global')], ...(snapshot ? [["workspace", t('Workspace')] as [string, string]] : [])]} onChange={setScope} />
          {scope === 'workspace' && <SettingSelect label={t('Repository')} disabled={saving} value={repoId} options={(snapshot?.repositories ?? []).map(r => [r.meta.id, r.meta.name])} onChange={setRepoId} />}
        </div>
        {loaded === key && info?.path && <small className="ai-prompt-path">{info.path}</small>}
        <textarea
          aria-label={t('AI prompt')}
          spellCheck={false}
          disabled={busy}
          value={loaded === key ? text : ''}
          onChange={(e) => setText(e.target.value)}
        />
        {error && (
          <div role="alert" className="ai-error">
            {error}
          </div>
        )}
        <footer>
          <button className="settings-action-btn" disabled={busy} onClick={() => void apply('reset')}>
            {t('Reset to default')}
          </button>
          <div className="ai-prompt-footer-actions vd-dialog-footer-actions">
            <button className="settings-action-btn" disabled={saving} onClick={onClose}>
              {t('Cancel')}
            </button>
            <button className="settings-action-btn primary" disabled={busy || !text.trim()} onClick={() => void apply('save')}>
              {t('Save')}
            </button>
          </div>
        </footer>
    </DialogSurface>
  );
}
