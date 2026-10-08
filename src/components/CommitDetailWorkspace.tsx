import { useState } from 'react';
import { Codicon } from './Codicon';
import { CommitDetailPanel } from './CommitDetailPanel';
import { useI18n } from '../i18n';
import { useAppStore } from '../store/appStore';

export function CommitDetailWorkspace() {
  const [aiToolbar, setAiToolbar] = useState<HTMLDivElement | null>(null);
  const workspaceId = useAppStore((state) => state.snapshot?.workspace.id);
  const selectedCommits = useAppStore((state) => state.selectedCommits);
  const updateDetails = useAppStore((state) => state.mode === 'update-details');
  const back = useAppStore((state) => state.backToHistory);
  const { t } = useI18n();
  const primary = selectedCommits[0];
  const multiple = selectedCommits.length > 1;
  const title = updateDetails ? t('Update details') : multiple ? t('Aggregated commit selection') : primary?.message ?? t('Select a commit');
  const revision = multiple || updateDetails
    ? t(selectedCommits.length === 1 ? '{0} commit selected' : '{0} commits selected', selectedCommits.length)
    : primary ? t('Commit {0}', primary.shortHash) : '';

  return (
    <section className="commit-detail-workspace">
      <header className="commit-detail-workspace-header">
        <button type="button" onClick={back}><Codicon name="arrow-left" />{t('Back to history')}</button>
        <Codicon name="git-commit" />
        <code>{revision}</code>
        <strong title={title}>{title}</strong>
        <div ref={setAiToolbar} className="ai-explain-toolbar" />
      </header>
      <CommitDetailPanel key={`${workspaceId}:${updateDetails}:${selectedCommits.map((commit) => `${commit.repoId}:${commit.hash}`).join('|')}`} variant="workspace" updateDetails={updateDetails} aiToolbar={aiToolbar} onCollapse={back} />
    </section>
  );
}
