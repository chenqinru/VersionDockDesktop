import { useI18n } from '../i18n';
import { useAppStore } from '../store/appStore';
import { useAppUpdateStore } from '../store/appUpdateStore';
import { SettingSelect } from '../components/SettingSelect';
import { Codicon } from '../components/Codicon';
import { configureSimulation, useUpdateSimulation, type UpdateScenario } from './updateSimulation';

export default function UpdateSimulationPanel({ onReset }: { onReset: () => void }) {
  const { t } = useI18n();
  const { scenario, completed } = useUpdateSimulation();
  const reset = (next: UpdateScenario) => {
    configureSimulation(next);
    useAppUpdateStore.getState().resetSimulation();
    useAppStore.getState().setUpdateAvailableInfo(null);
    onReset();
  };
  return <section className="about-card update-simulation-panel">
    <div className="about-card-header">
      <div className="about-card-title"><Codicon name="beaker" /><strong>{t('Update simulation')}</strong></div>
      <button type="button" className="about-action-link" onClick={() => reset(scenario)}>{t('Reset simulation')}</button>
    </div>
    <p className="about-muted">{t('Development only. No real download, installation, restart, or saved preferences.')}</p>
    <SettingSelect label={t('Simulation scenario')} value={scenario} onChange={value => reset(value as UpdateScenario)} options={[
      ['available', t('New version available')], ['current', t('Already up to date')],
      ['check-error', t('Check failure')], ['download-error', t('Download failure, then retry')], ['restart-error', t('Restart failure, then retry')],
    ]} />
    {completed && <p className="update-status-row success" role="status">{t('Simulated restart complete. Reset to try again.')}</p>}
  </section>;
}
