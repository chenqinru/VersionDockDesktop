import { FormField } from './FormField';
import { Input } from './Input';
import { Button } from './Button';
import { AiGenerationBorder } from './AiGenerationBorder';
import { DialogSurface } from './DialogSurface';
import { useEffect, useRef, useState } from 'react';
import { IconButton } from './IconButton';
import { Codicon } from './Codicon';
import { currentDialog, dialogListeners, publishDialog, type DialogRequest } from './dialogService';
import { useI18n } from '../i18n';

export function DialogHost() {
  const [request, setRequest] = useState(currentDialog());
  const [value, setValue] = useState('');
  const [selectedChoiceIds, setSelectedChoiceIds] = useState<string[]>([]);
  const [submitError, setSubmitError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [branchTaskMode, setBranchTaskMode] = useState(false);
  const [branchTask, setBranchTask] = useState('');
  const generation = useRef<AbortController>();
  const dialog = useRef<HTMLElement>(null);
  const returnFocus = useRef<HTMLElement>();
  const { t } = useI18n();

  useEffect(() => {
    const listener = (next: DialogRequest | undefined) => {
      if (next && document.activeElement instanceof HTMLElement) returnFocus.current = document.activeElement;
      generation.current?.abort(); generation.current = undefined; setGenerating(false);
      setRequest(next);
      setValue(next?.initialValue ?? '');
      setSelectedChoiceIds(next?.initialSelected ?? (next?.choices ?? []).map((c) => c.id));
      setSubmitError(''); setSubmitting(false); setBranchTaskMode(false); setBranchTask('');
    };
    dialogListeners.add(listener);
    return () => { generation.current?.abort(); generation.current = undefined; dialogListeners.delete(listener); };
  }, []);

  if (!request) return null;
  const finish = (result: boolean | string | string[] | null) => {
    generation.current?.abort(); generation.current = undefined;
    const resolver = request.resolve;
    publishDialog(undefined);
    resolver(result);
    queueMicrotask(() => returnFocus.current?.focus());
  };
  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape' && branchTaskMode && !generating) { event.preventDefault(); event.stopPropagation(); setBranchTaskMode(false); return; }
    if (request.kind === 'editor' && event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void submit(); return; }
    if (event.key !== 'Tab') return;
    const focusable = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? [])];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  const generate = async () => {
    if (generating) { generation.current?.abort(); return; }
    if (!request.generate) return;
    const control = new AbortController(); const previous = value; generation.current = control; setGenerating(true); setValue(''); setSubmitError('');
    try { const text = await request.generate(control.signal, (text) => { if (!control.signal.aborted && generation.current === control) setValue(text); }); if (!control.signal.aborted && generation.current === control) setValue((current) => text || current); }
    catch (error) { if (generation.current === control) { setValue(previous); if (!control.signal.aborted) setSubmitError(String(error)); } }
    finally { if (generation.current === control) { if (control.signal.aborted) setValue(previous); generation.current = undefined; setGenerating(false); } }
  };
  const submit = async () => {
    if (generating || submitting) return;
    if (branchTaskMode && request.generateBranchName) {
      const control = new AbortController(); generation.current = control; setGenerating(true); setSubmitError('');
      try {
        const name = await request.generateBranchName(branchTask, control.signal);
        if (!control.signal.aborted && generation.current === control) { setValue(name); setBranchTaskMode(false); }
      } catch (error) {
        if (!control.signal.aborted && generation.current === control) { setBranchTaskMode(false); setSubmitError(error instanceof Error ? error.message : String(error)); }
      } finally { if (generation.current === control) { generation.current = undefined; setGenerating(false); } }
      return;
    }
    if (request.kind === 'editor' && !branchTaskMode && !request.allowEmpty && !value.trim()) return;
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
      setSubmitting(true); setSubmitError('');
      try {
        const validation = request.validateInput?.(result);
        const error = validation instanceof Promise ? await validation : validation;
        if (currentDialog() !== request) return;
        if (error) { setSubmitError(error); return; }
        finish(request.allowEmpty ? result : result || null);
      } catch (error) { setSubmitError(error instanceof Error ? error.message : String(error)); }
      finally { setSubmitting(false); }
    } else finish(true);
  };
  const isEditor = request.kind === 'editor';
  return <DialogSurface ref={dialog} size={isEditor || request.items?.length || request.compactChoices ? 'medium' : 'small'} className={`app-dialog${isEditor ? ' commit-message-dialog' : ''}${request.compactChoices ? ' compact-choice-dialog' : ''}`} onClose={() => { if (branchTaskMode && !generating) setBranchTaskMode(false); else finish(false); }} closeDisabled={submitting} aria-labelledby="app-dialog-title" onKeyDown={handleKeyDown}>
      <header><Codicon name={request.icon ?? (request.danger ? 'warning' : request.kind === 'prompt' ? 'edit' : isEditor ? 'git-commit' : 'question')} /><strong id="app-dialog-title">{request.title}</strong><IconButton title={t('Close')} disabled={submitting} onClick={() => finish(false)}><Codicon name="close" /></IconButton></header>
      {!isEditor && (branchTaskMode ? <p>{t('Describe your task, or leave empty to generate from current changes.')}</p> : request.message && <p>{request.message}</p>)}
      {request.kind === 'prompt' && <FormField label={branchTaskMode ? t('Task description') : request.inputLabel}>
        <Input controlSize="md" autoFocus disabled={submitting || generating} aria-label={branchTaskMode ? t('Task description') : request.inputLabel ?? request.title} type={request.inputType ?? 'text'} value={branchTaskMode ? branchTask : value} placeholder={branchTaskMode ? t('e.g. Fix login timeout') : undefined} onChange={(event) => branchTaskMode ? setBranchTask(event.target.value) : setValue(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void submit(); }} />
      </FormField>}
      {request.generateBranchName && generating && <p role="status">{t('Generating branch name…')}</p>}
      {!isEditor && request.items?.length ? <div className="dialog-commit-list">{request.items.map((item) => <div key={item.id}><code>{item.id}</code><span><strong>{item.label}</strong>{item.description && <small>{item.description}</small>}</span></div>)}</div> : null}
      {isEditor && <div className="commit-message-body">
        {request.message && <p className="commit-message-description">{request.message}</p>}
        {request.originalMessage !== undefined && <section aria-labelledby="original-message-label"><div id="original-message-label" className="commit-message-label">{t('Original commit message')}</div><div className="dialog-original-message selectable-text">{request.originalMessage}</div></section>}
        {request.items?.length ? <section aria-labelledby="squash-commits-label"><div id="squash-commits-label" className="commit-message-label">{request.itemsLabel ?? t('Commits being squashed')}</div><div className="dialog-commit-list selectable-text">{request.items.map((item) => <div key={item.id}><code title={item.id}>{item.displayId ?? item.id}</code><span>{item.label}{item.description && <small>{item.description}</small>}</span></div>)}</div></section> : null}
        <div><label className="commit-message-label" htmlFor="commit-message-input">{request.inputLabel}</label><div className="ai-input-surface"><AiGenerationBorder active={generating} /><textarea id="commit-message-input" placeholder={generating ? t('Generating commit message…') : ''} readOnly={generating || submitting} autoFocus spellCheck={false} className={`dialog-editor${generating ? ' ai-input-generating' : ''}`} value={value} onChange={(event) => setValue(event.target.value)} />{request.generate && <IconButton className="dialog-editor-ai" title={t(generating ? 'Stop generating commit message' : 'Generate commit message with AI')} disabled={submitting} onClick={() => void generate()}><Codicon name={generating ? 'stop-circle' : 'sparkle'} /></IconButton>}</div></div>
        {submitError && <p className="dialog-error" role="alert">{submitError}</p>}
      </div>}
      {!isEditor && submitError && <p className="dialog-error" role="alert">{submitError}</p>}
      {request.kind === 'choice' && <div className="dialog-choices">{request.choices?.map((choice) => <button key={choice.id} className={choice.danger ? 'danger-choice' : ''} onClick={() => finish(choice.id)}>{choice.icon && <Codicon name={choice.icon} />}<span><strong title={request.compactChoices ? choice.label : undefined}>{choice.label}</strong>{choice.description && <small title={request.compactChoices ? choice.description : undefined}>{choice.description}</small>}</span></button>)}</div>}
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
      <footer>{request.generateBranchName && <IconButton title={t(generating ? 'Stop generating branch name' : branchTaskMode ? 'Back' : 'Generate branch name with AI')} disabled={submitting} onClick={() => { if (generating) { generation.current?.abort(); generation.current = undefined; setGenerating(false); setBranchTaskMode(false); } else setBranchTaskMode(!branchTaskMode); setSubmitError(''); }}><Codicon name={generating ? 'stop-circle' : branchTaskMode ? 'arrow-left' : 'sparkle'} /></IconButton>}{!isEditor && request.generate && <IconButton className="ai-generate" title={t(generating ? 'Stop generating commit message' : 'Generate commit message with AI')} disabled={submitting} onClick={() => void generate()}><Codicon name={generating ? 'stop-circle' : 'sparkle'} /></IconButton>}<Button size="md" disabled={submitting} autoFocus={request.kind === 'confirm' && !request.danger} onClick={() => finish(false)}>{isEditor && <Codicon name="close" />}{request.cancelLabel ?? t('Cancel')}</Button>{request.kind !== 'choice' && <Button variant="primary" danger={request.danger} size="md" loading={submitting} disabled={generating || submitting || (request.kind === 'multiChoice' && selectedChoiceIds.length === 0) || ((request.kind === 'prompt' || isEditor) && !branchTaskMode && !request.allowEmpty && !value.trim())} onClick={() => void submit()}>{isEditor && <Codicon name="check" />}{branchTaskMode ? t('Generate branch name with AI') : request.confirmLabel ?? t('Confirm')}</Button>}</footer>
  </DialogSurface>;
}
