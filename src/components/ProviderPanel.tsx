import { useState } from 'react';
import { DialogSurface } from './DialogSurface';
import { IconButton } from './IconButton';
import { Codicon } from './Codicon';
import { ProviderContent, type ProviderPanelProps } from './ProviderContent';
import { useI18n } from '../i18n';

export type { ProviderPanelProps } from './ProviderContent';

export function ProviderPanel(props: ProviderPanelProps) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  return <DialogSurface size="large" className="modal-panel provider-panel" onClose={props.close} closeDisabled={busy} aria-label={t('Remote Providers')}>
    <header className="modal-header">
      <Codicon name="cloud" /><strong>{t(props.mode === 'browse' ? 'Browse Remote Repositories' : props.mode === 'publish' ? 'Publish Repository' : 'Remote Providers')}</strong>
      <IconButton disabled={busy} onClick={props.close} title={t('Close')} aria-label={t('Close')}><Codicon name="close" /></IconButton>
    </header>
    <ProviderContent {...props} onBusyChange={setBusy} />
  </DialogSurface>;
}
