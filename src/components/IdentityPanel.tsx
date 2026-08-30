import { useCallback, useEffect, useState } from 'react';
import type { GitIdentityState, SvnAccountState } from '../bindings/generated';
import { useBridge } from '../platform/context';
import { useAppStore } from '../store/appStore';
import { useI18n } from '../i18n';
import { Codicon } from './Codicon';
import { confirmDialog } from './dialogService';

export function IdentityPanel({ repoId, close }: { repoId: string; close: () => void }) {
  const bridge = useBridge();
  const snapshot = useAppStore((state) => state.snapshot);
  const repo = snapshot?.repositories.find((item) => item.meta.id === repoId);
  const { t } = useI18n();

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [close]);

  if (!snapshot || !repo) return null;

  return (
    <div
      className="modal-backdrop identity-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <section
        className="modal-panel identity-panel"
        role="dialog"
        aria-modal="true"
        aria-label={repo.meta.kind === 'git' ? t('Git Identity') : t('SVN Account')}
      >
        <header className="modal-header">
          <div className="modal-header-title">
            <Codicon name="account" />
            <strong>{repo.meta.kind === 'git' ? t('Git Identity') : t('SVN Account')}</strong>
            <span className="modal-repo-badge">{repo.meta.name}</span>
          </div>
          <button
            type="button"
            className="modal-close-btn"
            title={t('Close')}
            onClick={close}
          >
            <Codicon name="close" />
          </button>
        </header>

        <div className="modal-body identity-body">
          {repo.meta.kind === 'git' ? (
            <GitIdentity
              bridge={bridge}
              workspaceId={snapshot.workspace.id}
              repoId={repoId}
              t={t}
            />
          ) : (
            <SvnAccount
              bridge={bridge}
              workspaceId={snapshot.workspace.id}
              repoId={repoId}
              t={t}
            />
          )}
        </div>
      </section>
    </div>
  );
}

type Bridge = ReturnType<typeof useBridge>;
type Translate = ReturnType<typeof useI18n>['t'];

