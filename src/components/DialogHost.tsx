import { useEffect, useRef, useState } from 'react';
import { Codicon } from './Codicon';
import { currentDialog, dialogListeners, publishDialog, type DialogRequest } from './dialogService';
import { useI18n } from '../i18n';

export function DialogHost() {
  const [request, setRequest] = useState(currentDialog());
  const [value, setValue] = useState('');
  const [selectedChoiceIds, setSelectedChoiceIds] = useState<string[]>([]);
  const [submitError, setSubmitError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const dialog = useRef<HTMLElement>(null);
  const returnFocus = useRef<HTMLElement>();
  const { t } = useI18n();

  useEffect(() => {
    const listener = (next: DialogRequest | undefined) => {
      if (next && document.activeElement instanceof HTMLElement) returnFocus.current = document.activeElement;
      setRequest(next);
      setValue(next?.initialValue ?? '');
      setSelectedChoiceIds(next?.initialSelected ?? (next?.choices ?? []).map((c) => c.id));
      setSubmitError(''); setSubmitting(false);
    };
    dialogListeners.add(listener);
    return () => { dialogListeners.delete(listener); };
  }, []);

  if (!request) return null;
  const finish = (result: boolean | string | string[] | null) => {
    const resolver = request.resolve;
    publishDialog(undefined);
    resolver(result);
    queueMicrotask(() => returnFocus.current?.focus());
  };
  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape' && !submitting) { event.stopPropagation(); finish(false); return; }
    if (request.kind === 'editor' && event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void submit(); return; }
    if (event.key !== 'Tab') return;
    const focusable = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? [])];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  const submit = async () => {
    if (request.kind === 'multiChoice') {
      finish(selectedChoiceIds);
      return;
    }
    if (request.kind === 'editor' && request.submit) {
      setSubmitting(true); setSubmitError('');
      try { if (await request.submit(value)) finish(value); }
      catch (error) { setSubmitError(error instanceof Error ? error.message : String(error)); }
      finally { setSubmitting(false); }
      return;
    }
    if (request.kind === 'prompt') {
      const result = request.inputType === 'password' ? value : value.trim();
      if (!request.allowEmpty && !result.trim()) return;
      const error = request.validateInput?.(result);
      if (error) { setSubmitError(error); return; }
      finish(request.allowEmpty ? result : result || null);
    } else finish(true);
  };
  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) finish(false); }}>
    <section ref={dialog} className="app-dialog" role="dialog" aria-modal="true" aria-labelledby="app-dialog-title" onKeyDown={handleKeyDown}>
      <header><Codicon name={request.danger ? 'warning' : 'question'} /><strong id="app-dialog-title">{request.title}</strong></header>
      <p>{request.message}</p>
      {request.kind === 'prompt' && <label><span>{request.inputLabel}</span><input autoFocus aria-label={request.inputLabel ?? request.title} type={request.inputType ?? 'text'} value={value} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') submit(); }} /></label>}
      {request.items?.length ? <div className="dialog-commit-list">{request.items.map((item) => <div key={item.id}><code>{item.id}</code><span><strong>{item.label}</strong>{item.description && <small>{item.description}</small>}</span></div>)}</div> : null}
      {request.kind === 'editor' && <label><span>{request.inputLabel}</span><textarea autoFocus className="dialog-editor" value={value} onChange={(event) => setValue(event.target.value)} /></label>}
      {submitError && <p className="dialog-error" role="alert">{submitError}</p>}
      {request.kind === 'choice' && <div className="dialog-choices">{request.choices?.map((choice) => <button key={choice.id} className={choice.danger ? 'danger-choice' : ''} onClick={() => finish(choice.id)}>{choice.icon && <Codicon name={choice.icon} />}<span><strong>{choice.label}</strong>{choice.description && <small>{choice.description}</small>}</span></button>)}</div>}
      {request.kind === 'multiChoice' && (
        <div className="dialog-choices dialog-multi-choices">
          {request.choices?.map((choice) => {
            const isChecked = selectedChoiceIds.includes(choice.id);
            return (
              <button
                key={choice.id}
                type="button"
                className={`choice-item ${isChecked ? 'selected' : ''}`}
                onClick={() => {
                  setSelectedChoiceIds((prev) =>
                    prev.includes(choice.id) ? prev.filter((id) => id !== choice.id) : [...prev, choice.id]
                  );
                }}
              >
                <Codicon name={isChecked ? 'check' : 'blank'} />
                {choice.icon && <Codicon name={choice.icon} />}
                <span>
                  <strong>{choice.label}</strong>
                  {choice.description && <small>{choice.description}</small>}
                </span>
              </button>
            );
          })}
        </div>
      )}
      <footer><button disabled={submitting} autoFocus={request.kind === 'confirm' && !request.danger} onClick={() => finish(false)}>{request.cancelLabel ?? t('Cancel')}</button>{request.kind !== 'choice' && <button className={request.danger ? 'danger' : 'primary'} disabled={submitting || (request.kind === 'multiChoice' && selectedChoiceIds.length === 0) || ((request.kind === 'prompt' || request.kind === 'editor') && !request.allowEmpty && !value.trim())} onClick={() => void submit()}>{request.confirmLabel ?? t('Confirm')}</button>}</footer>
    </section>
  </div>;
}
