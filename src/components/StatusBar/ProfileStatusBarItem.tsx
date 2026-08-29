import { useCallback, useEffect, useRef, useState } from 'react';
import { Codicon } from '../Codicon';
import { useAppStore } from '../../store/appStore';
import { useBridge } from '../../platform/context';
import { useI18n } from '../../i18n';
import { ProfileMenuPopover } from './ProfileMenuPopover';
import type { GitIdentityState, SvnAccountState } from '../../bindings/generated';

export function ProfileStatusBarItem() {
  const bridge = useBridge();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [identityText, setIdentityText] = useState<string>('');
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const anchorRef = useRef<HTMLButtonElement>(null);

  const snapshot = useAppStore((state) => state.snapshot);
  const selectedRepoId = useAppStore((state) => state.selectedRepoId);

  const currentRepo = snapshot?.repositories.find((r) => r.meta.id === selectedRepoId) ?? snapshot?.repositories[0];
  const workspaceId = snapshot?.workspace.id;
  const currentRepoId = currentRepo?.meta.id;
  const currentRepoKind = currentRepo?.meta.kind;

  const refreshSummary = useCallback(async () => {
    if (!workspaceId || !currentRepoId) {
      return t('No profile');
    }
    try {
      if (currentRepoKind === 'git') {
        const data = await bridge.request<GitIdentityState>({
          type: 'gitIdentity',
          payload: { workspace_id: workspaceId, repo_id: currentRepoId },
        }, { showProgress: false });
        const name = data.effective.userName?.trim();
        return `Git: ${name || t('No profile')}`;
      } else if (currentRepoKind === 'svn') {
        const data = await bridge.request<SvnAccountState>({
          type: 'svnAccount',
          payload: { workspace_id: workspaceId, repo_id: currentRepoId },
        }, { showProgress: false });
        return `SVN: ${data.username || (data.passwordStored ? t('Authenticated') : t('No account detected'))}`;
      }
      return t('No profile');
    } catch {
      return t('No profile');
    }
  }, [bridge, currentRepoId, currentRepoKind, t, workspaceId]);

  useEffect(() => {
    let active = true;
    void refreshSummary().then((text) => {
      if (active) setIdentityText(text);
    });
    return () => {
      active = false;
    };
  }, [refreshSummary]);

  const handleClick = () => {
    if (!open && anchorRef.current) {
      setAnchorRect(anchorRef.current.getBoundingClientRect());
    }
    setOpen((prev) => !prev);
  };

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={`statusbar-item profile-status-item ${open ? 'active' : ''}`}
        title={`${identityText} · ${t('Click to manage profiles')}`}
        aria-label={`${identityText} · ${t('Click to manage profiles')}`}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={handleClick}
      >
        <Codicon name="account" />
        <span className="statusbar-label">{identityText || t('Git / SVN Accounts')}</span>
      </button>

      {open && (
        <ProfileMenuPopover
          anchorRect={anchorRect}
          onClose={() => {
            setOpen(false);
            void refreshSummary().then(setIdentityText);
          }}
        />
      )}
    </>
  );
}
