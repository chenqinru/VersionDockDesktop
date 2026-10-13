import { editorDialog, type DialogRequest } from './dialogService';

type CommitMessage = { hash: string; shortHash: string; fullMessage: string };
type Options = {
  mode: 'edit' | 'squash';
  repositoryName: string;
  /** Commits in oldest-first order. */
  commits: CommitMessage[];
  t: (key: string, ...args: Array<string | number>) => string;
  submit: NonNullable<DialogRequest['submit']>;
  generate: NonNullable<DialogRequest['generate']>;
};

/** Both history and sync use the same message editor layout and wording. */
export function openCommitMessageEditor({ mode, repositoryName, commits, t, submit, generate }: Options): Promise<void> {
  const editing = mode === 'edit';
  return editorDialog({
    title: editing ? t('Edit Commit Message') : t('Squash {0} commits', commits.length),
    icon: editing ? 'edit' : 'fold',
    message: editing ? `${repositoryName} · ${commits[0].shortHash}` : `${repositoryName}\n${t('Edit the combined commit message below, then confirm.')}`,
    inputLabel: t('Commit message'),
    originalMessage: editing ? commits[0].fullMessage : undefined,
    itemsLabel: editing ? undefined : t('Commits being squashed'),
    items: editing ? undefined : commits.map((commit) => ({ id: commit.hash, displayId: commit.shortHash, label: commit.fullMessage })),
    initialValue: commits.map((commit) => commit.fullMessage).join('\n\n'),
    confirmLabel: editing ? t('Save') : t('Confirm Squash'),
    submit,
    generate,
  });
}
