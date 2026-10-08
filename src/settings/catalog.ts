import type { SettingPath } from './defaults';

export const settingsCategories = [
  { id: 'settings-section-appearance-title', sectionId: 'settings-section-appearance', icon: 'color-mode', label: 'Appearance' },
  { id: 'settings-section-ai-title', sectionId: 'settings-section-ai', icon: 'sparkle', label: 'AI' },
  { id: 'settings-section-changes-title', sectionId: 'settings-section-changes', icon: 'source-control', label: 'Changes and commit' },
  { id: 'settings-section-guard-title', sectionId: 'settings-section-guard', icon: 'shield', label: 'Commit & Safety Guard' },
  { id: 'settings-section-protection-title', sectionId: 'settings-section-protection', icon: 'lock', label: 'Branch & Push Protection' },
  { id: 'settings-section-update-title', sectionId: 'settings-section-update', icon: 'cloud-download', label: 'Update Project & Submodules' },
  { id: 'settings-section-diff-title', sectionId: 'settings-section-diff', icon: 'diff', label: 'Diff & Shelve' },
  { id: 'settings-section-refresh-title', sectionId: 'settings-section-refresh', icon: 'sync', label: 'Refresh and startup' },
  { id: 'settings-section-repository-title', sectionId: 'settings-section-repository', icon: 'repo', label: 'Repository and history' },
  { id: 'settings-section-external-editor-title', sectionId: 'settings-section-external-editor', icon: 'terminal', label: 'External editor' },
  { id: 'settings-section-accounts-title', sectionId: 'settings-section-accounts', icon: 'account', label: 'Accounts and privacy' },
  { id: 'settings-section-about-title', sectionId: 'settings-section-about', icon: 'info', label: 'About and updates' },
] as const;


export type SettingsCategoryId = typeof settingsCategories[number]['id'];
function fields(category: SettingsCategoryId, items: ReadonlyArray<readonly [SettingPath, string]>) {
  return items.map(([path, label]) => ({ path, label, category }));
}
export const settingDefinitions: ReadonlyArray<{ path: SettingPath; label: string; category: SettingsCategoryId }> = [
  ...fields('settings-section-appearance-title', [
    ['theme', 'Theme'], ['fileIconTheme', 'File icon theme'], ['language', 'Language'],
    ['uiFontSize', 'UI font size'], ['layoutDensity', 'Layout density'], ['scrollbarVisibility', 'Scrollbar visibility'], ['showTrayIcon', 'Show tray icon'], ['closeToTray', 'Keep in tray when closing windows'],
  ]),
  ...fields('settings-section-ai-title', [
    ['aiConfig.executionMode', 'Execution mode'], ['aiConfig.provider', 'Provider'],
    ['aiConfig.apiProtocol', 'API protocol'], ['aiConfig.apiUrl', 'API URL'], ['aiConfig.model', 'Model'],
    ['aiConfig.maxInputTokens', 'Maximum input tokens'], ['aiConfig.maxOutputTokens', 'Maximum output tokens'],
    ['aiConfig.cliProvider', 'Agent CLI'], ['aiConfig.cliModel', 'CLI model'], ['aiConfig.cliTimeoutSeconds', 'Timeout (seconds)'],
    ['aiConfig.cliExecutablePaths.claude', 'Claude executable path'], ['aiConfig.cliExecutablePaths.codex', 'Codex executable path'],
    ['aiConfig.cliExecutablePaths.antigravity', 'Antigravity executable path'], ['aiConfig.cliExecutablePaths.opencode', 'OpenCode executable path'],
  ]),
  ...fields('settings-section-changes-title', [
    ['layout.fileViewMode', 'File view'], ['changesDisplayMode', 'Changes display mode'],
    ['defaultCommitAction', 'Default commit action'], ['defaultSaveAction', 'Default save action'],
    ['promptBeforeAddingUntracked', 'Prompt before adding untracked files'], ['suppressDivergedWarning', 'Suppress diverged branch warning'],
  ]),
  ...fields('settings-section-guard-title', [
    ['noVerify', 'Bypass hooks (--no-verify)'], ['autoCommitResolvedMerge', 'Auto-commit resolved merge'],
    ['warnOnLargeFiles', 'Warn on large files'], ['largeFileSizeLimitMb', 'Large file size limit (MB)'],
    ['warnOnDetachedHead', 'Warn on detached HEAD'], ['warnOnCrlf', 'Warn on CRLF line separators'], ['warnOnInvalidFileNames', 'Warn on invalid file names'],
  ]),
  ...fields('settings-section-protection-title', [
    ['protectedBranches', 'Protected branches'], ['syncProtectedBranchesFromGithub', 'Sync protected branches from remote'],
    ['showPushDialogForProtectedBranches', 'Confirm before pushing to protected branches'], ['onPushRejected', 'On push rejected'],
    ['branchCleanCharacter', 'Branch clean character'], ['useSafeForcePush', 'Use safe force push (--force-with-lease)'],
    ['cherryPickAddSuffix', 'Add suffix when cherry-picking'],
  ]),
  ...fields('settings-section-update-title', [
    ['updateProjectMethod', 'Update project method'], ['updateProjectCleanWorkingTree', 'Clean working tree before update'],
    ['updateProjectShowNotification', 'Show update notification'], ['cloneRecursiveSubmodules', 'Recursively clone submodules'],
  ]),
  ...fields('settings-section-diff-title', [['shelveComparisonBase', 'Shelve diff comparison base'], ['catFileFilterMode', 'Cat-file filter mode']]),
  ...fields('settings-section-refresh-title', [
    ['autoFetchIntervalMinutes', 'Automatic fetch interval'], ['autoRefreshInterval', 'Auto-refresh interval'],
    ['fetchOnStartup', 'Fetch on startup'], ['autoFetchOnFocus', 'Fetch when window regains focus'],
    ['resetViewLocationsOnStartup', 'Reset view locations on startup'], ['notifyIncomingCommits', 'Notify on incoming commits'],
    ['notifyUnpushedCommits', 'Notify on unpushed commits'],
  ]),
  ...fields('settings-section-repository-title', [
    ['repositoryScanDepth', 'Repository scan depth'], ['maximumGraphCommits', 'Maximum graph commits'], ['ignoredFolders', 'Ignored folders'],
    ['fetchTags', 'Fetch tags'], ['excludeIgnoredDirectories', 'Exclude ignored directories'],
    ['projectColors', 'Project colors'], ['hiddenRepositoryIds', 'Visible repositories'],
  ]),
  { path: 'externalEditor', label: 'External editor', category: 'settings-section-external-editor-title' },
  ...fields('settings-section-accounts-title', [
    ['showProfileStatusBar', 'Show account and identity status bar'], ['onlineAvatarsEnabled', 'Online author avatars'],
    ['avatarCrossPlatformFallback', 'Search other connected platforms'], ['gravatarEnabled', 'Use Gravatar for other emails'],
  ]),
  { path: 'autoCheckUpdates', label: 'Check for updates automatically', category: 'settings-section-about-title' },
];
