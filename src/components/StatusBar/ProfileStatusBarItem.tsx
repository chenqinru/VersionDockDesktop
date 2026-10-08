import { useCallback, useMemo, useRef, useState } from 'react';
import { Codicon } from '../Codicon';
import { useAppStore } from '../../store/appStore';
import { useI18n } from '../../i18n';
import { ProfileMenuPopover } from './ProfileMenuPopover';
import { ProfileStatusTooltip } from './ProfileStatusTooltip';
import { profileStatusName } from './profileStatus';
import { useProfileStatus } from './useProfileStatus';
import { useStatusTooltip } from './useStatusTooltip';
import { usePopoverToggleState } from './usePopoverToggleState';

export function ProfileStatusBarItem() {
  const { t } = useI18n();
  const snapshot = useAppStore((state) => state.snapshot);
  const selectedRepoId = useAppStore((state) => state.selectedRepoId);
  const [selection, setSelection] = useState<{ repoId: string; selectedRepoId?: string }>();
  const repositories = useMemo(() => snapshot?.repositories.filter((repo) => !repo.meta.isWorktree) ?? [], [snapshot?.repositories]);
  const repoId = selection?.selectedRepoId === selectedRepoId ? selection?.repoId ?? selectedRepoId : selectedRepoId;
  const currentRepo = repositories.find((repo) => repo.meta.id === repoId) ?? repositories[0];
  const data = useProfileStatus(snapshot?.workspace.id, repositories);
  const [open, setOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const tooltip = useStatusTooltip(open);
  const toggleState = usePopoverToggleState(open);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const dismissTooltip = tooltip.dismiss;
  const close = useCallback((restoreFocus = true) => { dismissTooltip(); setOpen(false); if (restoreFocus) anchorRef.current?.focus(); }, [dismissTooltip]);
  const handleClick = () => {
    tooltip.dismiss();
    const wasOpen = toggleState.consume();
    if (!wasOpen && anchorRef.current) setAnchorRect(anchorRef.current.getBoundingClientRect());
    setOpen(!wasOpen);
  };
  const kind = currentRepo?.meta.kind ?? 'git';
  const identityText = `${kind === 'svn' ? 'SVN' : 'Git'}: ${profileStatusName(kind, currentRepo?.meta.id ?? '', data, t)}`;
  const label = `${identityText} · ${t('Click to manage accounts and identities')}`;
  return <>
    <button ref={anchorRef} type="button" className={`statusbar-item profile-status-item ${open ? 'active' : ''}`}
      aria-label={label} aria-haspopup="dialog" aria-expanded={open} aria-describedby={tooltip.visible ? 'profile-status-tooltip' : undefined}
      onMouseEnter={() => { if (anchorRef.current) setAnchorRect(anchorRef.current.getBoundingClientRect()); tooltip.onMouseEnter(); }}
      onMouseLeave={(event) => { if (!(event.relatedTarget instanceof Element) || !event.relatedTarget.closest('#profile-status-tooltip')) { tooltip.onLeave(); } }}
      onPointerDownCapture={toggleState.onPointerDown}
      onPointerCancel={toggleState.onPointerCancel}
      onKeyDownCapture={toggleState.onKeyDown}
      onPointerDown={tooltip.onPointerDown}
      onFocus={() => { if (anchorRef.current) setAnchorRect(anchorRef.current.getBoundingClientRect()); tooltip.onFocus(); }}
      onBlur={(event) => { if (!(event.relatedTarget instanceof Element) || !event.relatedTarget.closest('#profile-status-tooltip')) tooltip.onBlur(); }}
      onKeyDown={tooltip.onKeyDown} onClick={handleClick}>
      <Codicon name="account" /><span className="statusbar-label">{identityText}</span>
    </button>
    {tooltip.visible && anchorRect && <ProfileStatusTooltip data={data} repo={currentRepo} repositories={repositories} anchor={anchorRect} onManage={() => { toggleState.clear(); handleClick(); }} onLeave={() => { tooltip.onLeave(); }} />}
    {open && <ProfileMenuPopover anchorRect={anchorRect} anchorRef={anchorRef} onClose={close} data={data} repositories={repositories} currentRepoId={currentRepo?.meta.id}
      onRepositoryChange={(repoId) => setSelection({ repoId, selectedRepoId })} />}
  </>;
}
