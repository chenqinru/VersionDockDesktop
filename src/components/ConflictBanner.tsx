import { Codicon } from './Codicon';
import { useI18n } from '../i18n';

export interface ConflictBannerAction {
  id: string;
  label: string;
  title: string;
  tone: 'primary' | 'danger';
  onClick: () => void;
}

interface ConflictBannerProps {
  title?: string;
  summary: string;
  actions: ConflictBannerAction[];
}

export function ConflictBanner({ title, summary, actions }: ConflictBannerProps) {
  const { t } = useI18n();
  const displayTitle = title ?? t('There are still unresolved conflicts');

  return (
    <section className="vd-conflict-banner" aria-label={displayTitle}>
      <span className="vd-conflict-banner__signal" aria-hidden="true">
        <Codicon name="git-merge" />
      </span>
      <span className="vd-conflict-banner__copy" aria-live="polite">
        <span className="vd-conflict-banner__title">{displayTitle}</span>
        <span className="vd-conflict-banner__summary" title={summary}>
          {summary}
        </span>
      </span>
      <span className="vd-conflict-banner__actions">
        {actions.map((action) => (
          <button
            key={action.id}
            type="button"
            className={`vd-conflict-banner__action vd-conflict-banner__action--${action.tone}`}
            title={action.title}
            onClick={action.onClick}
          >
            {action.label}
          </button>
        ))}
      </span>
    </section>
  );
}
