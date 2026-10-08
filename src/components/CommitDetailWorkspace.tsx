import { useState } from 'react';
import { Codicon } from './Codicon';
import { CommitDetailPanel } from './CommitDetailPanel';
import { WorkspaceHeader } from './WorkspaceHeader';
import { useI18n } from '../i18n';
import { useAppStore } from '../store/appStore';

export function CommitDetailWorkspace() {
  const [aiToolbar, setAiToolbar] = useState<HTMLDivElement | null>(null);
  const workspaceId = useAppStore((state) => state.snapshot?.workspace.id);
  const selectedCommits = useAppStore((state) => state.mode === 'update-details' ? state.updateDetailCommits : state.selectedCommits);
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
      <WorkspaceHeader className="commit-detail-workspace-header" backLabel={t('Back to history')} onBack={back} actions={<div ref={setAiToolbar} className="ai-explain-toolbar" />}>
        <div className="workspace-page-heading commit-detail-workspace-heading">
          <Codicon name="git-commit" />
          <span className="workspace-page-meta commit-detail-workspace-revision">{revision}</span>
          <strong title={title}>{title}</strong>
        </div>
      </WorkspaceHeader>
      <CommitDetailPanel key={`${workspaceId}:${updateDetails}:${selectedCommits.map((commit) => `${commit.repoId}:${commit.hash}`).join('|')}`} variant="workspace" updateDetails={updateDetails} aiToolbar={aiToolbar} onCollapse={back} />
    </section>
  );
}
