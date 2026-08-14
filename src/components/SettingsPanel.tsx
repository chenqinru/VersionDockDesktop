import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import type { ExternalEditor, LanguagePreference, ThemePreference, UiFontSizePreference } from '../bindings/generated';
import { useI18n } from '../i18n';
import { useAppStore } from '../store/appStore';
import { Codicon } from './Codicon';

interface SettingsPanelProps {
  onClose: () => void;
}

const unsupportedStatus = 'Not implemented in Desktop';

const settingsCategories = [
  { id: 'settings-section-appearance-title', icon: 'color-mode', label: 'Appearance' },
  { id: 'settings-section-changes-title', icon: 'source-control', label: 'Changes and commit' },
  { id: 'settings-section-refresh-title', icon: 'sync', label: 'Refresh and startup' },
  { id: 'settings-section-repository-title', icon: 'repo', label: 'Repository and history' },
  { id: 'settings-section-ai-title', icon: 'sparkle', label: 'AI settings' },
  { id: 'settings-section-ai-prompts-title', icon: 'comment-discussion-sparkle', label: 'AI prompts' },
  { id: 'settings-section-editor-title', icon: 'code', label: 'Editor integration' },
  { id: 'settings-section-external-editor-title', icon: 'terminal', label: 'External editor' },
] as const;
type SettingsCategoryId = typeof settingsCategories[number]['id'];

