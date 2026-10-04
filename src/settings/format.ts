import type { SettingPath } from './defaults';
import { themeChoices } from '../theme/catalog';
export type SettingsTranslator = (key: string, ...args: Array<string | number>) => string;
const optionLabels: Partial<Record<SettingPath, Record<string, string>>> = {
  theme: Object.fromEntries(themeChoices.map(choice => [choice.id, choice.label])),
  fileIconTheme: { material: 'Material Icons', catppuccin: 'Catppuccin Icons', seti: 'Seti / Minimal', codicon: 'Codicon (Classic)' },
  language: { system: 'System', zhCn: 'Simplified Chinese', en: 'English' },
  uiFontSize: { minimum: 'Minimum', small: 'Small', standard: 'Standard', large: 'Large', maximum: 'Maximum' },
  layoutDensity: { comfortable: 'Comfortable', compact: 'Compact' },
  'layout.fileViewMode': { tree: 'Tree view', list: 'List view' },
  changesDisplayMode: { simplified: 'Simplified', changelists: 'Changelists', vscode: 'VS Code style (Staged / Changes)' },
  defaultCommitAction: { commit: 'Commit', commitAndPush: 'Commit and push' },
  defaultSaveAction: { stash: 'Stash', shelf: 'Shelve' },
  onPushRejected: { prompt: 'Prompt', rebaseAndRetry: 'Rebase and retry', error: 'Error only' },
  updateProjectMethod: { rebase: 'Rebase', merge: 'Merge', branchDefault: 'Branch default' },
  updateProjectCleanWorkingTree: { shelve: 'Shelve', stash: 'Stash' },
  shelveComparisonBase: { local: 'Working tree', parent: 'Parent commit' },
  catFileFilterMode: { filters: 'Filters', textconv: 'Textconv', none: 'None' },
  fetchTags: { auto: 'Auto', all: 'All tags', none: 'No tags' },
  'aiConfig.executionMode': { provider: 'API provider', 'agent-cli': 'Agent CLI' },
  'aiConfig.provider': { openai: 'OpenAI', claude: 'Claude', gemini: 'Gemini', custom: 'Custom' },
  'aiConfig.apiProtocol': { 'chat-completions': 'Chat Completions', responses: 'Responses' },
};
export function formatSettingValue(path: SettingPath, value: unknown, t: SettingsTranslator): string {
  if (typeof value === 'boolean') return t(value ? 'Enabled' : 'Disabled');
  if (value == null || value === '') {
    if (path === 'externalEditor') return t('System default');
    if (path === 'aiConfig.apiUrl' || path === 'aiConfig.cliModel') return t('Provider default');
    return t('Not set');
  }
  if (typeof value === 'number') {
    const unit = path === 'autoFetchIntervalMinutes' ? t('minutes') : ['autoRefreshInterval', 'aiConfig.cliTimeoutSeconds'].includes(path) ? t('seconds') : path === 'largeFileSizeLimitMb' ? 'MB' : '';
    return `${value}${unit ? ` ${unit}` : ''}`;
  }
  if (Array.isArray(value)) {
    if (path === 'hiddenRepositoryIds') return value.length ? t('{0} hidden repositories', value.length) : t('All repositories');
    return value.length ? value.join(', ') : t('None');
  }
  if (typeof value === 'object') {
    if (path === 'externalEditor') return (value as { executable: string }).executable;
    return Object.keys(value).length ? t('{0} custom entries', Object.keys(value).length) : t('Automatic');
  }
  const key = optionLabels[path]?.[String(value)];
  return key ? t(key) : String(value);
}
