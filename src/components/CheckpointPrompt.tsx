import { useEffect, useState } from 'react';
import { useI18n } from '../i18n';
import { isAbortError } from '../platform/bridge';
import { useAppStore } from '../store/appStore';
import { LoadingState } from './LoadingState';
import { ErrorNotice } from './ErrorNotice';
import type { CheckpointMessage } from '../bindings/generated';

function Message({ message }: { message: CheckpointMessage }) {
  const { t } = useI18n();
  return <div className="checkpoint-message-entry">
    {message.body.trim() && <pre className="selectable-text">{message.body}</pre>}
    {message.annotations.map((annotation, index) => <div className="checkpoint-message-annotation" key={index}>
      {annotation.annotation && <pre className="selectable-text">{annotation.annotation}</pre>}
      <details><summary>{t('Quoted text')}{message.annotations.length > 1 ? ` ${index + 1}` : ''}</summary><pre className="selectable-text">{annotation.text}</pre></details>
    </div>)}
    {message.attachments.length > 0 && <details><summary>{t('Attachments')} · {message.attachments.length}</summary><ul className="checkpoint-message-attachments">{message.attachments.map((file, index) => <li key={index}><span className={`codicon codicon-${file.image ? 'file-media' : 'file'}`} aria-hidden="true" /><span><strong>{file.name}</strong><span className="selectable-text">{file.path}</span></span></li>)}</ul></details>}
    {message.selections.length > 0 && <details><summary>{t('Selected text')} · {message.selections.length}</summary>{message.selections.map((selection, index) => <pre className="selectable-text" key={index}>{selection}</pre>)}</details>}
    {message.raw !== null && <details className="checkpoint-message-raw"><summary>{t('Original message')}</summary><pre className="selectable-text">{message.raw}</pre></details>}
  </div>;
}

export function CheckpointPrompt({ taskId, checkpointId, revision }: { taskId: string; checkpointId: string; revision?: string }) {
  const { t } = useI18n();
  const bridge = useAppStore(state => state.bridge);
  const workspaceId = useAppStore(state => state.snapshot?.workspace.id);
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<{ key: string; messages?: CheckpointMessage[]; error?: string }>();
  const key = JSON.stringify([workspaceId, taskId, checkpointId, retry, revision]);
  useEffect(() => {
    if (!bridge || !workspaceId) return;
    const controller = new AbortController();
    void bridge.request<CheckpointMessage[]>({ type: 'checkpoint', payload: { workspace_id: workspaceId, action: { type: 'messages', task_id: taskId, checkpoint_id: checkpointId } } }, { signal: controller.signal, showProgress: false, context: { workspaceId } }).then(messages => {
      if (!controller.signal.aborted) setResult({ key, messages });
    }).catch(error => {
      if (!controller.signal.aborted && !isAbortError(error)) setResult({ key, error: error instanceof Error ? error.message : String(error) });
    });
    return () => controller.abort();
  }, [bridge, workspaceId, taskId, checkpointId, retry, key]);
  const current = result?.key === key ? result : undefined;
  return <section className="checkpoint-message" aria-label={t('User message')}>
    <strong>{t('User message')}</strong>
    {!current ? <LoadingState>{t('Loading…')}</LoadingState> : current.error ? <ErrorNotice onRetry={() => setRetry(value => value + 1)}>{t(current.error)}</ErrorNotice> : !current.messages?.length ? <p>{t('No message was saved for this checkpoint.')}</p> : current.messages.map((message, index) => <Message message={message} key={`${key}-${index}`} />)}
  </section>;
}