export function SettingsPanel({ onClose }: SettingsPanelProps) {
  const { t } = useI18n();
  const closeButton = useRef<HTMLButtonElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [activeCategory, setActiveCategory] = useState<SettingsCategoryId>(settingsCategories[0].id);
  const theme = useAppStore((state) => state.bootstrap?.state.theme ?? 'system');
  const language = useAppStore((state) => state.bootstrap?.state.language ?? 'system');
  const uiFontSize = useAppStore((state) => state.bootstrap?.state.uiFontSize ?? 'standard');
  const fileViewMode = useAppStore((state) => state.bootstrap?.state.fileViewMode === 'list' ? 'list' : 'tree');
  const externalEditor = useAppStore((state) => state.bootstrap?.state.externalEditor);
  const setTheme = useAppStore((state) => state.setTheme);
  const setLanguage = useAppStore((state) => state.setLanguage);
  const setUiFontSize = useAppStore((state) => state.setUiFontSize);
  const setFileViewMode = useAppStore((state) => state.setFileViewMode);
  const setExternalEditor = useAppStore((state) => state.setExternalEditor);

  useEffect(() => {
    closeButton.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const scrollToCategory = (event: MouseEvent<HTMLAnchorElement>, id: SettingsCategoryId) => {
    event.preventDefault();
    const title = content.current?.querySelector<HTMLElement>(`#${id}`);
    if (title && content.current) {
      const containerRect = content.current.getBoundingClientRect();
      const titleRect = title.getBoundingClientRect();
      content.current.scrollTop = Math.max(0, content.current.scrollTop + titleRect.top - containerRect.top - 2);
    }
    setActiveCategory(id);
  };

  const updateActiveCategory = () => {
    const scrollContainer = content.current;
    if (!scrollContainer) return;
    const containerTop = scrollContainer.getBoundingClientRect().top;
    const current = settingsCategories.reduce<SettingsCategoryId>((active, category) => {
      const title = scrollContainer.querySelector<HTMLElement>(`#${category.id}`);
      return title && title.getBoundingClientRect().top - containerTop <= 28 ? category.id : active;
    }, settingsCategories[0].id);
    setActiveCategory(current);
  };

  return (
    <div
      className="settings-backdrop"
      role="presentation"
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <section
        className="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        <header className="settings-heading">
          <div className="settings-title">
            <Codicon name="settings-gear" />
            <span id="settings-title">{t('Settings')}</span>
          </div>
          <button ref={closeButton} type="button" aria-label={t('Close')} title={t('Close')} onClick={onClose}>
            <Codicon name="close" />
          </button>
        </header>

        <div className="settings-layout">
          <nav className="settings-nav" aria-label={t('Settings categories')}>
            {settingsCategories.map((category) => (
              <a
                key={category.id}
                className={activeCategory === category.id ? 'active' : ''}
                href={`#${category.id}`}
                aria-current={activeCategory === category.id ? 'location' : undefined}
                onClick={(event) => scrollToCategory(event, category.id)}
              >
                <Codicon name={category.icon} />
                <span>{t(category.label)}</span>
              </a>
            ))}
          </nav>

          <div ref={content} className="settings-content" onScroll={updateActiveCategory}>
            <SettingsSection id="settings-section-appearance" icon="color-mode" title={t('Appearance')}>
              <label className="settings-field">
                <span className="settings-label"><strong>{t('Theme')}</strong><small>{t('Choose the application color theme')}</small></span>
                <select aria-label={t('Theme')} value={theme} onChange={(event) => void setTheme(event.target.value as ThemePreference)}>
                  <option value="system">{t('System')}</option>
                  <option value="light">{t('Light')}</option>
                  <option value="dark">{t('Dark')}</option>
                </select>
              </label>
              <label className="settings-field">
                <span className="settings-label"><strong>{t('Language')}</strong><small>{t('Choose the application language')}</small></span>
                <select aria-label={t('Language')} value={language} onChange={(event) => void setLanguage(event.target.value as LanguagePreference)}>
                  <option value="system">{t('System')}</option>
                  <option value="zhCn">{t('Simplified Chinese')}</option>
                  <option value="en">{t('English')}</option>
                </select>
              </label>
              <label className="settings-field">
                <span className="settings-label"><strong>{t('UI font size')}</strong><small>{t('Choose the application UI font size')}</small></span>
                <select aria-label={t('UI font size')} value={uiFontSize} onChange={(event) => setUiFontSize(event.target.value as UiFontSizePreference)}>
                  <option value="minimum">{t('Minimum')}</option>
                  <option value="small">{t('Small')}</option>
                  <option value="standard">{t('Standard')}</option>
                  <option value="large">{t('Large')}</option>
                  <option value="maximum">{t('Maximum')}</option>
                </select>
              </label>
            </SettingsSection>

            <SettingsSection id="settings-section-changes" icon="source-control" title={t('Changes and commit')}>
              <label className="settings-field">
                <span className="settings-label"><strong>{t('File view')}</strong><small>{t('How changed files are grouped')}</small></span>
                <select aria-label={t('File view')} value={fileViewMode} onChange={(event) => setFileViewMode(event.target.value as 'tree' | 'list')}>
                  <option value="tree">{t('Tree view')}</option>
                  <option value="list">{t('List view')}</option>
                </select>
              </label>
              <UnsupportedSelect label={t('Changes display mode')} description={t('How to display changed files in the Changes tab.')} value={t('Simplified')} options={[t('Simplified'), t('Changelists'), t('VS Code native')]} />
              <UnsupportedSelect label={t('Default commit action')} description={t('Default action for the commit button.')} value={t('Commit')} options={[t('Commit'), t('Commit and push')]} />
              <UnsupportedSelect label={t('Default save action')} description={t('Default action for the Save button.')} value={t('Stash')} options={[t('Stash'), t('Shelve')]} />
              <UnsupportedToggle label={t('Prompt before adding untracked files')} description={t('Show a prompt when new untracked files are detected.')} checked />
              <UnsupportedToggle label={t('Suppress diverged branch warning')} description={t('Suppress the warning when branches have diverged.')} />
            </SettingsSection>

            <SettingsSection id="settings-section-refresh" icon="sync" title={t('Refresh and startup')}>
              <UnsupportedNumber label={t('Auto-refresh interval')} description={t('Auto-refresh interval in seconds; 0 disables it.')} value="0" min={0} suffix={t('seconds')} />
              <UnsupportedToggle label={t('Fetch on startup')} description={t('Automatically fetch all remotes when the app starts.')} />
              <UnsupportedToggle label={t('Reset view locations on startup')} description={t('Reset the saved workbench view positions when the app starts.')} />
              <UnsupportedToggle label={t('Notify on incoming commits')} description={t('Show a notification when incoming commits are available.')} checked />
              <UnsupportedToggle label={t('Notify on unpushed commits')} description={t('Show a notification when commits are ready to push.')} checked />
            </SettingsSection>

            <SettingsSection id="settings-section-repository" icon="repo" title={t('Repository and history')}>
              <UnsupportedNumber label={t('Repository scan depth')} description={t('Maximum depth of workspace subfolders to scan for repositories.')} value="1" min={0} max={10} />
              <UnsupportedTextArea label={t('Ignored folders')} description={t('Folder names or workspace-relative paths skipped during repository scanning.')} value="node_modules" />
              <UnsupportedNumber label={t('Maximum graph commits')} description={t('Maximum commits to load in the history graph.')} value="1000" min={100} max={10000} />
              <UnsupportedTextArea label={t('Project colors')} description={t('Map workspace or repository names to graph colors.')} value="{}" />
            </SettingsSection>

            <SettingsSection id="settings-section-ai" icon="sparkle" title={t('AI settings')}>
              <UnsupportedSelect label={t('AI provider')} description={t('Default provider used by VersionDock AI features.')} value={t('OpenAI')} options={[t('OpenAI'), t('Claude'), t('Gemini'), t('Custom')]} />
              <UnsupportedInput label={t('AI model')} description={t('Model name for VersionDock AI features.')} value="" />
              <UnsupportedInput label={t('AI API URL')} description={t('API endpoint URL for VersionDock AI features.')} value="" />
              <UnsupportedInput label={t('AI API key')} description={t('API key for VersionDock AI features.')} value="" type="password" />
              <UnsupportedNumber label={t('AI max input tokens')} description={t('Maximum estimated input tokens for VersionDock AI features.')} value="128000" min={4096} />
              <UnsupportedNumber label={t('AI max output tokens')} description={t('Maximum output-token ceiling for VersionDock AI features.')} value="128000" min={1024} max={128000} />
            </SettingsSection>

            <SettingsSection id="settings-section-ai-prompts" icon="comment-discussion-sparkle" title={t('AI prompts')}>
              <UnsupportedTextArea label={t('Commit message prompt')} description={t('Workspace: .vscode/ai-commit-message.prompt.md; global: prompt.md')} value={t('Built-in default prompt')} />
              <UnsupportedTextArea label={t('AI merge conflict prompt')} description={t('Workspace: .vscode/ai-merge-conflict.prompt.md; global: ai-merge-conflict.prompt.md')} value={t('Built-in default prompt')} />
              <UnsupportedTextArea label={t('Commit explanation prompt')} description={t('Workspace: .vscode/ai-commit-explanation.prompt.md; global: ai-commit-explanation.prompt.md')} value={t('Built-in default prompt')} />
              <UnsupportedTextArea label={t('AI commit composer prompt')} description={t('Workspace: .vscode/ai-commit-composer.prompt.md; global: ai-commit-composer.prompt.md')} value={t('Built-in default prompt')} />
              <UnsupportedTextArea label={t('AI code review prompt')} description={t('Workspace: .vscode/ai-code-review.prompt.md; global: ai-code-review.prompt.md')} value={t('Built-in default prompt')} />
            </SettingsSection>

            <SettingsSection id="settings-section-editor" icon="code" title={t('Editor integration')}>
              <UnsupportedToggle label={t('Git annotations')} description={t('Enable Git/SVN annotations in the editor.')} />
              <UnsupportedToggle label={t('Git ghost text')} description={t('Enable inline Git/SVN ghost text in the editor.')} checked />
            </SettingsSection>

            <ExternalEditorSettings id="settings-section-external-editor" editor={externalEditor} save={setExternalEditor} />
            <div className="settings-scroll-spacer" aria-hidden="true" />
          </div>
        </div>
      </section>
    </div>
  );
}

function SettingsSection({ id, icon, title, children }: { id: string; icon: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="settings-section" data-settings-section aria-labelledby={`${id}-title`}>
      <div className="settings-section-title" id={`${id}-title`}>
        <Codicon name={icon} />
        <span>{title}</span>
      </div>
      {children}
    </section>
  );
}

function UnsupportedLabel({ label, description }: { label: string; description: string }) {
  const { t } = useI18n();
  return <span className="settings-label"><strong>{label}</strong><small>{description}</small><em>{t(unsupportedStatus)}</em></span>;
}

function UnsupportedSelect({ label, description, value, options }: { label: string; description: string; value: string; options: string[] }) {
  return <label className="settings-field settings-unsupported"><UnsupportedLabel label={label} description={description} /><select aria-label={label} value={value} disabled onChange={() => undefined}>{options.map((option) => <option key={option}>{option}</option>)}</select></label>;
}

function UnsupportedInput({ label, description, value, type = 'text' }: { label: string; description: string; value: string; type?: 'text' | 'password' }) {
  return <label className="settings-field settings-unsupported"><UnsupportedLabel label={label} description={description} /><input aria-label={label} type={type} value={value} disabled readOnly onChange={() => undefined} /></label>;
}

function UnsupportedNumber({ label, description, value, min, max, suffix }: { label: string; description: string; value: string; min?: number; max?: number; suffix?: string }) {
  return <label className="settings-field settings-unsupported"><UnsupportedLabel label={label} description={description} /><span className="settings-number"><input aria-label={label} type="number" value={value} min={min} max={max} disabled readOnly />{suffix && <small>{suffix}</small>}</span></label>;
}

function UnsupportedTextArea({ label, description, value }: { label: string; description: string; value: string }) {
  return <label className="settings-block settings-unsupported"><UnsupportedLabel label={label} description={description} /><textarea aria-label={label} value={value} disabled readOnly /></label>;
}

function UnsupportedToggle({ label, description, checked = false }: { label: string; description: string; checked?: boolean }) {
  return <label className="settings-toggle settings-unsupported"><UnsupportedLabel label={label} description={description} /><input aria-label={label} type="checkbox" checked={checked} disabled readOnly /></label>;
}

function ExternalEditorSettings({ id, editor, save }: { id: string; editor: ExternalEditor | null | undefined; save: (executable: string, args: string[]) => void }) {
  const [executable, setExecutable] = useState(editor?.executable ?? '');
  const [args, setArgs] = useState(editor?.args.join('\n') ?? '');
  const { t } = useI18n();

  const canSave = executable.trim() !== (editor?.executable ?? '') || args !== (editor?.args.join('\n') ?? '');
  const submit = () => {
    if (!canSave) return;
    save(executable, args.split('\n').filter((argument) => argument.length > 0));
  };

  return (
    <section id={id} className="settings-section settings-editor" data-settings-section aria-labelledby={`${id}-title`}>
      <div className="settings-section-title" id={`${id}-title`}>
        <Codicon name="terminal" />
        <span>{t('External editor')}</span>
      </div>
      <form onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <label className="settings-input-field">
          <span className="settings-label-text">{t('Executable path')}</span>
          <input aria-label={t('Executable path')} value={executable} onChange={(event) => setExecutable(event.target.value)} placeholder={t('Executable path')} />
        </label>
        <label className="settings-input-field">
          <span className="settings-label-text">{t('Arguments')}</span>
          <textarea aria-label={t('Arguments')} value={args} onChange={(event) => setArgs(event.target.value)} placeholder={t('One argument per line')} />
        </label>
        <small className="settings-help">{t('Available placeholders: {path}, {relativePath}, {repo}')}</small>
        <div className="settings-editor-actions">
          <button type="submit" disabled={!canSave}>{t('Save')}</button>
        </div>
      </form>
    </section>
  );
}
