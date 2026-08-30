import { useAppStore } from '../store/appStore';
import { useI18n } from '../i18n';
import { Codicon } from './Codicon';

export function UpdateProjectReportDialog() {
  const report = useAppStore((state) => state.updateProjectReport); const dismiss = useAppStore((state) => state.dismissUpdateProjectReport); const open = useAppStore((state) => state.openUpdateResults); const { t } = useI18n();
  if (!report) return null;
  const details = report.results.flatMap((item) => item.result ? [item.result] : []).filter((item) => (item.summary?.commitCount ?? 0) > 0);
  return <div className="dialog-backdrop" role="presentation"><section className="app-dialog update-project-report" role="dialog" aria-modal="true" aria-label={t('Project update results')}><header><Codicon name="sync" /><strong>{t('Project update results')}</strong></header><div className="dialog-choice-list">{report.results.map((item) => <div key={item.repoId} className={item.error ? 'dialog-error' : ''}><strong>{item.repoName}</strong><span>{item.error ?? (item.result?.summaryError ? t('Updated; summary unavailable') : item.result?.summary?.kind === 'noChanges' ? t('No changes') : t('{0} commits · {1} files', item.result?.summary?.commitCount ?? 0, item.result?.summary?.fileCount ?? 0))}</span></div>)}</div><footer><button onClick={dismiss}>{t('Close')}</button>{details.length > 0 && <button className="primary" onClick={() => { dismiss(); void open(details); }}>{t('View Update Details')}</button>}</footer></section></div>;
}
