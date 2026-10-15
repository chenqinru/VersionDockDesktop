import { FormField } from './FormField';
import { Textarea } from './Textarea';
import { Input } from './Input';
import { Button } from './Button';
import { useEffect, useState } from 'react';
import type { IgnoreRules } from '../bindings/generated';
import { useBridge } from '../platform/context';
import { useAppStore } from '../store/appStore';
import { useI18n } from '../i18n';
import { DialogSurface } from './DialogSurface';
import { IconButton } from './IconButton';
import { Codicon } from './Codicon';
import { isAbortError } from '../platform/bridge';

export function IgnoreRulesPanel({ repoId, directory: initialDirectory = '', close }: { repoId: string; directory?: string; close: () => void }) {
  const bridge = useBridge();
  const workspaceId = useAppStore((state) => state.snapshot?.workspace.id);
  const refresh = useAppStore((state) => state.refresh);
  const [prevInitialDirectory, setPrevInitialDirectory] = useState(initialDirectory);
  const [directory, setDirectory] = useState(initialDirectory);
  const [dirInput, setDirInput] = useState(initialDirectory);
  const [loadedDirectory, setLoadedDirectory] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [rules, setRules] = useState<IgnoreRules>();
  const [text, setText] = useState('');
  const [error, setError] = useState<string>();
  const { t } = useI18n();

  if (prevInitialDirectory !== initialDirectory) {
    setPrevInitialDirectory(initialDirectory);
    setDirectory(initialDirectory);
    setDirInput(initialDirectory);
    setLoadedDirectory(null);
  }

  const isLoading = loadedDirectory !== directory;
  const isRulesValid = !isLoading && Boolean(rules) && (rules?.directory ?? '') === directory;

  useEffect(() => {
    if (!workspaceId) return;
    const controller = new AbortController();
    void bridge.request<IgnoreRules>({ type: 'ignoreRules', payload: { workspace_id: workspaceId, repo_id: repoId, directory } }, { signal: controller.signal })
      .then((value) => {
        setRules(value);
        setText(value.patterns.join('\n'));
        setError(undefined);
        setLoadedDirectory(directory);
      })
      .catch((reason) => {
        if (!isAbortError(reason)) {
          setError(String(reason));
          setRules(undefined);
          setText('');
          setLoadedDirectory(directory);
        }
      });
    return () => controller.abort();
  }, [bridge, directory, repoId, workspaceId]);

  if (!workspaceId) return null;

  const handleSwitchDir = () => {
    const clean = dirInput.trim().replace(/^[/\\]+/, '').replace(/[/\\]+$/, '');
    if (clean === directory) return;
    setDirectory(clean);
  };

  const save = async () => {
    if (!isRulesValid || saving) return;
    try {
      setSaving(true);
      setError(undefined);
      await bridge.request({ type: 'updateIgnoreRules', payload: { workspace_id: workspaceId, repo_id: repoId, directory, patterns: text.split('\n') } });
      await refresh();
      close();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setSaving(false);
    }
  };

  return (
    <DialogSurface size="medium" className="app-dialog ignore-dialog" onClose={close} closeDisabled={saving} aria-labelledby="ignore-rules-title">
        <header>
          <Codicon name="exclude" />
          <strong id="ignore-rules-title">{t('Manage Ignore Rules')}</strong>
          <IconButton title={t('Close')} disabled={saving} onClick={close}><Codicon name="close" /></IconButton>
        </header>
        <div style={{ display: 'flex', gap: 6, marginBottom: 8, alignItems: 'center' }}>
          <label style={{ display: 'flex', flex: 1, gap: 6, alignItems: 'center', margin: 0 }}>
            <span style={{ fontSize: 11, color: 'var(--versiondock-muted)', whiteSpace: 'nowrap' }}>{t('Directory')}:</span>
            <Input controlSize="md"
              type="text"
              aria-label={t('Directory')}
              value={dirInput}
              placeholder={t('Directory (empty for root)')}
              onChange={(event) => setDirInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  handleSwitchDir();
                }
              }}
              style={{ flex: 1, padding: '3px 6px', fontSize: 12 }}
            />
          </label>
          <Button size="xs" type="button" onClick={handleSwitchDir}>
            {t('Switch')}
          </Button>
        </div>
        <p>{isRulesValid && rules ? `${rules.source}${rules.directory ? ` · ${rules.directory}` : ''}` : t('Loading…')}</p>
        <FormField label={t('One pattern per line')}>
          <Textarea controlSize="md"
            aria-label={t('Ignore patterns')}
            autoFocus
            disabled={!isRulesValid || saving}
            value={isRulesValid ? text : ''}
            onChange={(event) => setText(event.target.value)}
          />
        </FormField>
        {error && <div className="error-row" role="alert">{error}</div>}
        <footer>
          <Button onClick={close}>{t('Close')}</Button>
          <Button variant="primary" loading={saving} disabled={!isRulesValid || saving} onClick={() => void save()}>{t('Save')}</Button>
        </footer>
    </DialogSurface>
  );
}
