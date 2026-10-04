import { BranchStatusBarItem } from './BranchStatusBarItem';
import { ProfileStatusBarItem } from './ProfileStatusBarItem';
import { NotificationStatusBarItem } from './NotificationStatusBarItem';
import { UpdateStatusBarItem } from './UpdateStatusBarItem';
import { OperationStatusBarItem } from './OperationStatusBarItem';
import { LogStatusBarItem } from './LogStatusBarItem';
import { useTaskProgressStore } from '../../progress/taskProgressStore';
import { useAppStore } from '../../store/appStore';

export function StatusBar() {
  const ready = useAppStore((state) => state.ready);
  const showProfile = useAppStore((state) => state.bootstrap?.state.settings?.showProfileStatusBar ?? true);
  const snapshot = useAppStore((state) => state.snapshot);

  const hasTasks = useTaskProgressStore((state) => state.open || Object.keys(state.tasks).length > 0);

  if (!ready || !snapshot && !hasTasks) {
    return null;
  }

  return (
    <footer className="app-statusbar" role="contentinfo">
      <div className="statusbar-left">
        {snapshot && <><BranchStatusBarItem key={snapshot.workspace.id} />
        {showProfile && <ProfileStatusBarItem key={`profile:${snapshot.workspace.id}`} />}</>}
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