function GitIdentity({
  bridge,
  workspaceId,
  repoId,
  t,
}: {
  bridge: Bridge;
  workspaceId: string;
  repoId: string;
  t: Translate;
}) {
  const [value, setValue] = useState<GitIdentityState>();
  const [label, setLabel] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string>();

  const load = useCallback(
    () =>
      bridge
        .request<GitIdentityState>({
          type: 'gitIdentity',
          payload: { workspace_id: workspaceId, repo_id: repoId },
        })
        .then(setValue)
        .catch((reason) => setError(String(reason))),
    [bridge, repoId, workspaceId]
  );

  useEffect(() => {
    void load();
  }, [load]);

  const operate = async (operation: {
    type: 'gitProfileOperation';
    payload: {
      workspace_id: string;
      repo_id: string;
      operation:
        | { type: 'save'; profile: { id: string; label: string; userName: string; email: string } }
        | { type: 'delete'; profile_id: string }
        | { type: 'select'; profile_id: string | null };
    };
  }) => {
    try {
      setError(undefined);
      setValue(await bridge.request<GitIdentityState>(operation));
    } catch (reason) {
      setError(String(reason));
    }
  };

  if (!value) return <div className="detail-loading">{error ?? t('Loading files...')}</div>;

  const getSourceLabel = (source: string) => {
    switch (source) {
      case 'local':
        return t('from .git/config');
      case 'global':
        return t('from ~/.gitconfig');
      case 'profile':
        return t('Custom Profile');
      default:
        return source;
    }
  };

  return (
    <div className="identity-content">
      {/* 当前生效身份卡片 */}
      <div className={`identity-effective-card ${value.effective.valid ? '' : 'invalid'}`}>
        <div className="effective-header">
          <Codicon name="pass-filled" />
          <span className="effective-label">
            {t('Effective identity')} · {getSourceLabel(value.effective.source)}
          </span>
        </div>
        <div className="effective-name">
          {value.effective.valid
            ? `${value.effective.userName} <${value.effective.email}>`
            : t('No valid Git identity')}
        </div>
      </div>

      {/* Profile 选择项 */}
      <div className="identity-form-row">
        <label className="identity-label-block">
          <span className="field-title">{t('Profile')}</span>
          <select
            aria-label={t('Profile')}
            className="identity-select"
            value={value.selectedProfileId ?? ''}
            onChange={(event) =>
              void operate({
                type: 'gitProfileOperation',
                payload: {
                  workspace_id: workspaceId,
                  repo_id: repoId,
                  operation: { type: 'select', profile_id: event.target.value || null },
                },
              })
            }
          >
            <option value="">{t('Auto · local → global')}</option>
            {value.profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.label} ({profile.userName} &lt;{profile.email}&gt;)
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* Local 与 Global 提示 */}
      <div className="identity-sources-card">
        {value.local ? (
          <div className="identity-source-item">
            <span>{t('Local')}: {value.local.userName} &lt;{value.local.email}&gt;</span>
          </div>
        ) : (
          <div className="identity-source-item muted">{t('No local git identity in this repo')}</div>
        )}
        {value.global ? (
          <div className="identity-source-item">
            <span>{t('Global')}: {value.global.userName} &lt;{value.global.email}&gt;</span>
          </div>
        ) : (
          <div className="identity-source-item muted">{t('No global git identity configured')}</div>
        )}
      </div>

      {/* 新建自定义身份 */}
      <div className="identity-add-section">
        <div className="identity-section-title">{t('New custom profile')}</div>
        <form
          className="identity-add-form"
          onSubmit={(event) => {
            event.preventDefault();
            const id = crypto.randomUUID();
            void operate({
              type: 'gitProfileOperation',
              payload: {
                workspace_id: workspaceId,
                repo_id: repoId,
                operation: { type: 'save', profile: { id, label, userName: name, email } },
              },
            }).then(() => {
              setLabel('');
              setName('');
              setEmail('');
            });
          }}
        >
          <div className="identity-inputs-grid">
            <input
              aria-label={t('Profile label')}
              placeholder={t('Profile Label (e.g. Work)')}
              value={label}
              onChange={(event) => setLabel(event.target.value)}
            />
            <input
              aria-label={t('User Name')}
              placeholder={t('User Name')}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <input
              aria-label={t('User Email')}
              placeholder={t('User Email')}
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
            <button
              className="primary identity-save-btn"
              disabled={!label.trim() || !name.trim() || !email.includes('@')}
              type="submit"
            >
              <Codicon name="save" />
              <span>{t('Save')}</span>
            </button>
          </div>
        </form>
      </div>

      {/* 已有 Profiles 列表 */}
      {value.profiles.length > 0 && (
        <div className="identity-profiles-section">
          <div className="identity-section-title">{t('PROFILES')}</div>
          <div className="identity-profiles-list">
            {value.profiles.map((profile) => (
              <article key={profile.id} className="identity-profile-item">
                <div className="profile-item-icon">
                  <Codicon name="account" />
                </div>
                <div className="profile-item-info">
                  <strong className="profile-item-label">{profile.label}</strong>
                  <span className="profile-item-detail">
                    {profile.userName} &lt;{profile.email}&gt;
                  </span>
                </div>
                <button
                  type="button"
                  className="profile-delete-btn danger"
                  title={t('Delete')}
                  onClick={() =>
                    void confirmDialog({
                      title: t('Delete'),
                      message: `${t('Delete')} ${profile.label}?`,
                      danger: true,
                    }).then((yes) => {
                      if (yes) {
                        return operate({
                          type: 'gitProfileOperation',
                          payload: {
                            workspace_id: workspaceId,
                            repo_id: repoId,
                            operation: { type: 'delete', profile_id: profile.id },
                          },
                        });
                      }
                    })
                  }
                >
                  <Codicon name="trash" />
                </button>
              </article>
            ))}
          </div>
        </div>
      )}

      {error && <div className="error-row">{error}</div>}
    </div>
  );
}

