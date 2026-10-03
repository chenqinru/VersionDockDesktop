import { useRef, useState } from 'react';
import type { RemoteRepository } from '../bindings/generated';
import { useI18n } from '../i18n';
import { DialogSurface } from './DialogSurface';
import { IconButton } from './IconButton';
import { useBridge } from '../platform/context';
import { isOperationActive, useAppStore } from '../store/appStore';
import { Codicon } from './Codicon';
import { ProviderPanel } from './ProviderPanel';

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
  const [providerOpen, setProviderOpen] = useState(false);
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
    const name = targetName.trim();
    if (!validTargetName(targetName)) {
      setValidationError(t('Invalid folder name. Use one directory name without path separators or special characters.'));
      return;
    }
    setValidationError('');
    const outcome = git
      ? { succeeded: await cloneRepository(url.trim(), parent.trim(), name, openInNewWindow, providerAccountId), authenticationRequired: false }
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
  };

  const ready = Boolean(url.trim() && parent.trim() && targetName.trim())
    && validTargetName(targetName)
    && (git || !showAuthentication || Boolean(username.trim() && password));

  return <>
      <DialogSurface className="app-dialog clone-dialog" onClose={close} closeDisabled={busy} aria-label={t(git ? 'Clone Git Repository' : 'Checkout SVN Repository')}>
        <header><Codicon name={git ? 'repo-clone' : 'cloud-download'} /><strong>{t(git ? 'Clone Git Repository' : 'Checkout SVN Repository')}</strong><IconButton title={t('Close')} disabled={busy} onClick={close}><Codicon name="close" /></IconButton></header>
        {git && <button type="button" onClick={() => setProviderOpen(true)}><Codicon name="cloud" />{t('Browse Remote Providers')}</button>}
        <label><span>{t(git ? 'Git URL' : 'SVN URL')}</span><input autoFocus value={url} placeholder={git ? 'https://github.com/user/repository.git' : 'https://svn.example.com/project/trunk'} onChange={(event) => changeUrl(event.target.value)} /></label>
        <label><span>{t('Parent folder')}</span><div className="dialog-input-row"><input value={parent} onChange={(event) => setParent(event.target.value)} /><button type="button" onClick={async () => { const value = await bridge.selectDirectory(t(git ? 'Select clone parent folder' : 'Select checkout parent folder')); if (value) setParent(value); }}>{t('Browse…')}</button></div></label>
        <label><span>{t('Folder name')}</span><input value={targetName} onChange={(event) => { inferredNameRef.current = ''; setTargetName(event.target.value); }} /></label>
        {validationError && <p className="dialog-error">{validationError}</p>}
        {!git && <>
          <label className="dialog-check"><input type="checkbox" checked={showAuthentication} onChange={(event) => setShowAuthentication(event.target.checked)} />{t('SVN authentication')}</label>
          {showAuthentication && <div className="checkout-auth-fields">
            <label><span>{t('Username')}</span><input value={username} onChange={(event) => setUsername(event.target.value)} /></label>
            <label><span>{t('Password')}</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
          </div>}
        </>}
        <label className="dialog-check"><input type="checkbox" checked={openInNewWindow} onChange={(event) => setOpenInNewWindow(event.target.checked)} />{t('Open in New Window')}</label>
        <footer><button type="button" onClick={close}>{t('Cancel')}</button><button type="button" className="primary" disabled={busy || !ready} onClick={() => void submit()}>{t(git ? 'Clone' : 'Checkout')}</button></footer>
      </DialogSurface>
    {providerOpen && <ProviderPanel mode="browse" close={() => setProviderOpen(false)} onClone={(repository: RemoteRepository, accountId) => {
      setUrl(repository.cloneUrl);
      setTargetName(repository.name);
      inferredNameRef.current = repository.name;
      setProviderAccountId(accountId);
      setProviderOpen(false);
    }} />}
  </>;
}
