import { useEffect, useState } from 'react';
import { Codicon } from './Codicon';
import { currentDialog, dialogListeners, publishDialog, type DialogRequest } from './dialogService';
import { useI18n } from '../i18n';

export function DialogHost() {
  const [request, setRequest] = useState(currentDialog());
  const [value, setValue] = useState('');
  const { t } = useI18n();

  useEffect(() => {
    const listener = (next: DialogRequest | undefined) => {
      setRequest(next);
      setValue(next?.initialValue ?? '');
    };
    dialogListeners.add(listener);
    return () => { dialogListeners.delete(listener); };
  }, []);

  if (!request) return null;
  const finish = (result: boolean | string | null) => {
    const resolver = request.resolve;
    publishDialog(undefined);
    resolver(result);
  };
  const submit = () => finish(request.kind === 'prompt' ? value.trim() || null : true);
  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) finish(false); }}>
    <section className="app-dialog" role="dialog" aria-modal="true" aria-labelledby="app-dialog-title" onKeyDown={(event) => { if (event.key === 'Escape') finish(false); }}>
      <header><Codicon name={request.danger ? 'warning' : 'question'} /><strong id="app-dialog-title">{request.title}</strong></header>
      <p>{request.message}</p>
      {request.kind === 'prompt' && <label><span>{request.inputLabel}</span><input autoFocus value={value} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') submit(); }} /></label>}
      {request.kind === 'choice' && <div className="dialog-choices">{request.choices?.map((choice) => <button key={choice.id} className={choice.danger ? 'danger-choice' : ''} onClick={() => finish(choice.id)}>{choice.icon && <Codicon name={choice.icon} />}<span><strong>{choice.label}</strong>{choice.description && <small>{choice.description}</small>}</span></button>)}</div>}
      <footer><button autoFocus={request.kind === 'confirm' && !request.danger} onClick={() => finish(false)}>{request.cancelLabel ?? t('Cancel')}</button>{request.kind !== 'choice' && <button className={request.danger ? 'danger' : 'primary'} disabled={request.kind === 'prompt' && !value.trim()} onClick={submit}>{request.confirmLabel ?? t('Confirm')}</button>}</footer>
    </section>
  </div>;
}
