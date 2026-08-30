import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { DefaultCommitAction, DefaultSaveAction, ExternalEditor, LanguagePreference, ThemePreference, UiFontSizePreference } from '../bindings/generated';
import { useI18n } from '../i18n';
import { useAppStore } from '../store/appStore';
import { Codicon } from './Codicon';
import { EditorIcon } from './EditorIcons';
import { ProviderPanel } from './ProviderPanel';

interface SettingsPanelProps {
  onClose: () => void;
}

const settingsCategories = [
  { id: 'settings-section-appearance-title', sectionId: 'settings-section-appearance', icon: 'color-mode', label: 'Appearance' },
  { id: 'settings-section-changes-title', sectionId: 'settings-section-changes', icon: 'source-control', label: 'Changes and commit' },
  { id: 'settings-section-refresh-title', sectionId: 'settings-section-refresh', icon: 'sync', label: 'Refresh and startup' },
  { id: 'settings-section-repository-title', sectionId: 'settings-section-repository', icon: 'repo', label: 'Repository and history' },
  { id: 'settings-section-external-editor-title', sectionId: 'settings-section-external-editor', icon: 'terminal', label: 'External editor' },
  { id: 'settings-section-accounts-title', sectionId: 'settings-section-accounts', icon: 'accounts-view-bar-icon', label: 'Accounts and privacy' },
  { id: 'settings-section-about-title', sectionId: 'settings-section-about', icon: 'info', label: 'About and updates' },
] as const;

type SettingsCategoryId = typeof settingsCategories[number]['id'];

