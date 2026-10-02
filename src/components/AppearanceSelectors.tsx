import { useMemo, type ReactNode, type KeyboardEvent } from 'react';
import type { FileIconThemePreference, ThemePreference } from '../bindings/generated';
import { useI18n } from '../i18n';
import { themeChoices } from '../theme/catalog';
import { resolveShikiTheme, type EffectiveTheme } from '../theme';
import { useShiki } from '../utils/useShiki';
import { FileIcon } from './FileIcon';
import { Codicon } from './Codicon';

function RadioCards<T extends string>({ label, value, choices, onChange, className }: {
  label: string;
  value: T;
  choices: Array<{ id: T; label: string; preview: ReactNode }>;
  onChange: (value: T) => void;
  className: string;
}) {
  const navigate = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next: number;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % choices.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index - 1 + choices.length) % choices.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = choices.length - 1;
    else return;
    event.preventDefault();
    const group = event.currentTarget.parentElement!;
    group.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
    onChange(choices[next].id);
  };
  return <div className={className} role="radiogroup" aria-label={label}>
    {choices.map((item, index) => <button key={item.id} type="button" role="radio" aria-label={item.label} aria-checked={value === item.id} tabIndex={value === item.id ? 0 : -1} className={`settings-preview-card ${value === item.id ? 'active' : ''}`} onClick={() => { if (value !== item.id) onChange(item.id); }} onKeyDown={(event) => navigate(event, index)}>
      <div aria-hidden="true" className="settings-preview-content">{item.preview}</div>
      <span className="settings-preview-caption">{item.label}</span>
    </button>)}
  </div>;
}

const sampleCode = 'let n=1;\nreturn n;';
function ThemeSample({ theme }: { theme: EffectiveTheme }) {
  const highlighter = useShiki();
  const tokens = useMemo(() => highlighter?.codeToTokens(sampleCode, { lang: 'typescript', theme: resolveShikiTheme(theme) }).tokens, [highlighter, theme]);
  return <div className="theme-preview-surface" data-theme={theme}>
    <div className="theme-sample-sidebar"><Codicon name="files" /><span /><span className="active" /></div>
    <pre>{sampleCode.split('\n').map((line, index) => <code key={index}>{tokens?.[index] ? tokens[index].map((token, i) => <span key={i} style={{ color: token.color }}>{token.content}</span>) : line}</code>)}</pre>
  </div>;
}
export function ThemePreviewSelector({ value, onChange }: { value: ThemePreference; onChange: (value: ThemePreference) => void }) {
  const { t } = useI18n();
  return <RadioCards label={t('Theme')} value={value} onChange={onChange} className="settings-theme-segmented" choices={themeChoices.map((item) => ({
    id: item.id,
    label: t(item.label),
    preview: item.id === 'system' ? <div className="theme-sample-system"><ThemeSample theme="light2026" /><ThemeSample theme="dark2026" /></div> : <ThemeSample theme={item.id} />,
  }))} />;
}

const iconThemes = [
  { id: 'material', label: 'Material Icons (Default)' },
  { id: 'catppuccin', label: 'Catppuccin Icons (Soft & Modern)' },
  { id: 'seti', label: 'Seti / Minimal (Clean & Simple)' },
  { id: 'codicon', label: 'Codicon (Classic Outline)' },
] as const;
const iconSamples = [
  { name: 'src', folder: true, open: true },
  { name: 'index.ts' }, { name: 'app.js' }, { name: 'photo.png' },
  { name: 'config.json' }, { name: 'notes.txt' },
];
export function FileIconThemePreviewSelector({ value, onChange }: { value: FileIconThemePreference; onChange: (value: FileIconThemePreference) => void }) {
  const { t } = useI18n();
  return <RadioCards label={t('File icon theme')} value={value} onChange={onChange} className="settings-file-icon-segmented" choices={iconThemes.map((item) => ({
    id: item.id,
    label: t(item.label),
    preview: <div className="settings-icon-samples">{iconSamples.map((sample) => <span key={sample.name} title={sample.name}><FileIcon {...sample} theme={item.id} /><small>{sample.name}</small></span>)}</div>,
  }))} />;
}
