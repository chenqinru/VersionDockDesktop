import { BranchStatusBarItem } from './BranchStatusBarItem';
import { ProfileStatusBarItem } from './ProfileStatusBarItem';
import { NotificationStatusBarItem } from './NotificationStatusBarItem';
import { UpdateStatusBarItem } from './UpdateStatusBarItem';
import { OperationStatusBarItem } from './OperationStatusBarItem';
import { LogStatusBarItem } from './LogStatusBarItem';
import { useAppStore } from '../../store/appStore';

export function StatusBar() {
  const ready = useAppStore((state) => state.ready);
  const snapshot = useAppStore((state) => state.snapshot);

  if (!ready || !snapshot) {
    return null;
  }

  return (
    <footer className="app-statusbar" role="contentinfo">
      <div className="statusbar-left">
        <BranchStatusBarItem key={snapshot.workspace.id} />
        <ProfileStatusBarItem />
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