function SvnAccount({
  bridge,
  workspaceId,
  repoId,
  t,
}: {
  bridge: Bridge;
  workspaceId: string;
  repoId: string;
  t: Translate;
}) {
  const [value, setValue] = useState<SvnAccountState>();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();

  const load = useCallback(
    () =>
      bridge
        .request<SvnAccountState>({
          type: 'svnAccount',
          payload: { workspace_id: workspaceId, repo_id: repoId },
        })
        .then((next) => {
          setValue(next);
          setUsername(next.username ?? '');
        })
        .catch((reason) => setError(String(reason))),
    [bridge, repoId, workspaceId]
  );

  useEffect(() => {
    void load();
  }, [load]);

  const operate = async (
    operation:
      | { type: 'save'; username: string; password: string | null }
      | { type: 'delete' }
      | { type: 'test' }
      | { type: 'clearNative'; credential_id: string }
  ) => {
    try {
      setError(undefined);
      const next = await bridge.request<SvnAccountState>({
        type: 'svnAccountOperation',
        payload: { workspace_id: workspaceId, repo_id: repoId, operation },
      });
      setValue(next);
      setPassword('');
    } catch (reason) {
      setError(String(reason));
    }
  };

  if (!value) return <div className="detail-loading">{error ?? t('Loading files...')}</div>;

  const passwordEnabled = value.passwordStdinSupported && value.secureStorageAvailable;

  return (
    <div className="identity-content">
      <div className="identity-effective-card">
        <div className="effective-header">
          <Codicon name="repo" />
          <span className="effective-label">{t('Repository root')}</span>
        </div>
        <div className="effective-name">{value.repositoryRoot}</div>
        <small>{t('Credential source')}: {t(value.source ?? 'none')}</small>
      </div>

      {(value.nativeCredentials?.length ?? 0) > 0 && <div className="identity-sources-card"><strong>{t('SVN Native Cache')}</strong>{value.nativeCredentials?.map((credential) => <div className="identity-source-item" key={credential.id}><span>{credential.realm}{credential.username ? ` · ${credential.username}` : ''}</span><button className="danger" onClick={() => void operate({ type: 'clearNative', credential_id: credential.id })}><Codicon name="trash" />{t('Clear')}</button></div>)}</div>}

      <div className="identity-form-row">
        <label className="identity-label-block">
          <span className="field-title">{t('Username')}</span>
          <input
            className="identity-input"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
          />
        </label>
      </div>

      <div className="identity-form-row">
        <label className="identity-label-block">
          <span className="field-title">
            {t('Password')}{' '}
            <small className="field-hint">
              {passwordEnabled
                ? `· ${t('system secure storage')}`
                : `· ${t('use SVN credential cache')}`}
            </small>
          </span>
          <input
            className="identity-input"
            type="password"
            disabled={!passwordEnabled}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
      </div>

      <div className="identity-actions">
        <button
          type="button"
          className="primary"
          disabled={!username.trim()}
          onClick={() =>
            void operate({ type: 'save', username, password: password || null })
          }
        >
          <Codicon name="save" />
          <span>{t('Save')}</span>
        </button>

        <button
          type="button"
          onClick={() => void operate({ type: 'test' })}
        >
          <Codicon name="radio-tower" />
          <span>{t('Test connection')}</span>
        </button>

        {value.username && (
          <button
            type="button"
            className="danger"
            onClick={() => void operate({ type: 'delete' })}
          >
            <Codicon name="trash" />
            <span>{t('Delete')}</span>
          </button>
        )}
      </div>

      {value.connectionOk !== null && (
        <div className={value.connectionOk ? 'success-row' : 'error-row'}>
          <Codicon name={value.connectionOk ? 'pass' : 'error'} />
          <span>{value.connectionOk ? t('Connection successful') : t('Connection failed')}</span>
        </div>
      )}

      {error && <div className="error-row">{error}</div>}
    </div>
  );
}
