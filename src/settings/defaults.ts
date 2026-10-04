import generated from './defaults.generated.json';
import type { AiConfig, DesktopSettings, LayoutState } from '../bindings/generated';

// Generated from the Rust defaults by `npm run bindings` and checked during builds.
export const DEFAULT_SETTINGS = generated.settings as DesktopSettings;
export const DEFAULT_LAYOUT = generated.layout as LayoutState;
export const DEFAULT_AI_CONFIG = DEFAULT_SETTINGS.aiConfig!;
export type SettingPath = Exclude<keyof DesktopSettings, 'aiConfig'>
  | `aiConfig.${Exclude<keyof AiConfig, 'cliExecutablePaths'>}`
  | `aiConfig.cliExecutablePaths.${'claude' | 'codex' | 'antigravity' | 'opencode'}`
  | 'layout.fileViewMode';

export function effectiveAiConfig(config?: AiConfig): AiConfig {
  return { ...DEFAULT_AI_CONFIG, ...config, cliExecutablePaths: { ...DEFAULT_AI_CONFIG.cliExecutablePaths, ...config?.cliExecutablePaths } };
}
export function effectiveSettings(settings?: DesktopSettings): DesktopSettings {
  return { ...DEFAULT_SETTINGS, ...settings, aiConfig: effectiveAiConfig(settings?.aiConfig) };
}
export function settingValue(path: SettingPath, settings: DesktopSettings, layout?: LayoutState): unknown {
  if (path === 'layout.fileViewMode') return layout?.fileViewMode ?? DEFAULT_LAYOUT.fileViewMode;
  return path.split('.').reduce<unknown>((value, key) => value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined, settings);
}
export function defaultSettingValue(path: SettingPath): unknown {
  return settingValue(path, DEFAULT_SETTINGS, DEFAULT_LAYOUT);
}
function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => [key, stableValue(val)]));
  return value;
}
export function isSettingModified(path: SettingPath, settings: DesktopSettings, layout?: LayoutState): boolean {
  const current = settingValue(path, settings, layout), expected = defaultSettingValue(path);
  if (['ignoredFolders', 'protectedBranches', 'hiddenRepositoryIds'].includes(path) && Array.isArray(current) && Array.isArray(expected)) {
    return JSON.stringify([...current].sort()) !== JSON.stringify([...expected].sort());
  }
  return JSON.stringify(stableValue(current)) !== JSON.stringify(stableValue(expected));
}
export function defaultSettingPatch(path: Exclude<SettingPath, 'layout.fileViewMode'>, settings: DesktopSettings): Partial<DesktopSettings> {
  const value = structuredClone(defaultSettingValue(path));
  if (path.startsWith('aiConfig.')) {
    const key = path.slice('aiConfig.'.length);
    if (key.startsWith('cliExecutablePaths.')) return { aiConfig: { ...settings.aiConfig!, cliExecutablePaths: {
      ...settings.aiConfig!.cliExecutablePaths, [key.slice('cliExecutablePaths.'.length)]: value as string,
    } } };
    return { aiConfig: { ...settings.aiConfig!, [key]: value } };
  }
  return { [path]: value };
}
