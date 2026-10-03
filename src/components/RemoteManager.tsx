import { DialogSurface } from './DialogSurface';
import { IconButton } from './IconButton';
import { useEffect, useRef, useState } from 'react';
import { Codicon } from './Codicon';
import { useI18n } from '../i18n';
import { isOperationActive, useAppStore } from '../store/appStore';
import { confirmDialog, promptDialog } from './dialogService';
import { ContextMenu } from './ContextMenu';
import type { RemoteInfo } from '../bindings/generated';
import { ProviderPanel } from './ProviderPanel';

export function RemoteManager({ repoId, close }: { repoId: string; close: () => void }) {
  const snapshot = useAppStore((state) => state.snapshot);
  const repo = snapshot?.repositories.find((r) => r.meta.id === repoId);
  const values = useAppStore((state) => state.remotes[repoId] ?? []);
  const load = useAppStore((state) => state.loadRemotes);
  const operate = useAppStore((state) => state.remoteOperation);
  const busy = useAppStore((state) => isOperationActive(state.operations, { repositoryId: repoId, domain: 'remote' }));

  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [context, setContext] = useState<{ x: number; y: number; remote: RemoteInfo }>();
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);

  const popover = useRef<HTMLElement>(null);
  const { t } = useI18n();

  useEffect(() => {
    void load(repoId);
  }, [load, repoId]);


  const add = () => {
    if (!name.trim() || !url.trim()) return;
    void operate(repoId, { type: 'add', name: name.trim(), url: url.trim() });
    setName('');
    setUrl('');
  };

  const showCopyHint = (text: string) => {
    setCopyFeedback(text);
    setTimeout(() => setCopyFeedback(null), 2000);
  };

  const handleCopy = async (text: string, label: string) => {
    await navigator.clipboard?.writeText(text).catch(() => undefined);
    showCopyHint(`${label} ${t('copied') || 'copied'}`);
  };

  const handleRename = async (remote: RemoteInfo) => {
    const next = await promptDialog({
      title: t('Rename'),
      message: remote.name,
      inputLabel: t('Remote name'),
      initialValue: remote.name,
    });
    if (next && next !== remote.name) {
      await operate(repoId, { type: 'rename', old_name: remote.name, new_name: next });
    }
  };

  const handleSetFetchUrl = async (remote: RemoteInfo) => {
    const next = await promptDialog({
      title: t('Set fetch URL'),
      message: remote.name,
      inputLabel: t('Fetch URL'),
      initialValue: remote.fetchUrl,
    });
    if (next) {
      await operate(repoId, { type: 'setUrl', name: remote.name, url: next, push: false });
    }
  };

  const handleSetPushUrl = async (remote: RemoteInfo) => {
    const next = await promptDialog({
      title: t('Set push URL'),
      message: remote.name,
      inputLabel: t('Push URL'),
      initialValue: remote.pushUrl,
    });
    if (next) {
      await operate(repoId, { type: 'setUrl', name: remote.name, url: next, push: true });
    }
  };

  const handlePrune = async (remote: RemoteInfo) => {
    await operate(repoId, { type: 'prune', name: remote.name });
  };

  const handleDelete = async (remote: RemoteInfo) => {
    const confirmed = await confirmDialog({
      title: t('Delete'),
      message: `${t('Remove remote {0}?', remote.name)}\n${remote.fetchUrl}`,
      danger: true,
    });
    if (confirmed) {
      await operate(repoId, { type: 'remove', name: remote.name });
    }
  };

  const runContext = async (id: string) => {
    const remote = context?.remote;
    if (!remote) return;
    if (id === 'copy-fetch') await handleCopy(remote.fetchUrl, t('Fetch URL'));
    if (id === 'copy-push') await handleCopy(remote.pushUrl, t('Push URL'));
    if (id === 'rename') await handleRename(remote);
    if (id === 'fetch-url') await handleSetFetchUrl(remote);
    if (id === 'push-url') await handleSetPushUrl(remote);
    if (id === 'prune') await handlePrune(remote);
    if (id === 'delete') await handleDelete(remote);
    setContext(undefined);
  };

  return (
    <>
    <DialogSurface preserveStyle ref={popover} className="modal-panel remote-manager-modal" onClose={close} aria-label={t('Manage Remotes')}>
        <header className="modal-header">
          <div className="modal-header-title">
            <Codicon name="remote-explorer" />
            <strong>{t('Manage Remotes')}</strong>
            {repo && <span className="modal-repo-badge">{repo.meta.name}</span>}
          </div>
          <IconButton
            type="button"
            className="modal-close-btn"
            title={t('Close')}
            onClick={close}
          >
            <Codicon name="close" />
          </IconButton>
        </header>

        <div className="modal-body remote-manager-body">
          {repo?.meta.kind === 'git' && values.length === 0 && <button type="button" className="primary" onClick={() => setPublishOpen(true)}><Codicon name="cloud-upload" />{t('Publish Repository')}</button>}
          {/* 添加远程表单 */}
          <div className="remote-add-card">
            <div className="remote-section-title">{t('Add Remote')}</div>
            <div className="remote-add-row">
              <input
                className="remote-input-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={t('Remote name (e.g. origin, upstream)')}
              />
              <input
                className="remote-input-url"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder={t('Remote URL (git@... or https://...)')}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') add();
                }}
              />
              <button
                type="button"
                className="primary remote-add-btn"
                disabled={busy || !name.trim() || !url.trim()}
                onClick={add}
              >
                <Codicon name="add" />
                <span>{t('Add')}</span>
              </button>
            </div>
          </div>

          {/* 远程仓库列表 */}
          <div className="remote-list-card">
            <div className="remote-section-title">{t('REMOTES')}</div>
            {values.length === 0 ? (
              <div className="remote-list-empty">
                <Codicon name="cloud" />
                <span>{t('No remotes configured')}</span>
              </div>
            ) : (
              <div className="remote-list">
                {values.map((remote) => (
                  <article
                    key={remote.name}
                    className="remote-list-item"
                    onContextMenu={(event) => {
                      event.preventDefault();
                      setContext({ x: event.clientX, y: event.clientY, remote });
                    }}
                  >
                    <div className="remote-item-icon">
                      <Codicon name="cloud" />
                    </div>

                    <div className="remote-item-info">
                      <div className="remote-item-header">
                        <strong className="remote-item-name">{remote.name}</strong>
                      </div>
                      <div className="remote-item-urls">
                        <div
                          className="remote-url-row"
                          title={remote.fetchUrl}
                          onClick={() => handleCopy(remote.fetchUrl, t('Fetch URL'))}
                        >
                          <span className="url-tag">{t('Fetch URL')}:</span>
                          <span className="url-text">{remote.fetchUrl}</span>
                          <Codicon name="copy" className="copy-icon" />
                        </div>
                        {remote.pushUrl !== remote.fetchUrl && (
                          <div
                            className="remote-url-row"
                            title={remote.pushUrl}
                            onClick={() => handleCopy(remote.pushUrl, t('Push URL'))}
                          >
                            <span className="url-tag">{t('Push URL')}:</span>
                            <span className="url-text">{remote.pushUrl}</span>
                            <Codicon name="copy" className="copy-icon" />
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="remote-item-actions">
                      <IconButton
                        type="button"
                        className="remote-action-icon-btn"
                        title={t('Rename')}
                        onClick={() => handleRename(remote)}
                      >
                        <Codicon name="edit" />
                      </IconButton>
                      <IconButton
                        type="button"
                        className="remote-action-icon-btn"
                        title={t('Set fetch URL')}
                        onClick={() => handleSetFetchUrl(remote)}
                      >
                        <Codicon name="link" />
                      </IconButton>
                      <IconButton
                        type="button"
                        className="remote-action-icon-btn"
                        title={t('Set push URL')}
                        onClick={() => handleSetPushUrl(remote)}
                      >
                        <Codicon name="cloud-upload" />
                      </IconButton>
                      <IconButton
                        type="button"
                        className="remote-action-icon-btn"
                        title={t('Prune')}
                        onClick={() => handlePrune(remote)}
                      >
                        <Codicon name="refresh" />
                      </IconButton>
                      <IconButton
                        type="button"
                        className="remote-action-icon-btn danger"
                        title={t('Delete')}
                        onClick={() => handleDelete(remote)}
                      >
                        <Codicon name="trash" />
                      </IconButton>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </div>
        </div>

        {copyFeedback && <div className="modal-toast">{copyFeedback}</div>}

        {context && (
          <ContextMenu
            x={context.x}
            y={context.y}
            items={[
              { id: 'rename', label: t('Rename'), icon: 'edit' },
              { id: 'fetch-url', label: t('Set fetch URL'), icon: 'link' },
              { id: 'push-url', label: t('Set push URL'), icon: 'cloud-upload' },
              { id: 'copy-fetch', label: t('Copy Fetch URL'), icon: 'copy' },
              { id: 'copy-push', label: t('Copy Push URL'), icon: 'copy' },
              { separator: true },
              { id: 'prune', label: t('Prune'), icon: 'refresh' },
              { id: 'delete', label: t('Delete'), icon: 'trash', danger: true },
            ]}
            onSelect={(id) => void runContext(id)}
            onClose={() => setContext(undefined)}
          />
        )}
    </DialogSurface>
      {publishOpen && <ProviderPanel mode="publish" repoId={repoId} close={() => { setPublishOpen(false); void load(repoId); }} />}
    </>
  );
}
