import { BranchStatusBarItem } from './BranchStatusBarItem';
import { ProfileStatusBarItem } from './ProfileStatusBarItem';
import { NotificationStatusBarItem } from './NotificationStatusBarItem';
import { UpdateStatusBarItem } from './UpdateStatusBarItem';
import { OperationStatusBarItem } from './OperationStatusBarItem';
import { LogStatusBarItem } from './LogStatusBarItem';
import { useAppStore } from '../../store/appStore';
import { useAppUpdateStore } from '../../store/appUpdateStore';

export function StatusBar() {
  const ready = useAppStore((state) => state.ready);
  const showProfile = useAppStore((state) => state.bootstrap?.state.settings?.showProfileStatusBar ?? true);
  const snapshot = useAppStore((state) => state.snapshot);
  const checking = useAppStore((state) => state.updateChecking);
  const update = useAppStore((state) => state.updateAvailableInfo);
  const updatePhase = useAppUpdateStore((state) => state.phase);

  if (!ready) {
    return null;
  }

  if (!snapshot) {
    if (!checking && !update?.available && !update?.error && updatePhase === 'idle') return null;
    return (
      <footer className="app-statusbar" role="contentinfo">
        <div className="statusbar-left" />
        <div className="statusbar-right"><UpdateStatusBarItem /></div>
      </footer>
    );
  }

  return (
    <footer className="app-statusbar" role="contentinfo">
      <div className="statusbar-left">
        <BranchStatusBarItem key={snapshot.workspace.id} />
        {showProfile && <ProfileStatusBarItem key={`profile:${snapshot.workspace.id}`} />}
      </div>
      <div className="statusbar-right">
        <OperationStatusBarItem />
        <UpdateStatusBarItem />
        <LogStatusBarItem />
        <NotificationStatusBarItem />
      </div>
    </footer>
  );
}
