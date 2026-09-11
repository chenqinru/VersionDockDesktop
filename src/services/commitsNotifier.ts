/**
 * Notifies user of incoming (behind) and unpushed (ahead) commits.
 * Ported from VersionDock host/update/IncomingCommitsNotifier.ts & UnpushedCommitsNotifier.ts
 */

import type { BranchInfo, RepositoryStatus } from '../bindings/generated';

export interface CommitsCheckInput {
  repositories: RepositoryStatus[];
  branchesByRepo: Record<string, BranchInfo[]>;
  onPullAll: () => Promise<void>;
  onGoToPush: () => void;
  addNotification: (notification: {
    type: 'info' | 'warning' | 'success' | 'error';
    title: string;
    message: string | { key: string; args: Array<string | number> };
    actions?: Array<{ type: string; label: string; action?: () => void }>;
  }) => void;
  t: (key: string, ...args: Array<string | number>) => string;
}

let hasNotifiedIncomingThisSession = false;
let hasNotifiedUnpushedThisSession = false;

export function resetNotificationSessionState(): void {
  hasNotifiedIncomingThisSession = false;
  hasNotifiedUnpushedThisSession = false;
}

export function checkIncomingAndUnpushedCommits({
  repositories,
  branchesByRepo,
  onPullAll,
  onGoToPush,
  addNotification,
  t,
}: CommitsCheckInput): void {
  const gitRepos = repositories.filter((r) => r.meta.kind === 'git' && !r.meta.isWorktree);
  if (gitRepos.length === 0) return;

  // 1. Check Incoming Commits (behind)
  if (!hasNotifiedIncomingThisSession) {
    let totalBehind = 0;
    let reposWithBehind = 0;

    for (const repo of gitRepos) {
      const currentBranch = branchesByRepo[repo.meta.id]?.find((b) => b.current);
      const behind = currentBranch?.behind ?? 0;
      if (behind > 0) {
        totalBehind += behind;
        reposWithBehind += 1;
      }
    }

    if (totalBehind > 0) {
      hasNotifiedIncomingThisSession = true;
      const message =
        reposWithBehind === 1
          ? totalBehind === 1
            ? { key: 'VersionDock: {0} incoming commit available to pull.', args: [totalBehind] }
            : { key: 'VersionDock: {0} incoming commits available to pull.', args: [totalBehind] }
          : { key: 'VersionDock: {0} incoming commits across {1} repositories.', args: [totalBehind, reposWithBehind] };

      addNotification({
        type: 'info',
        title: t('Incoming commits'),
        message,
        actions: [
          {
            type: 'pullIncoming',
            label: t('Pull'),
            action: () => {
              void onPullAll();
            },
          },
        ],
      });
    }
  }

  // 2. Check Unpushed Commits (ahead)
  if (!hasNotifiedUnpushedThisSession) {
    let totalAhead = 0;
    let reposWithAhead = 0;

    for (const repo of gitRepos) {
      const currentBranch = branchesByRepo[repo.meta.id]?.find((b) => b.current);
      const ahead = currentBranch?.ahead ?? 0;
      if (ahead > 0) {
        totalAhead += ahead;
        reposWithAhead += 1;
      }
    }

    if (totalAhead > 0) {
      hasNotifiedUnpushedThisSession = true;
      const message =
        reposWithAhead === 1
          ? totalAhead === 1
            ? { key: 'VersionDock: {0} unpushed commit ready to push.', args: [totalAhead] }
            : { key: 'VersionDock: {0} unpushed commits ready to push.', args: [totalAhead] }
          : { key: 'VersionDock: {0} unpushed commits across {1} repositories.', args: [totalAhead, reposWithAhead] };

      addNotification({
        type: 'info',
        title: t('Unpushed commits'),
        message,
        actions: [
          {
            type: 'goToPush',
            label: t('Go to Sync'),
            action: onGoToPush,
          },
        ],
      });
    }
  }
}
