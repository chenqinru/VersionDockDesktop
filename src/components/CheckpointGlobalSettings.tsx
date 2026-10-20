import { useEffect, useState } from 'react';
import type { CheckpointSettings } from '../bindings/generated';
import { useI18n } from '../i18n';
import { refreshCheckpoints } from '../checkpoints/store';
import { useCheckpointManagement } from './useCheckpointManagement';
import { Button } from './Button';
import { LoadingState } from './LoadingState';
import { ErrorNotice } from './ErrorNotice';
import { confirmDialog } from './dialogService';
import { Codicon } from './Codicon';

export function CheckpointGlobalSettings({ onBusyChange }: { onBusyChange: (busy: boolean) => void }) {
  const { t } = useI18n();
  const { request, busy, error } = useCheckpointManagement(onBusyChange);
  const [settings, setSettings] = useState<CheckpointSettings>();
  const load = async () => { const result = await request<CheckpointSettings>({ type: 'checkpointSettings', payload: { action: { type: 'status' } } }); if (result) setSettings(result); };
  useEffect(() => { void request<CheckpointSettings>({ type: 'checkpointSettings', payload: { action: { type: 'status' } } }).then(result => { if (result) setSettings(result); }); }, [request]);
  const install = async () => {
    if (!await confirmDialog({ title: t('Install Codex checkpoint hooks'), message: t('Add VersionDock handlers to your Codex hooks.json and back up the existing file. Review and trust these hooks in Codex before using automatic recording. Existing handlers are preserved.') })) return;
    const result = await request<CheckpointSettings>({ type: 'checkpointSettings', payload: { action: { type: 'installHooks' } } }, true);
    if (result) { setSettings(result); void refreshCheckpoints(); }
  };
  return <>
    <div className="checkpoint-page-heading"><h3>{t('Checkpoint settings')}</h3></div>
    <div className="checkpoint-scroll checkpoint-settings">
      {error && <ErrorNotice onRetry={() => void load()}>{t(error)}</ErrorNotice>}
      {!settings && busy && <LoadingState>{t('Loading…')}</LoadingState>}
      {settings && <>
        <section className="checkpoint-settings-section">
          <div className="checkpoint-settings-section-heading"><h4>{t('Codex Hooks')}</h4><span className="checkpoint-settings-note">{t(settings.hooksInstalled ? 'Hooks installed' : 'Hooks not installed')}</span><Button size="xs" loading={busy} onClick={() => void install()}>{t(settings.hooksInstalled ? 'Update Codex hooks' : 'Install Codex checkpoint hooks')}</Button></div>
          <p className="checkpoint-settings-note">{t('Hooks are installed globally. Connection verification is shown separately for each task.')}</p>
          <details className="checkpoint-scope"><summary>{t('Event descriptions')}</summary>
            <dl className="checkpoint-hook-events">
              <div><dt><code>{'UserPromptSubmit'}</code></dt><dd>{t('Start recording and save the state before changes.')}</dd></div>
              <div><dt><code>{'Stop'}</code></dt><dd>{t('Finish recording and save the state after changes.')}</dd></div>
              <div><dt><code>{'Interrupt'}</code></dt><dd>{t('Mark the recording as interrupted and wait for finishing.')}</dd></div>
            </dl>
          </details>
          <details className="checkpoint-scope"><summary>{t('Usage instructions')}</summary>
            <p className="checkpoint-settings-note">{t('Automatic checkpoints save your sent message locally. Expand a record to read it; unused message data is removed with checkpoint cleanup.')}</p>
            <p className="checkpoint-settings-note">{t('Installed configuration does not prove desktop compatibility. Review hooks in Codex, run a short task, and verify that both start and stop events appear here. Use manual mode if events are missing.')}</p>
          </details>
        </section>
        <section className="checkpoint-settings-section"><h4>{t('Shared snapshot storage')}</h4>
          <p>{t('All projects: {0} MiB', (settings.storage.totalBytes! / 1048576).toFixed(1))}</p>
          {settings.storage.warning && <p className="checkpoint-storage-warning" role="status"><Codicon name="warning" />{t('Snapshot storage exceeds 1 GiB. Review old history and clean it manually.')}</p>}
          <code className="checkpoint-full-path selectable-text">{settings.storage.path}</code>
          <p className="checkpoint-settings-note">{t('Manage usage and clean history from each project menu. Shared snapshots are retained while any project still uses them.')}</p>
          <div className="checkpoint-toolbar"><Button size="xs" disabled={busy} onClick={() => void request({ type: 'checkpointSettings', payload: { action: { type: 'openStorage' } } })}>{t('Open snapshot folder')}</Button><Button size="xs" disabled={busy} onClick={() => void load()}>{t('Refresh storage usage')}</Button></div>
        </section>
      </>}
    </div>
  </>;
}
