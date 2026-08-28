import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import type { DefaultCommitAction, DefaultSaveAction, ExternalEditor, LanguagePreference, ThemePreference, UiFontSizePreference } from '../bindings/generated';
import { useI18n } from '../i18n';
import { useAppStore } from '../store/appStore';
import { Codicon } from './Codicon';
import { EditorIcon } from './EditorIcons';

interface SettingsPanelProps {
  onClose: () => void;
}

const settingsCategories = [
  { id: 'settings-section-appearance-title', icon: 'color-mode', label: 'Appearance' },
  { id: 'settings-section-changes-title', icon: 'source-control', label: 'Changes and commit' },
  { id: 'settings-section-refresh-title', icon: 'sync', label: 'Refresh and startup' },
  { id: 'settings-section-repository-title', icon: 'repo', label: 'Repository and history' },
  { id: 'settings-section-external-editor-title', icon: 'terminal', label: 'External editor' },
  { id: 'settings-section-about-title', icon: 'info', label: 'About and updates' },
] as const;
type SettingsCategoryId = typeof settingsCategories[number]['id'];

export function SettingsPanel({ onClose }: SettingsPanelProps) {
  const { t } = useI18n();
  const closeButton = useRef<HTMLButtonElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [activeCategory, setActiveCategory] = useState<SettingsCategoryId>(settingsCategories[0].id);
  const settings = useAppStore((state) => state.bootstrap?.state.settings);
  const theme = settings?.theme ?? 'system';
  const language = settings?.language ?? 'system';
  const uiFontSize = settings?.uiFontSize ?? 'standard';
  const fileViewMode = useAppStore((state) => (state.bootstrap?.state.layout?.fileViewMode ?? state.bootstrap?.state.fileViewMode) === 'list' ? 'list' : 'tree');
  const externalEditor = settings?.externalEditor;
  const repositories = useAppStore((state) => state.allRepositories);
  const updateSettings = useAppStore((state) => state.updateSettings);
  const openAbout = useAppStore((state) => state.openAbout);
  const setTheme = useAppStore((state) => state.setTheme);
  const setLanguage = useAppStore((state) => state.setLanguage);
  const setUiFontSize = useAppStore((state) => state.setUiFontSize);
  const setFileViewMode = useAppStore((state) => state.setFileViewMode);
  const setExternalEditor = useAppStore((state) => state.setExternalEditor);

  useEffect(() => {
    closeButton.current?.focus();
  }, []);

  useEffect(() => {
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
              <SettingSelect label={t('Changes display mode')} description={t('How to display changed files in the Changes tab.')} value={settings?.changesDisplayMode ?? 'simplified'} onChange={(value) => void updateSettings({ changesDisplayMode: value as 'simplified' | 'changelists' })} options={[['simplified', t('Simplified')], ['changelists', t('Changelists')]]} />
              <SettingSelect label={t('Default commit action')} description={t('Default action for the commit button.')} value={settings?.defaultCommitAction ?? 'commit'} onChange={(value) => void updateSettings({ defaultCommitAction: value as DefaultCommitAction })} options={[['commit', t('Commit')], ['commitAndPush', t('Commit and push')]]} />
              <SettingSelect label={t('Default save action')} description={t('Default action for the Save button.')} value={settings?.defaultSaveAction ?? 'stash'} onChange={(value) => void updateSettings({ defaultSaveAction: value as DefaultSaveAction })} options={[['stash', t('Stash')], ['shelf', t('Shelve')]]} />
              <SettingToggle label={t('Prompt before adding untracked files')} description={t('Show a prompt when new untracked files are detected.')} checked={settings?.promptBeforeAddingUntracked ?? true} onChange={(value) => void updateSettings({ promptBeforeAddingUntracked: value })} />
              <SettingToggle label={t('Suppress diverged branch warning')} description={t('Suppress the warning when branches have diverged.')} checked={settings?.suppressDivergedWarning ?? false} onChange={(value) => void updateSettings({ suppressDivergedWarning: value })} />
            </SettingsSection>

            <SettingsSection id="settings-section-refresh" icon="sync" title={t('Refresh and startup')}>
              <SettingNumber label={t('Auto-refresh interval')} description={t('Auto-refresh interval in seconds; 0 disables it.')} value={settings?.autoRefreshInterval ?? 0} min={0} max={86400} suffix={t('seconds')} onChange={(value) => void updateSettings({ autoRefreshInterval: value })} />
              <SettingToggle label={t('Fetch on startup')} description={t('Automatically fetch all remotes when the app starts.')} checked={settings?.fetchOnStartup ?? false} onChange={(value) => void updateSettings({ fetchOnStartup: value })} />
              <SettingToggle label={t('Reset view locations on startup')} description={t('Reset the saved workbench view positions when the app starts.')} checked={settings?.resetViewLocationsOnStartup ?? false} onChange={(value) => void updateSettings({ resetViewLocationsOnStartup: value })} />
              <SettingToggle label={t('Notify on incoming commits')} description={t('Show a notification when incoming commits are available.')} checked={settings?.notifyIncomingCommits ?? false} onChange={(value) => void updateSettings({ notifyIncomingCommits: value })} />
              <SettingToggle label={t('Notify on unpushed commits')} description={t('Show a notification when commits are ready to push.')} checked={settings?.notifyUnpushedCommits ?? false} onChange={(value) => void updateSettings({ notifyUnpushedCommits: value })} />
            </SettingsSection>

            <SettingsSection id="settings-section-repository" icon="repo" title={t('Repository and history')}>
              <SettingNumber label={t('Repository scan depth')} description={t('Maximum depth of workspace subfolders to scan for repositories.')} value={settings?.repositoryScanDepth ?? 4} min={0} max={10} onChange={(value) => void updateSettings({ repositoryScanDepth: value })} />
              <label className="settings-block"><span className="settings-label"><strong>{t('Ignored folders')}</strong><small>{t('Folder names or workspace-relative paths skipped during repository scanning.')}</small></span><textarea aria-label={t('Ignored folders')} value={(settings?.ignoredFolders ?? []).join('\n')} onChange={(event) => void updateSettings({ ignoredFolders: event.target.value.split('\n') })} /></label>
              <SettingNumber label={t('Maximum graph commits')} description={t('Maximum commits to load in the history graph.')} value={settings?.maximumGraphCommits ?? 1000} min={100} max={10000} onChange={(value) => void updateSettings({ maximumGraphCommits: value })} />
              <div className="settings-block"><span className="settings-label"><strong>{t('Project colors')}</strong><small>{t('Map workspace or repository names to graph colors.')}</small></span><div className="settings-color-list">{repositories.map((repo) => <label key={repo.meta.id} className="settings-color-row"><span>{repo.meta.name}</span><input aria-label={`${t('Project colors')}: ${repo.meta.name}`} type="color" value={settings?.projectColors[repo.meta.id] ?? repo.meta.color} onChange={(event) => void updateSettings({ projectColors: { ...(settings?.projectColors ?? {}), [repo.meta.id]: event.target.value } })} /></label>)}</div></div>
              <div className="settings-block"><span className="settings-label"><strong>{t('Visible repositories')}</strong><small>{t('Hidden repositories remain scanned and can be restored here.')}</small></span><div className="settings-color-list">{repositories.map((repo) => { const hidden = new Set(settings?.hiddenRepositoryIds ?? []); return <label key={repo.meta.id} className="settings-color-row"><span>{repo.meta.name}</span><input aria-label={t('Visible repository: {0}', repo.meta.name)} type="checkbox" checked={!hidden.has(repo.meta.id)} onChange={(event) => { const next = new Set(hidden); if (event.target.checked) next.delete(repo.meta.id); else next.add(repo.meta.id); void updateSettings({ hiddenRepositoryIds: [...next] }); }} /></label>; })}</div></div>
            </SettingsSection>

            <ExternalEditorSettings id="settings-section-external-editor" editor={externalEditor} save={setExternalEditor} />

            <SettingsSection id="settings-section-about" icon="info" title={t('About and updates')}>
              <SettingToggle
                label={t('Check for updates automatically')}
                description={t('Automatically check for new VersionDock releases on startup.')}
                checked={settings?.autoCheckUpdates ?? true}
                onChange={(value) => void updateSettings({ autoCheckUpdates: value })}
              />
              <div className="settings-block">
                <span className="settings-label">
                  <strong>VersionDock Desktop v0.1.0</strong>
                  <small>{t('Independent Git & SVN Workbench')}</small>
                </span>
                <div className="settings-about-actions">
                  <button
                    type="button"
                    className="settings-action-btn primary"
                    onClick={() => {
                      onClose();
                      openAbout('about');
                    }}
                  >
                    <Codicon name="info" />
                    <span>{t('About VersionDock & Check Updates')}</span>
                  </button>
                  <button
                    type="button"
                    className="settings-action-btn"
                    onClick={() => {
                      onClose();
                      openAbout('changelog');
                    }}
                  >
                    <Codicon name="history" />
                    <span>{t('View Release Notes')}</span>
                  </button>
                </div>
              </div>
            </SettingsSection>
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

function SettingLabel({ label, description }: { label: string; description: string }) {
  return <span className="settings-label"><strong>{label}</strong><small>{description}</small></span>;
}

function SettingSelect({ label, description, value, options, onChange }: { label: string; description: string; value: string; options: Array<[string, string]>; onChange: (value: string) => void }) {
  return <label className="settings-field"><SettingLabel label={label} description={description} /><select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>{options.map(([key, text]) => <option key={key} value={key}>{text}</option>)}</select></label>;
}

function SettingNumber({ label, description, value, min, max, suffix, onChange }: { label: string; description: string; value: number; min?: number; max?: number; suffix?: string; onChange: (value: number) => void }) {
  return <label className="settings-field"><SettingLabel label={label} description={description} /><span className="settings-number"><input aria-label={label} type="number" value={value} min={min} max={max} onChange={(event) => onChange(Number(event.target.value))} />{suffix && <small>{suffix}</small>}</span></label>;
}

function SettingToggle({ label, description, checked, onChange }: { label: string; description: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <label className="settings-toggle"><SettingLabel label={label} description={description} /><input aria-label={label} type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /></label>;
}

interface EditorOption {
  id: string;
  name: string;
  executable: string;
  args: string[];
}

const EDITOR_OPTIONS: EditorOption[] = [
  { id: 'vscode', name: 'Visual Studio Code', executable: 'code', args: ['--reuse-window', '{path}'] },
  { id: 'cursor', name: 'Cursor', executable: 'cursor', args: ['--reuse-window', '{path}'] },
  { id: 'windsurf', name: 'Windsurf', executable: 'windsurf', args: ['--reuse-window', '{path}'] },
  { id: 'sublime', name: 'Sublime Text', executable: 'subl', args: ['{path}'] },
  { id: 'webstorm', name: 'WebStorm', executable: 'webstorm', args: ['{path}'] },
  { id: 'idea', name: 'IntelliJ IDEA', executable: 'idea', args: ['{path}'] },
];

function ExternalEditorSettings({ id, editor, save }: { id: string; editor: ExternalEditor | null | undefined; save: (executable: string, args: string[]) => void }) {
  const { t } = useI18n();
  const bridge = useAppStore((state) => state.bridge);
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const detectedMode = useMemo(() => {
    if (!editor?.executable || !editor.executable.trim()) return 'none';
    const match = EDITOR_OPTIONS.find(
      (opt) => opt.executable === editor.executable.trim() && opt.args.join('\n') === editor.args.join('\n'),
    );
    return match ? match.id : 'custom';
  }, [editor]);

  const [activeOverrideMode, setActiveOverrideMode] = useState<string | null>(null);
  const selectedMode = activeOverrideMode ?? detectedMode;

  const [customExecutable, setCustomExecutable] = useState(editor?.executable ?? '');

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent | globalThis.MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSelect = (mode: string) => {
    setIsOpen(false);
    setActiveOverrideMode(mode);
    if (mode === 'none') {
      save('', []);
    } else if (mode === 'custom') {
      setCustomExecutable(editor?.executable ?? '');
    } else {
      const option = EDITOR_OPTIONS.find((opt) => opt.id === mode);
      if (option) {
        save(option.executable, option.args);
      }
    }
  };

  const persist = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) {
      save('', []);
      return;
    }
    const execLower = trimmed.toLowerCase();
    const defaultArgs =
      execLower.includes('code') || execLower.includes('cursor') || execLower.includes('windsurf')
        ? ['--reuse-window', '{path}']
        : ['{path}'];
    save(trimmed, defaultArgs);
  };

  const handleBrowse = async () => {
    if (!bridge) return;
    const selected = await bridge.selectExecutable(t('Select editor application'));
    if (selected) {
      setCustomExecutable(selected);
      persist(selected);
    }
  };

  const getSelectedLabel = () => {
    if (selectedMode === 'none') return t('System default');
    if (selectedMode === 'custom') return t('Custom');
    const option = EDITOR_OPTIONS.find((opt) => opt.id === selectedMode);
    return option ? option.name : t('Custom');
  };

  return (
    <section id={id} className="settings-section settings-editor" data-settings-section aria-labelledby={`${id}-title`}>
      <div className="settings-section-title" id={`${id}-title`}>
        <Codicon name="terminal" />
        <span>{t('External editor')}</span>
      </div>

      <div className="settings-editor-dropdown-field">
        <label className="settings-label" id="external-editor-dropdown-label">
          <strong>{t('External editor')}</strong>
          <small>{t('Choose an editor to open files directly from VersionDock.')}</small>
        </label>

        <div className="editor-dropdown-container" ref={dropdownRef}>
          <button
            type="button"
            className="editor-dropdown-trigger"
            aria-haspopup="listbox"
            aria-expanded={isOpen}
            aria-labelledby="external-editor-dropdown-label"
            onClick={() => setIsOpen((prev) => !prev)}
          >
            <div className="editor-dropdown-trigger-val">
              <span className="editor-icon-box"><EditorIcon id={selectedMode} size={18} /></span>
              <span className="editor-name-text">{getSelectedLabel()}</span>
            </div>
            <Codicon name={isOpen ? 'chevron-up' : 'chevron-down'} />
          </button>

          {isOpen && (
            <div className="editor-dropdown-menu" role="listbox" tabIndex={-1}>
              <button
                type="button"
                role="option"
                aria-selected={selectedMode === 'none'}
                className={`editor-dropdown-item ${selectedMode === 'none' ? 'active' : ''}`}
                onClick={() => handleSelect('none')}
              >
                <span className="editor-icon-box"><EditorIcon id="none" size={18} /></span>
                <span className="editor-item-name">{t('System default')}</span>
                {selectedMode === 'none' && <Codicon name="check" />}
              </button>

              <div className="editor-dropdown-divider" />

              {EDITOR_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  role="option"
                  aria-selected={selectedMode === opt.id}
                  className={`editor-dropdown-item ${selectedMode === opt.id ? 'active' : ''}`}
                  onClick={() => handleSelect(opt.id)}
                >
                  <span className="editor-icon-box"><EditorIcon id={opt.id} size={18} /></span>
                  <span className="editor-item-name">{opt.name}</span>
                  {selectedMode === opt.id && <Codicon name="check" />}
                </button>
              ))}

              <div className="editor-dropdown-divider" />

              <button
                type="button"
                role="option"
                aria-selected={selectedMode === 'custom'}
                className={`editor-dropdown-item ${selectedMode === 'custom' ? 'active' : ''}`}
                onClick={() => handleSelect('custom')}
              >
                <span className="editor-icon-box"><EditorIcon id="custom" size={18} /></span>
                <span className="editor-item-name">{t('Custom')}</span>
                {selectedMode === 'custom' && <Codicon name="check" />}
              </button>
            </div>
          )}
        </div>
      </div>

      {selectedMode === 'custom' && (
        <div className="editor-custom-form">
          <label className="settings-input-field">
            <span className="settings-label-text">{t('Editor path or command')}</span>
            <div className="editor-input-with-browse">
              <input
                aria-label={t('Editor path or command')}
                value={customExecutable}
                onChange={(event) => {
                  const next = event.target.value;
                  setCustomExecutable(next);
                  persist(next);
                }}
                placeholder={t('e.g. zed, nvim, or choose application')}
                autoFocus
              />
              <button
                type="button"
                className="editor-browse-btn"
                title={t('Browse application path')}
                onClick={() => void handleBrowse()}
              >
                <Codicon name="folder-opened" />
                <span>{t('Browse...')}</span>
              </button>
            </div>
          </label>
        </div>
      )}
    </section>
  );
}
