import { ErrorNotice } from './ErrorNotice';
import { FormField } from './FormField';
import { Input } from './Input';
import { Button } from './Button';
import { useCallback, useRef, useState } from 'react';
import type { RemoteRepository } from '../bindings/generated';
import { useI18n } from '../i18n';
import { DialogSurface } from './DialogSurface';
import { IconButton } from './IconButton';
import { useBridge } from '../platform/context';
import { isOperationActive, useAppStore } from '../store/appStore';
import { Codicon } from './Codicon';
import { RepositoryTaskProgress } from './RepositoryTaskProgress';
import { ProviderContent } from './ProviderContent';
import { SelectionCheckbox } from './SelectionCheckbox';

export type RepositoryCheckoutKind = 'git' | 'svn';

function inferredTargetName(value: string, kind: RepositoryCheckoutKind): string {
  const clean = value.trim().replace(/[?#].*$/, '').replace(/\/+$/, '');
  const parts = clean.split(/[/:]/).filter(Boolean);
  let name = parts.at(-1)?.replace(/\.git$/i, '') ?? '';
  if (kind === 'svn' && name.toLocaleLowerCase() === 'trunk') name = parts.at(-2) ?? name;
  return name;
}

function validTargetName(value: string): boolean {
  const name = value.trim();
  return Boolean(name)
    && name === value
    && name !== '.'
    && name !== '..'
    && !/[<>:"|?*/\\]/.test(name)
    && !name.endsWith('.')
    && !name.endsWith(' ');
}

export function RepositoryCheckoutDialog({ kind, close, defaultParent = '', defaultTargetName = '' }: {
  kind: RepositoryCheckoutKind;
  close: () => void;
  defaultParent?: string;
  defaultTargetName?: string;
}) {
  const bridge = useBridge();
  const { t } = useI18n();
  const cloneRepository = useAppStore((state) => state.cloneRepository);
  const checkoutSvnRepository = useAppStore((state) => state.checkoutSvnRepository);
  const busy = useAppStore((state) => isOperationActive(state.operations, { domain: 'workspace' }));
  const [url, setUrl] = useState('');
  const [parent, setParent] = useState(defaultParent);
  const [targetName, setTargetName] = useState(defaultTargetName);
  const [openInNewWindow, setOpenInNewWindow] = useState(false);
  const [providerAccountId, setProviderAccountId] = useState<string>();
  const [operationId, setOperationId] = useState<string>();
  const [accountFormOpen, setAccountFormOpen] = useState(false);
  const [source, setSource] = useState<'url' | 'account'>('url');
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const clearAccountSelection = useCallback(() => { setProviderAccountId(undefined); }, []);
  const locked = busy || submitting;
  const [showAuthentication, setShowAuthentication] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [validationError, setValidationError] = useState('');
  const inferredNameRef = useRef('');
  const git = kind === 'git';

  const changeUrl = (value: string) => {
    setUrl(value);
    const inferred = inferredTargetName(value, kind);
    setTargetName((current) => {
      if (!current || current === inferredNameRef.current) {
        inferredNameRef.current = inferred;
        return inferred;
      }
      return current;
    });
    setProviderAccountId(undefined);
  };

  const submit = async () => {
    if (submittingRef.current || busy) return;
    const name = targetName.trim();
    if (!validTargetName(targetName)) {
      setValidationError(t('Invalid folder name. Use one directory name without path separators or special characters.'));
      return;
    }
    setValidationError('');
    submittingRef.current = true;
    setSubmitting(true);
    setOperationId(undefined);
    try {
    const outcome = git
      ? { succeeded: await cloneRepository(url.trim(), parent.trim(), name, openInNewWindow, providerAccountId, setOperationId), authenticationRequired: false }
      : await checkoutSvnRepository(
          url.trim(),
          parent.trim(),
          name,
          openInNewWindow,
          showAuthentication ? username : undefined,
          showAuthentication ? password : undefined,
        );
    if (outcome.authenticationRequired) {
      setShowAuthentication(true);
      setValidationError(t('SVN authentication is required.'));
      return;
    }
    if (outcome.succeeded) close();
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const ready = Boolean(url.trim() && parent.trim() && targetName.trim())
    && validTargetName(targetName)
    && (!git || source === 'url' || Boolean(providerAccountId))
    && (git || !showAuthentication || Boolean(username.trim() && password));

  return <>
      <DialogSurface className={`app-dialog clone-dialog ${git && source === 'account' ? 'clone-dialog-accounts' : ''}`} onClose={close} closeDisabled={locked} aria-label={t(git ? 'Clone Git Repository' : 'Checkout SVN Repository')}>
        <header><Codicon name={git ? 'repo-clone' : 'cloud-download'} /><strong>{t(git ? 'Clone Git Repository' : 'Checkout SVN Repository')}</strong><IconButton title={t('Close')} disabled={locked} onClick={close}><Codicon name="close" /></IconButton></header>
        {git && <div className="dialog-segmented-tabs" role="tablist" aria-label={t('Clone source')} onKeyDown={(event) => {
          if (locked || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const next = event.key === 'Home' ? 'url' : event.key === 'End' ? 'account' : source === 'url' ? 'account' : 'url';
          setSource(next);
          event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next === 'url' ? 0 : 1]?.focus();
        }}>
          <button className="vd-selectable" type="button" role="tab" aria-selected={source === 'url'} tabIndex={source === 'url' ? 0 : -1} disabled={locked} onClick={() => setSource('url')}><Codicon name="link" /><span>{t('Repository URL')}</span></button>
          <button className="vd-selectable" type="button" role="tab" aria-selected={source === 'account'} tabIndex={source === 'account' ? 0 : -1} disabled={locked} onClick={() => setSource('account')}><Codicon name="account" /><span>{t('Remote Accounts')}</span></button>
        </div>}
        {git && source === 'account' && <ProviderContent mode="browse" disabled={locked} close={() => setSource('url')} selectedRepositoryUrl={providerAccountId ? url : undefined} onAccountFormChange={setAccountFormOpen} onAccountChange={clearAccountSelection} onClone={(repository: RemoteRepository, accountId) => {
          setUrl(repository.cloneUrl);
          setTargetName(repository.name);
          inferredNameRef.current = repository.name;
          setProviderAccountId(accountId);
        }} />}
        <fieldset className="clone-fields" disabled={locked} hidden={git && source === 'account' && accountFormOpen}>
        <FormField label={t(git ? 'Git URL' : 'SVN URL')} description={git && source === 'url' ? t('SSH URLs use your Git SSH configuration. Platform accounts authenticate HTTPS repositories.') : undefined}>
          <Input controlSize="md" autoFocus={!git || source === 'url'} value={url} placeholder={git ? 'https://github.com/user/repository.git' : 'https://svn.example.com/project/trunk'} onChange={(event) => changeUrl(event.target.value)} />
        </FormField>
        <div className="checkout-destination-fields">
        <FormField label={t('Parent folder')}>
          <div className="dialog-input-row"><Input controlSize="md" value={parent} onChange={(event) => setParent(event.target.value)} /><Button type="button"  onClick={async () => { const value = await bridge.selectDirectory(t(git ? 'Select clone parent folder' : 'Select checkout parent folder')); if (value) setParent(value); }}><Codicon name="folder-opened" /><span>{t('Browse…')}</span></Button></div>
        </FormField>
        <FormField label={t('Folder name')}>
          <Input controlSize="md" value={targetName} onChange={(event) => { inferredNameRef.current = ''; setTargetName(event.target.value); }} />
        </FormField>
        </div>
        {validationError && <ErrorNotice>{validationError}</ErrorNotice>}
        {!git && <>
          <label className="dialog-check"><SelectionCheckbox label={t('SVN authentication')} checked={showAuthentication} disabled={locked} onChange={() => setShowAuthentication(value => !value)} />{t('SVN authentication')}</label>
          {showAuthentication && <div className="checkout-auth-fields">
            <FormField label={t('Username')}>
              <Input controlSize="md" value={username} onChange={(event) => setUsername(event.target.value)} />
            </FormField>
            <FormField label={t('Password')}>
              <Input controlSize="md" type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
            </FormField>
          </div>}
        </>}
        {(!git || source === 'url') && <label className="dialog-check"><SelectionCheckbox label={t('Open in New Window')} checked={openInNewWindow} disabled={locked} onChange={() => setOpenInNewWindow(value => !value)} />{t('Open in New Window')}</label>}
        </fieldset>
        <RepositoryTaskProgress operationId={operationId} />
        <footer>{git && source === 'account' && !accountFormOpen && <label className="dialog-check clone-new-window-option"><SelectionCheckbox label={t('Open in New Window')} checked={openInNewWindow} disabled={locked} onChange={() => setOpenInNewWindow(value => !value)} />{t('Open in New Window')}</label>}<Button size="md" type="button" disabled={locked} onClick={close}>{t('Cancel')}</Button><Button variant="primary" size="md" type="button" disabled={locked || !ready || (source === 'account' && accountFormOpen)} onClick={() => void submit()}>{t(git ? 'Clone' : 'Checkout')}</Button></footer>
      </DialogSurface>

  </>;
}
