import { Codicon } from './Codicon';
import { CommitDetailPanel } from './CommitDetailPanel';
import { useI18n } from '../i18n';
import { useAppStore } from '../store/appStore';

export function CommitDetailWorkspace() {
  const selectedCommits = useAppStore((state) => state.selectedCommits);
  const back = useAppStore((state) => state.backToHistory);
  const { t } = useI18n();
  const primary = selectedCommits[0];
  const multiple = selectedCommits.length > 1;
  const title = multiple ? t('Aggregated commit selection') : primary?.message ?? t('Select a commit');
  const revision = multiple
    ? t('{0} commits selected', selectedCommits.length)
    : primary ? t('Commit {0}', primary.shortHash) : '';

  return (
    <section className="commit-detail-workspace">
      <header className="commit-detail-workspace-header">
        <button type="button" onClick={back}><Codicon name="arrow-left" />{t('Back to history')}</button>
        <Codicon name="git-commit" />
        <code>{revision}</code>
        <strong title={title}>{title}</strong>
      </header>
      <CommitDetailPanel variant="workspace" onCollapse={back} />
    </section>
  );
}