export function SettingsPanel({ onClose }: SettingsPanelProps) {
  const { t } = useI18n();
  const closeButton = useRef<HTMLButtonElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [activeCategory, setActiveCategory] = useState<SettingsCategoryId>(settingsCategories[0].id);
  const [searchQuery, setSearchQuery] = useState('');
  const [providersOpen, setProvidersOpen] = useState(false);

  const settings = useAppStore((state) => state.bootstrap?.state.settings);
  const theme = settings?.theme ?? 'system';
  const language = settings?.language ?? 'system';
  const uiFontSize = settings?.uiFontSize ?? 'standard';
  const fileViewMode = useAppStore((state) => (state.bootstrap?.state.layout?.fileViewMode ?? state.bootstrap?.state.fileViewMode) === 'list' ? 'list' : 'tree');
  const externalEditor = settings?.externalEditor;
  const repositories = useAppStore((state) => state.allRepositories);
  const runtime = useAppStore((state) => state.bootstrap?.runtime);
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
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const isSearching = searchQuery.trim().length > 0;

  return (
    <div
      className="settings-backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        {/* 顶部标题栏 */}
        <header className="settings-heading">
          <div className="settings-title">
            <Codicon name="settings-gear" />
            <span id="settings-title">{t('Settings')}</span>
          </div>
          <button
            ref={closeButton}
            type="button"
            className="settings-close-btn"
            aria-label={t('Close')}
            title={t('Close')}
            onClick={onClose}
          >
            <Codicon name="close" />
          </button>
        </header>

        <div className="settings-layout">
          {/* 左侧侧边栏 */}
          <aside className="settings-sidebar">
            <div className="settings-search-wrapper">
              <Codicon name="search" className="settings-search-icon" />
              <input
                ref={searchInputRef}
                type="text"
                className="settings-search-input"
                placeholder={t('Search settings...')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                aria-label={t('Search settings...')}
              />
              {searchQuery && (
                <button
                  type="button"
                  className="settings-search-clear"
                  aria-label={t('Clear')}
                  onClick={() => {
                    setSearchQuery('');
                    searchInputRef.current?.focus();
                  }}
                >
                  <Codicon name="close" />
                </button>
              )}
            </div>

            <nav className="settings-nav" aria-label={t('Settings categories')}>
              {settingsCategories.map((category) => {
                const isActive = !isSearching && activeCategory === category.id;
                return (
                  <a
                    key={category.id}
                    className={`settings-nav-item ${isActive ? 'active' : ''}`}
                    href={`#${category.id}`}
                    aria-current={isActive ? 'location' : undefined}
                    draggable={false}
                    onDragStart={(event) => event.preventDefault()}
                    onClick={(event) => {
                      event.preventDefault();
                      if (searchQuery) setSearchQuery('');
                      setActiveCategory(category.id);
                    }}
                  >
                    <span className="settings-nav-icon-badge">
                      <Codicon name={category.icon} />
                    </span>
                    <span className="settings-nav-text">{t(category.label)}</span>
                  </a>
                );
              })}
            </nav>
          </aside>

          {/* 右侧内容主视窗：纯正独立分类切换 */}
          <div ref={content} className="settings-content">
            {isSearching ? (
              <SearchResults
                query={searchQuery}
                settings={settings}
                theme={theme}
                language={language}
                uiFontSize={uiFontSize}
                fileViewMode={fileViewMode}
                externalEditor={externalEditor}
                setTheme={setTheme}
                setLanguage={setLanguage}
                setUiFontSize={setUiFontSize}
                setFileViewMode={setFileViewMode}
                setExternalEditor={setExternalEditor}
                updateSettings={updateSettings}
                openAbout={openAbout}
                onClose={onClose}
                onClearSearch={() => setSearchQuery('')}
              />
            ) : (
              <div className="settings-category-pane">
                {/* 1. 外观 Appearance */}
                {activeCategory === 'settings-section-appearance-title' && (
                  <SettingsSection id="settings-section-appearance" titleId="settings-section-appearance-title" icon="color-mode" title={t('Appearance')}>
                    <SettingsCard title={t('Appearance')} description={t('Choose the application color theme')}>
                      <ThemePreviewSelector value={theme} onChange={(val) => void setTheme(val)} />
                      <SettingSelect
                        label={t('Language')}
                        description={t('Choose the application language')}
                        value={language}
                        options={[
                          ['system', t('System')],
                          ['zhCn', t('Simplified Chinese')],
                          ['en', t('English')],
                        ]}
                        onChange={(value) => void setLanguage(value as LanguagePreference)}
                      />
                      <SettingSelect
                        label={t('UI font size')}
                        description={t('Choose the application UI font size')}
                        value={uiFontSize}
                        options={[
                          ['minimum', t('Minimum')],
                          ['small', t('Small')],
                          ['standard', t('Standard')],
                          ['large', t('Large')],
                          ['maximum', t('Maximum')],
                        ]}
                        onChange={(value) => void setUiFontSize(value as UiFontSizePreference)}
                      />
                    </SettingsCard>
                  </SettingsSection>
                )}

                {/* 2. 更改与提交 Changes and commit */}
                {activeCategory === 'settings-section-changes-title' && (
                  <SettingsSection id="settings-section-changes" titleId="settings-section-changes-title" icon="source-control" title={t('Changes and commit')}>
                    <SettingsCard title={t('Changes display mode')}>
                      <SettingSelect
                        label={t('File view')}
                        description={t('How changed files are grouped')}
                        value={fileViewMode}
                        options={[
                          ['tree', t('Tree view')],
                          ['list', t('List view')],
                        ]}
                        onChange={(value) => void setFileViewMode(value as 'tree' | 'list')}
                      />
                      <SettingSelect
                        label={t('Changes display mode')}
                        description={t('How to display changed files in the Changes tab.')}
                        value={settings?.changesDisplayMode ?? 'simplified'}
                        options={[
                          ['simplified', t('Simplified')],
                          ['changelists', t('Changelists')],
                        ]}
                        onChange={(value) => void updateSettings({ changesDisplayMode: value as 'simplified' | 'changelists' })}
                      />
                      <SettingSelect
                        label={t('Default commit action')}
                        description={t('Default action for the commit button.')}
                        value={settings?.defaultCommitAction ?? 'commit'}
                        options={[
                          ['commit', t('Commit')],
                          ['commitAndPush', t('Commit and push')],
                        ]}
                        onChange={(value) => void updateSettings({ defaultCommitAction: value as DefaultCommitAction })}
                      />
                      <SettingSelect
                        label={t('Default save action')}
                        description={t('Default action for the Save button.')}
                        value={settings?.defaultSaveAction ?? 'stash'}
                        options={[
                          ['stash', t('Stash')],
                          ['shelf', t('Shelve')],
                        ]}
                        onChange={(value) => void updateSettings({ defaultSaveAction: value as DefaultSaveAction })}
                      />
                    </SettingsCard>

                    <SettingsCard title={t('Warnings and editor annotations')}>
                      <SettingToggle
                        label={t('Prompt before adding untracked files')}
                        description={t('Show a prompt when new untracked files are detected.')}
                        checked={settings?.promptBeforeAddingUntracked ?? true}
                        onChange={(val) => void updateSettings({ promptBeforeAddingUntracked: val })}
                      />
                      <SettingToggle
                        label={t('Suppress diverged branch warning')}
                        description={t('Suppress the warning when branches have diverged.')}
                        checked={settings?.suppressDivergedWarning ?? false}
                        onChange={(val) => void updateSettings({ suppressDivergedWarning: val })}
                      />
                    </SettingsCard>
                  </SettingsSection>
                )}

                {/* 3. 刷新与启动 Refresh and startup */}
                {activeCategory === 'settings-section-refresh-title' && (
                  <SettingsSection id="settings-section-refresh" titleId="settings-section-refresh-title" icon="sync" title={t('Refresh and startup')}>
                    <SettingsCard title={t('Refresh and startup')}>
                      <SettingNumber
                        label={t('Auto-refresh interval')}
                        description={t('Auto-refresh interval in seconds; 0 disables it.')}
                        value={settings?.autoRefreshInterval ?? 0}
                        min={0}
                        max={86400}
                        suffix={t('seconds')}
                        onChange={(value) => void updateSettings({ autoRefreshInterval: value })}
                      />
                      <SettingToggle
                        label={t('Fetch on startup')}
                        description={t('Automatically fetch all remotes when the app starts.')}
                        checked={settings?.fetchOnStartup ?? false}
                        onChange={(value) => void updateSettings({ fetchOnStartup: value })}
                      />
                      <SettingToggle
                        label={t('Reset view locations on startup')}
                        description={t('Reset the saved workbench view positions when the app starts.')}
                        checked={settings?.resetViewLocationsOnStartup ?? false}
                        onChange={(value) => void updateSettings({ resetViewLocationsOnStartup: value })}
                      />
                    </SettingsCard>

                    <SettingsCard title={t('Notify on incoming commits')}>
                      <SettingToggle
                        label={t('Notify on incoming commits')}
                        description={t('Show a notification when incoming commits are available.')}
                        checked={settings?.notifyIncomingCommits ?? false}
                        onChange={(value) => void updateSettings({ notifyIncomingCommits: value })}
                      />
                      <SettingToggle
                        label={t('Notify on unpushed commits')}
                        description={t('Show a notification when commits are ready to push.')}
                        checked={settings?.notifyUnpushedCommits ?? false}
                        onChange={(value) => void updateSettings({ notifyUnpushedCommits: value })}
                      />
                      {runtime && !runtime.systemNotifications.available && <div className="settings-capability-warning" role="status">
                        <Codicon name="warning" />
                        <span>{t('System notifications are unavailable. Notifications will remain in the in-app notification center.')}</span>
                        {runtime.systemNotifications.detail && <small>{runtime.systemNotifications.detail}</small>}
                      </div>}
                    </SettingsCard>
                  </SettingsSection>
                )}

                {/* 4. 仓库与历史 Repository and history */}
                {activeCategory === 'settings-section-repository-title' && (
                  <SettingsSection id="settings-section-repository" titleId="settings-section-repository-title" icon="repo" title={t('Repository and history')}>
                    <SettingsCard title={t('Repository')}>
                      <SettingNumber
                        label={t('Repository scan depth')}
                        description={t('Maximum depth of workspace subfolders to scan for repositories.')}
                        value={settings?.repositoryScanDepth ?? 4}
                        min={0}
                        max={10}
                        onChange={(value) => void updateSettings({ repositoryScanDepth: value })}
                      />
                      <SettingNumber
                        label={t('Maximum graph commits')}
                        description={t('Maximum commits to load in the history graph.')}
                        value={settings?.maximumGraphCommits ?? 1000}
                        min={100}
                        max={10000}
                        onChange={(value) => void updateSettings({ maximumGraphCommits: value })}
                      />
                      <IgnoredFoldersSetting
                        folders={settings?.ignoredFolders ?? []}
                        onChange={(folders) => void updateSettings({ ignoredFolders: folders })}
                      />
                    </SettingsCard>

                    <SettingsCard title={t('Visible repositories')} description={t('Hidden repositories remain scanned and can be restored here.')}>
                      {repositories.length === 0 ? (
                        <div className="settings-empty-hint">{t('No repositories found')}</div>
                      ) : (
                        <div className="settings-repo-list">
                          {repositories.map((repo) => {
                            const hidden = new Set(settings?.hiddenRepositoryIds ?? []);
                            const isVisible = !hidden.has(repo.meta.id);
                            const currentColor = settings?.projectColors?.[repo.meta.id] ?? repo.meta.color;

                            return (
                              <div key={repo.meta.id} className="settings-repo-row">
                                <div className="settings-repo-info">
                                  <span className="settings-repo-color-dot" style={{ backgroundColor: currentColor }} />
                                  <Codicon name="repo" className="settings-repo-icon" />
                                  <span className="settings-repo-name">{repo.meta.name}</span>
                                </div>
                                <div className="settings-repo-controls">
                                  <label className="settings-color-picker-badge" title={t('Map workspace or repository names to graph colors.')}>
                                    <input
                                      aria-label={`${t('Project colors')}: ${repo.meta.name}`}
                                      type="color"
                                      value={currentColor}
                                      onChange={(event) =>
                                        void updateSettings({
                                          projectColors: { ...(settings?.projectColors ?? {}), [repo.meta.id]: event.target.value },
                                        })
                                      }
                                    />
                                    <span className="settings-color-picker-preview" style={{ backgroundColor: currentColor }} />
                                  </label>
                                  <label className="settings-switch mini" title={t('Visible repository: {0}', repo.meta.name)}>
                                    <input
                                      aria-label={t('Visible repository: {0}', repo.meta.name)}
                                      type="checkbox"
                                      checked={isVisible}
                                      onChange={(event) => {
                                        const next = new Set(hidden);
                                        if (event.target.checked) next.delete(repo.meta.id);
                                        else next.add(repo.meta.id);
                                        void updateSettings({ hiddenRepositoryIds: [...next] });
                                      }}
                                    />
                                    <span className="settings-switch-track">
                                      <span className="settings-switch-thumb" />
                                    </span>
                                  </label>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </SettingsCard>
                  </SettingsSection>
                )}

                {activeCategory === 'settings-section-accounts-title' && <SettingsSection id="settings-section-accounts" titleId="settings-section-accounts-title" icon="accounts-view-bar-icon" title={t('Accounts and privacy')}>
                  <SettingsCard title={t('Remote provider accounts')}><button type="button" className="settings-action-btn" onClick={() => setProvidersOpen(true)}><Codicon name="account" />{t('Manage GitHub and GitLab accounts')}</button></SettingsCard>
                  <SettingsCard title={t('Author avatars')}>
                    <SettingToggle label={t('Online author avatars')} description={t('Resolve GitHub noreply addresses to GitHub avatars.')} checked={settings?.onlineAvatarsEnabled ?? false} onChange={(value) => void updateSettings({ onlineAvatarsEnabled: value, ...(!value ? { gravatarEnabled: false } : {}) })} />
                    <SettingToggle label={t('Use Gravatar for other emails')} description={t('Send only a SHA-256 email hash to Gravatar.')} checked={(settings?.onlineAvatarsEnabled ?? false) && (settings?.gravatarEnabled ?? false)} onChange={(value) => void updateSettings({ gravatarEnabled: value })} />
                  </SettingsCard>
                </SettingsSection>}

                {/* 5. 外部编辑器 External editor */}
                {activeCategory === 'settings-section-external-editor-title' && (
                  <ExternalEditorSettings
                    id="settings-section-external-editor"
                    titleId="settings-section-external-editor-title"
                    editor={externalEditor}
                    save={setExternalEditor}
                  />
                )}

                {/* 6. 关于与更新 About and updates */}
                {activeCategory === 'settings-section-about-title' && (
                  <SettingsSection id="settings-section-about" titleId="settings-section-about-title" icon="info" title={t('About and updates')}>
                    <SettingsCard title={t('About and updates')}>
                      <SettingToggle
                        label={t('Check for updates automatically')}
                        description={t('Automatically check for new VersionDock releases on startup.')}
                        checked={settings?.autoCheckUpdates ?? true}
                        onChange={(value) => void updateSettings({ autoCheckUpdates: value })}
                      />
                    </SettingsCard>

                    <div className="settings-about-hero-card">
                      <div className="settings-about-brand">
                        <img
                          src={theme === 'light' ? './icons/versiondock-logo-light.png' : './icons/versiondock-logo-dark.png'}
                          alt="VersionDock Logo"
                          className="settings-about-logo"
                          onError={(e) => {
                            (e.currentTarget as HTMLImageElement).src = './icons/versiondock-logo-dark.png';
                          }}
                        />
                        <div className="settings-about-meta">
                          <div className="settings-about-name-row">
                            <span className="settings-about-app-name">VersionDock Desktop</span>
                            <span className="settings-about-badge">v0.1.0</span>
                          </div>
                          <span className="settings-about-desc">{t('Independent Git & SVN Workbench')}</span>
                        </div>
                      </div>

                      <div className="settings-about-actions">
                        <button
                          type="button"
                          className="settings-action-btn primary"
                          onClick={() => {
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
                            openAbout('changelog');
                          }}
                        >
                          <Codicon name="history" />
                          <span>{t('View Release Notes')}</span>
                        </button>
                      </div>
                    </div>
                  </SettingsSection>
                )}
              </div>
            )}
          </div>
        </div>
      </section>
      {providersOpen && <ProviderPanel mode="manage" close={() => setProvidersOpen(false)} />}
    </div>
  );
}

function SettingsSection({
  id,
  titleId,
  icon,
  title,
  children,
}: {
  id: string;
  titleId: string;
  icon: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="settings-section" role="region" aria-labelledby={titleId}>
      <div className="settings-section-title" id={titleId}>
        <Codicon name={icon} />
        <span>{title}</span>
      </div>
      {children}
    </section>
  );
}

function SettingsCard({
  title,
  description,
  children,
}: {
  title?: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="settings-card">
      {title && (
        <div className="settings-card-header">
          <span className="settings-card-title">{title}</span>
          {description && <span className="settings-card-desc">{description}</span>}
        </div>
      )}
      <div className="settings-card-body">{children}</div>
    </div>
  );
}

function SettingSelect({
  label,
  description,
  value,
  options,
  onChange,
}: {
  label: string;
  description: string;
  value: string;
  options: Array<[string, string]>;
  onChange: (value: string) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent | globalThis.MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const selectedOption = options.find(([k]) => k === value);
  const selectedText = selectedOption ? selectedOption[1] : value;

  return (
    <div className="settings-row">
      <span className="settings-label">
        <strong>{label}</strong>
        <small>{description}</small>
      </span>

      {/* 原生隐藏 select 保持测试与无障碍访问兼容 */}
      <select
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="settings-hidden-native-select"
        tabIndex={-1}
      >
        {options.map(([key, text]) => (
          <option key={key} value={key}>
            {text}
          </option>
        ))}
      </select>

      {/* 现代 macOS 风格自定义下拉菜单 */}
      <div className="settings-custom-select" ref={dropdownRef}>
        <button
          type="button"
          className={`settings-custom-select-trigger ${isOpen ? 'open' : ''}`}
          aria-haspopup="listbox"
          aria-expanded={isOpen}
          onClick={() => setIsOpen((prev) => !prev)}
        >
          <span className="settings-custom-select-val">{selectedText}</span>
          <Codicon name={isOpen ? 'chevron-up' : 'chevron-down'} />
        </button>

        {isOpen && (
          <div className="settings-custom-select-menu" role="listbox">
            {options.map(([key, text]) => {
              const isSelected = key === value;
              return (
                <button
                  key={key}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  className={`settings-custom-select-option ${isSelected ? 'active' : ''}`}
                  onClick={() => {
                    onChange(key);
                    setIsOpen(false);
                  }}
                >
                  <span className="settings-custom-select-option-text">{text}</span>
                  {isSelected && <Codicon name="check" />}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function SettingNumber({
  label,
  description,
  value,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
  step = 1,
  suffix,
  onChange,
}: {
  label: string;
  description: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  onChange: (value: number) => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<string | null>(null);
  const localText = draft ?? String(value);

  const handleStep = (delta: number) => {
    const next = Math.min(max, Math.max(min, value + delta));
    onChange(next);
  };

  const handleBlur = () => {
    const parsed = Number(localText);
    if (isNaN(parsed)) {
      setDraft(null);
    } else {
      const clamped = Math.min(max, Math.max(min, parsed));
      setDraft(null);
      if (clamped !== value) {
        onChange(clamped);
      }
    }
  };

  return (
    <div className="settings-row">
      <span className="settings-label">
        <strong>{label}</strong>
        <small>{description}</small>
      </span>

      {/* 原生隐藏 input 保持测试与无障碍访问兼容 */}
      <input
        aria-label={label}
        type="number"
        value={value}
        min={min}
        max={max}
        onChange={(event) => onChange(Number(event.target.value))}
        className="settings-hidden-native-input"
        tabIndex={-1}
      />

      {/* 现代 macOS 风格自定义数字调节步进器 */}
      <div className="settings-custom-stepper">
        <button
          type="button"
          className="settings-stepper-btn"
          disabled={value <= min}
          aria-label={t('Decrease')}
          onClick={() => handleStep(-step)}
        >
          <Codicon name="remove" />
        </button>

        <div className="settings-stepper-input-wrapper">
          <input
            type="text"
            inputMode="numeric"
            className="settings-stepper-input"
            value={localText}
          onFocus={() => setDraft(String(value))}
          onChange={(e) => setDraft(e.target.value)}
            onBlur={handleBlur}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleBlur();
              else if (e.key === 'ArrowUp') {
                e.preventDefault();
                handleStep(step);
              } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                handleStep(-step);
              }
            }}
          />
          {suffix && <span className="settings-stepper-suffix">{suffix}</span>}
        </div>

        <button
          type="button"
          className="settings-stepper-btn"
          disabled={value >= max}
          aria-label={t('Increase')}
          onClick={() => handleStep(step)}
        >
          <Codicon name="add" />
        </button>
      </div>
    </div>
  );
}

function IgnoredFoldersSetting({
  folders,
  onChange,
}: {
  folders: string[];
  onChange: (folders: string[]) => void;
}) {
  const { t } = useI18n();
  const [inputValue, setInputValue] = useState('');

  const handleAdd = (val?: string) => {
    const textToAdd = (val !== undefined ? val : inputValue).trim();
    if (!textToAdd) return;

    const items = textToAdd
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    const nextList = [...folders];
    for (const item of items) {
      if (!nextList.includes(item)) {
        nextList.push(item);
      }
    }
    onChange(nextList);
    setInputValue('');
  };

  const handleRemove = (folderToRemove: string) => {
    onChange(folders.filter((f) => f !== folderToRemove));
  };

  return (
    <div className="settings-row settings-row-block">
      <span className="settings-label">
        <strong>{t('Ignored folders')}</strong>
        <small>{t('Folder names or workspace-relative paths skipped during repository scanning.')}</small>
      </span>

      {/* 原生隐藏 textarea 保持测试与 a11y 兼容 */}
      <textarea
        aria-label={t('Ignored folders')}
        className="settings-hidden-native-textarea"
        value={folders.join('\n')}
        onChange={(event) => onChange(event.target.value.split('\n'))}
        tabIndex={-1}
      />

      {/* 现代 macOS 风格 Tag/Chip 列表管理器 */}
      <div className="settings-tags-container">
        <div className="settings-tags-list">
          {folders.length === 0 ? (
            <span className="settings-tags-empty">{t('No ignored folders configured')}</span>
          ) : (
            folders.map((folder) => (
              <span key={folder} className="settings-tag-chip" title={folder}>
                <Codicon name="folder" className="settings-tag-icon" />
                <span className="settings-tag-text">{folder}</span>
                <button
                  type="button"
                  className="settings-tag-remove-btn"
                  aria-label={`${t('Remove')} ${folder}`}
                  title={`${t('Remove')} ${folder}`}
                  onClick={() => handleRemove(folder)}
                >
                  <Codicon name="close" />
                </button>
              </span>
            ))
          )}
        </div>

        {/* 快捷添加输入条 */}
        <div className="settings-tag-input-row">
          <div className="settings-tag-input-wrapper">
            <Codicon name="folder-opened" className="settings-tag-input-icon" />
            <input
              type="text"
              className="settings-tag-input"
              placeholder={t('Type folder name and press Enter (e.g. node_modules, dist)...')}
              value={inputValue}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleAdd();
                }
              }}
            />
          </div>
          <button
            type="button"
            className="settings-tag-add-btn"
            disabled={!inputValue.trim()}
            onClick={() => handleAdd()}
          >
            <Codicon name="add" />
            <span>{t('Add')}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

function SettingToggle({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="settings-toggle settings-row">
      <span className="settings-label">
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
      <span className="settings-switch">
        <input
          aria-label={label}
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span className="settings-switch-track">
          <span className="settings-switch-thumb" />
        </span>
      </span>
    </label>
  );
}

function ThemePreviewSelector({
  value,
  onChange,
}: {
  value: ThemePreference;
  onChange: (theme: ThemePreference) => void;
}) {
  const { t } = useI18n();

  const themes = [
    { id: 'system' as const, label: t('System'), icon: 'color-mode', previewClass: 'theme-preview-system' },
    { id: 'light' as const, label: t('Light'), icon: 'sun', previewClass: 'theme-preview-light' },
    { id: 'dark' as const, label: t('Dark'), icon: 'moon', previewClass: 'theme-preview-dark' },
  ];

  return (
    <div className="settings-theme-row">
      {/* 隐藏并同步原生 select 以保证无障碍与自动化测试兼容 */}
      <select
        aria-label={t('Theme')}
        className="settings-theme-hidden-select"
        value={value}
        onChange={(e) => onChange(e.target.value as ThemePreference)}
      >
        <option value="system">{t('System')}</option>
        <option value="light">{t('Light')}</option>
        <option value="dark">{t('Dark')}</option>
      </select>

      {/* 现代分段预览控件 */}
      <div className="settings-theme-segmented" role="radiogroup" aria-label={t('Theme')}>
        {themes.map((item) => {
          const isSelected = value === item.id;
          return (
            <button
              key={item.id}
              type="button"
              role="radio"
              aria-checked={isSelected}
              className={`settings-theme-card ${isSelected ? 'active' : ''}`}
              onClick={() => onChange(item.id)}
            >
              <div className={`settings-theme-mock ${item.previewClass}`}>
                <div className="mock-window-bar">
                  <div className="mock-dot red" />
                  <div className="mock-dot yellow" />
                  <div className="mock-dot green" />
                </div>
                <div className="mock-window-content">
                  <div className="mock-sidebar" />
                  <div className="mock-main" />
                </div>
              </div>
              <div className="settings-theme-caption">
                <Codicon name={item.icon} />
                <span>{item.label}</span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
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

function ExternalEditorSettings({
  id,
  titleId,
  editor,
  save,
}: {
  id: string;
  titleId: string;
  editor: ExternalEditor | null | undefined;
  save: (executable: string, args: string[]) => void;
}) {
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
    <SettingsSection id={id} titleId={titleId} icon="terminal" title={t('External editor')}>
      <SettingsCard title={t('External editor')}>
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
                <span className="editor-icon-box">
                  <EditorIcon id={selectedMode} size={18} />
                </span>
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
                  <span className="editor-icon-box">
                    <EditorIcon id="none" size={18} />
                  </span>
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
                    <span className="editor-icon-box">
                      <EditorIcon id={opt.id} size={18} />
                    </span>
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
                  <span className="editor-icon-box">
                    <EditorIcon id="custom" size={18} />
                  </span>
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
      </SettingsCard>
    </SettingsSection>
  );
}

interface SearchResultsProps {
  query: string;
  settings: ReturnType<typeof useAppStore.getState>['bootstrap'] extends infer B
    ? B extends { state: { settings: infer S } }
      ? S
      : any
    : any;
  theme: ThemePreference;
  language: LanguagePreference;
  uiFontSize: UiFontSizePreference;
  fileViewMode: 'tree' | 'list';
  externalEditor: ExternalEditor | null | undefined;
  setTheme: (t: ThemePreference) => void;
  setLanguage: (l: LanguagePreference) => void;
  setUiFontSize: (f: UiFontSizePreference) => void;
  setFileViewMode: (m: 'tree' | 'list') => void;
  setExternalEditor: (executable: string, args: string[]) => void;
  updateSettings: (s: any) => Promise<any>;
  openAbout: (tab: 'about' | 'changelog') => void;
  onClose: () => void;
  onClearSearch?: () => void;
}

function SearchResults({
  query,
  settings,
  theme,
  language,
  uiFontSize,
  fileViewMode,
  externalEditor,
  setTheme,
  setLanguage,
  setUiFontSize,
  setFileViewMode,
  setExternalEditor,
  updateSettings,
  openAbout,
  onClearSearch,
}: SearchResultsProps) {
  const { t } = useI18n();
  const q = query.trim().toLowerCase();

  const match = (text: string) => text.toLowerCase().includes(q);

  // 1. 外观匹配项
  const appearanceItems: ReactNode[] = [];
  if (match(t('Theme')) || match(t('Appearance')) || match(t('Choose the application color theme')) || match('dark') || match('light') || match('system')) {
    appearanceItems.push(<ThemePreviewSelector key="theme" value={theme} onChange={(val) => void setTheme(val)} />);
  }
  if (match(t('Language')) || match(t('Simplified Chinese')) || match(t('English')) || match(t('Choose the application language')) || match('chinese') || match('english')) {
    appearanceItems.push(
      <SettingSelect
        key="lang"
        label={t('Language')}
        description={t('Choose the application language')}
        value={language}
        options={[
          ['system', t('System')],
          ['zhCn', t('Simplified Chinese')],
          ['en', t('English')],
        ]}
        onChange={(val) => void setLanguage(val as LanguagePreference)}
      />,
    );
  }
  if (match(t('UI font size')) || match(t('Font')) || match(t('Choose the application UI font size')) || match('size') || match('ui') || match('font')) {
    appearanceItems.push(
      <SettingSelect
        key="font"
        label={t('UI font size')}
        description={t('Choose the application UI font size')}
        value={uiFontSize}
        options={[
          ['minimum', t('Minimum')],
          ['small', t('Small')],
          ['standard', t('Standard')],
          ['large', t('Large')],
          ['maximum', t('Maximum')],
        ]}
        onChange={(val) => void setUiFontSize(val as UiFontSizePreference)}
      />,
    );
  }

  // 2. 更改与提交匹配项
  const changesItems: ReactNode[] = [];
  if (match(t('File view')) || match(t('Tree view')) || match(t('List view')) || match(t('How changed files are grouped'))) {
    changesItems.push(
      <SettingSelect
        key="file-view"
        label={t('File view')}
        description={t('How changed files are grouped')}
        value={fileViewMode}
        options={[
          ['tree', t('Tree view')],
          ['list', t('List view')],
        ]}
        onChange={(val) => void setFileViewMode(val as 'tree' | 'list')}
      />,
    );
  }
  if (match(t('Changes display mode')) || match(t('Simplified')) || match(t('Changelists')) || match(t('How to display changed files in the Changes tab.'))) {
    changesItems.push(
      <SettingSelect
        key="changes-mode"
        label={t('Changes display mode')}
        description={t('How to display changed files in the Changes tab.')}
        value={settings?.changesDisplayMode ?? 'simplified'}
        options={[
          ['simplified', t('Simplified')],
          ['changelists', t('Changelists')],
        ]}
        onChange={(val) => void updateSettings({ changesDisplayMode: val as 'simplified' | 'changelists' })}
      />,
    );
  }
  if (match(t('Default commit action')) || match(t('Commit and push')) || match(t('Default action for the commit button.'))) {
    changesItems.push(
      <SettingSelect
        key="commit-action"
        label={t('Default commit action')}
        description={t('Default action for the commit button.')}
        value={settings?.defaultCommitAction ?? 'commit'}
        options={[
          ['commit', t('Commit')],
          ['commitAndPush', t('Commit and push')],
        ]}
        onChange={(val) => void updateSettings({ defaultCommitAction: val as 'commit' | 'commitAndPush' })}
      />,
    );
  }
  if (match(t('Default save action')) || match(t('Shelve')) || match(t('Stash')) || match(t('Default action for the Save button.'))) {
    changesItems.push(
      <SettingSelect
        key="save-action"
        label={t('Default save action')}
        description={t('Default action for the Save button.')}
        value={settings?.defaultSaveAction ?? 'stash'}
        options={[
          ['stash', t('Stash')],
          ['shelve', t('Shelve')],
        ]}
        onChange={(val) => void updateSettings({ defaultSaveAction: val as 'stash' | 'shelve' })}
      />,
    );
  }
  if (match(t('Prompt before adding untracked files')) || match(t('Show a prompt when new untracked files are detected.')) || match(t('Warnings and editor annotations'))) {
    changesItems.push(
      <SettingToggle
        key="prompt-untracked"
        label={t('Prompt before adding untracked files')}
        description={t('Show a prompt when new untracked files are detected.')}
        checked={settings?.promptBeforeAddingUntracked ?? true}
        onChange={(val) => void updateSettings({ promptBeforeAddingUntracked: val })}
      />,
    );
  }
  if (match(t('Suppress diverged branch warning')) || match(t('Suppress the warning when branches have diverged.'))) {
    changesItems.push(
      <SettingToggle
        key="suppress-diverged"
        label={t('Suppress diverged branch warning')}
        description={t('Suppress the warning when branches have diverged.')}
        checked={settings?.suppressDivergedWarning ?? false}
        onChange={(val) => void updateSettings({ suppressDivergedWarning: val })}
      />,
    );
  }

  // 3. 刷新与启动匹配项
  const refreshItems: ReactNode[] = [];
  if (match(t('Auto-refresh interval')) || match(t('Auto-refresh interval in seconds; 0 disables it.')) || match(t('seconds'))) {
    refreshItems.push(
      <SettingNumber
        key="refresh-interval"
        label={t('Auto-refresh interval')}
        description={t('Auto-refresh interval in seconds; 0 disables it.')}
        value={settings?.autoRefreshInterval ?? 0}
        min={0}
        max={86400}
        suffix={t('seconds')}
        onChange={(val) => void updateSettings({ autoRefreshInterval: val })}
      />,
    );
  }
  if (match(t('Fetch on startup')) || match(t('Automatically fetch all remotes when the app starts.'))) {
    refreshItems.push(
      <SettingToggle
        key="fetch-startup"
        label={t('Fetch on startup')}
        description={t('Automatically fetch all remotes when the app starts.')}
        checked={settings?.fetchOnStartup ?? false}
        onChange={(val) => void updateSettings({ fetchOnStartup: val })}
      />,
    );
  }
  if (match(t('Reset view locations on startup')) || match(t('Reset the saved workbench view positions when the app starts.'))) {
    refreshItems.push(
      <SettingToggle
        key="reset-views"
        label={t('Reset view locations on startup')}
        description={t('Reset the saved workbench view positions when the app starts.')}
        checked={settings?.resetViewLocationsOnStartup ?? false}
        onChange={(val) => void updateSettings({ resetViewLocationsOnStartup: val })}
      />,
    );
  }
  if (match(t('Notify on incoming commits')) || match(t('Show a notification when incoming commits are available.'))) {
    refreshItems.push(
      <SettingToggle
        key="notify-incoming"
        label={t('Notify on incoming commits')}
        description={t('Show a notification when incoming commits are available.')}
        checked={settings?.notifyIncomingCommits ?? false}
        onChange={(val) => void updateSettings({ notifyIncomingCommits: val })}
      />,
    );
  }
  if (match(t('Notify on unpushed commits')) || match(t('Show a notification when commits are ready to push.'))) {
    refreshItems.push(
      <SettingToggle
        key="notify-unpushed"
        label={t('Notify on unpushed commits')}
        description={t('Show a notification when commits are ready to push.')}
        checked={settings?.notifyUnpushedCommits ?? false}
        onChange={(val) => void updateSettings({ notifyUnpushedCommits: val })}
      />,
    );
  }

  // 4. 仓库与历史匹配项
  const repoItems: ReactNode[] = [];
  if (match(t('Repository scan depth')) || match(t('Maximum depth of workspace subfolders to scan for repositories.'))) {
    repoItems.push(
      <SettingNumber
        key="scan-depth"
        label={t('Repository scan depth')}
        description={t('Maximum depth of workspace subfolders to scan for repositories.')}
        value={settings?.repositoryScanDepth ?? 4}
        min={0}
        max={10}
        onChange={(val) => void updateSettings({ repositoryScanDepth: val })}
      />,
    );
  }
  if (match(t('Maximum graph commits')) || match(t('Maximum commits to load in the history graph.'))) {
    repoItems.push(
      <SettingNumber
        key="graph-commits"
        label={t('Maximum graph commits')}
        description={t('Maximum commits to load in the history graph.')}
        value={settings?.maximumGraphCommits ?? 1000}
        min={100}
        max={10000}
        onChange={(val) => void updateSettings({ maximumGraphCommits: val })}
      />,
    );
  }
  if (match(t('Ignored folders')) || match(t('Folder names or workspace-relative paths skipped during repository scanning.')) || match('ignore') || match('node_modules')) {
    repoItems.push(
      <IgnoredFoldersSetting
        key="ignored-folders"
        folders={settings?.ignoredFolders ?? []}
        onChange={(folders) => void updateSettings({ ignoredFolders: folders })}
      />,
    );
  }

  // 5. 外部编辑器匹配项
  const isEditorMatched = match(t('External editor')) || match('editor') || match('vscode') || match('cursor') || match('sublime') || match('windsurf') || match('webstorm') || match('idea') || match('zed') || match('nvim');

  // 6. 关于与更新匹配项
  const aboutItems: ReactNode[] = [];
  if (match(t('Check for updates automatically')) || match(t('Automatically check for new VersionDock releases on startup.')) || match(t('About and updates')) || match(t('View Release Notes')) || match(t('About VersionDock & Check Updates'))) {
    aboutItems.push(
      <SettingToggle
        key="auto-update"
        label={t('Check for updates automatically')}
        description={t('Automatically check for new VersionDock releases on startup.')}
        checked={settings?.autoCheckUpdates ?? true}
        onChange={(val) => void updateSettings({ autoCheckUpdates: val })}
      />,
    );
    aboutItems.push(
      <div key="about-buttons" className="settings-row">
        <span className="settings-label">
          <strong>{t('About and updates')}</strong>
          <small>{t('View application details, version information and release notes.')}</small>
        </span>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            type="button"
            className="settings-action-btn"
            onClick={() => openAbout('about')}
          >
            {t('About VersionDock & Check Updates')}
          </button>
          <button
            type="button"
            className="settings-action-btn secondary"
            onClick={() => openAbout('changelog')}
          >
            {t('View Release Notes')}
          </button>
        </div>
      </div>,
    );
  }

  const sections: ReactNode[] = [];
  if (appearanceItems.length > 0) {
    sections.push(<SettingsCard key="sec-appearance" title={t('Appearance')}>{appearanceItems}</SettingsCard>);
  }
  if (changesItems.length > 0) {
    sections.push(<SettingsCard key="sec-changes" title={t('Changes and commit')}>{changesItems}</SettingsCard>);
  }
  if (refreshItems.length > 0) {
    sections.push(<SettingsCard key="sec-refresh" title={t('Refresh and startup')}>{refreshItems}</SettingsCard>);
  }
  if (repoItems.length > 0) {
    sections.push(<SettingsCard key="sec-repo" title={t('Repository and history')}>{repoItems}</SettingsCard>);
  }
  if (isEditorMatched) {
    sections.push(
      <ExternalEditorSettings
        key="sec-editor"
        id="settings-section-external-editor-search"
        titleId="settings-section-external-editor-search-title"
        editor={externalEditor}
        save={setExternalEditor}
      />,
    );
  }
  if (aboutItems.length > 0) {
    sections.push(<SettingsCard key="sec-about" title={t('About and updates')}>{aboutItems}</SettingsCard>);
  }

  return (
    <div className="settings-search-results">
      {sections.length === 0 ? (
        <div className="settings-search-empty">
          <div className="settings-search-empty-badge">
            <Codicon name="search" />
          </div>
          <h3 className="settings-search-empty-title">
            {t('No matching settings found for "{0}"', query)}
          </h3>
          <p className="settings-search-empty-desc">
            {t('Try searching with another keyword or check for typos.')}
          </p>
          {onClearSearch && (
            <button
              type="button"
              className="settings-search-empty-btn"
              onClick={onClearSearch}
            >
              <Codicon name="close" />
              <span>{t('Clear search')}</span>
            </button>
          )}
        </div>
      ) : (
        sections
      )}
    </div>
  );
}
