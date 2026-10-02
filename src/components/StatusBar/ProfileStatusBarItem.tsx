import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Codicon } from '../Codicon';
import { useAppStore } from '../../store/appStore';
import { useI18n } from '../../i18n';
import { ProfileMenuPopover } from './ProfileMenuPopover';
import { ProfileStatusTooltip } from './ProfileStatusTooltip';
import { gitAccountName, svnAccountName } from './profileStatus';
import { useProfileStatus } from './useProfileStatus';

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
  const [hovering, setHovering] = useState(false);
  const [showTooltip, setShowTooltip] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    if (!hovering || open) return;
    hoverTimer.current = setTimeout(() => setShowTooltip(true), 500);
    return () => clearTimeout(hoverTimer.current);
  }, [hovering, open]);
  const close = useCallback(() => { setOpen(false); anchorRef.current?.focus(); }, []);
  const handleClick = () => {
    clearTimeout(hoverTimer.current); setShowTooltip(false); setHovering(false);
    if (!open && anchorRef.current) setAnchorRect(anchorRef.current.getBoundingClientRect());
    setOpen((prev) => !prev);
  };
  const identityText = currentRepo?.meta.kind === 'svn'
    ? `SVN: ${svnAccountName(data.svn[currentRepo.meta.id], t)}`
    : `Git: ${gitAccountName(data.git[currentRepo?.meta.id ?? ''], t)}`;
  const label = `${identityText} · ${t('Click to manage accounts and identities')}`;
  return <>
    <button ref={anchorRef} type="button" className={`statusbar-item profile-status-item ${open ? 'active' : ''}`}
      aria-label={label} aria-haspopup="dialog" aria-expanded={open} aria-describedby={showTooltip && !open ? 'profile-status-tooltip' : undefined}
      onMouseEnter={() => { if (anchorRef.current) setAnchorRect(anchorRef.current.getBoundingClientRect()); setHovering(true); }}
      onMouseLeave={(event) => { if (!(event.relatedTarget instanceof Element) || !event.relatedTarget.closest('#profile-status-tooltip')) { setHovering(false); setShowTooltip(false); } }}
      onFocus={() => { if (anchorRef.current) setAnchorRect(anchorRef.current.getBoundingClientRect()); }} onClick={handleClick}>
      <Codicon name="account" /><span className="statusbar-label">{identityText}</span>
    </button>
    {showTooltip && !open && anchorRect && <ProfileStatusTooltip data={data} repo={currentRepo} repositories={repositories} anchor={anchorRect} onManage={handleClick} onLeave={() => { setHovering(false); setShowTooltip(false); }} />}
    {open && <ProfileMenuPopover anchorRect={anchorRect} anchorRef={anchorRef} onClose={close} data={data} repositories={repositories} currentRepoId={currentRepo?.meta.id}
      onRepositoryChange={(repoId) => setSelection({ repoId, selectedRepoId })} />}
  </>;
}
