import { createTranslator } from '../i18n';
import { expect, it } from 'vitest';
import { DEFAULT_SETTINGS, DEFAULT_LAYOUT, defaultSettingPatch, defaultSettingValue, effectiveSettings, isSettingModified } from './defaults';
import { settingDefinitions } from './catalog';
it('has one valid backend default for every editable setting', () => {
  expect(new Set(settingDefinitions.map(item => item.path)).size).toBe(settingDefinitions.length);
  for (const item of settingDefinitions) { expect(defaultSettingValue(item.path), item.path).not.toBeUndefined(); expect(isSettingModified(item.path, DEFAULT_SETTINGS, DEFAULT_LAYOUT), item.path).toBe(false); }
  expect(DEFAULT_SETTINGS.repositoryScanDepth).toBe(1); expect(DEFAULT_SETTINGS.aiConfig!.maxInputTokens).toBe(128000);
  expect(DEFAULT_SETTINGS.ignoredFolders).toEqual(['node_modules']);
});
it('compares object and set-like settings independently of key or entry order', () => {
  const settings = effectiveSettings(); settings.ignoredFolders = [...settings.ignoredFolders].reverse(); settings.protectedBranches = [...settings.protectedBranches!].reverse();
  expect(isSettingModified('ignoredFolders', settings)).toBe(false); expect(isSettingModified('protectedBranches', settings)).toBe(false);
  settings.ignoredFolders.push('custom-folder'); expect(isSettingModified('ignoredFolders', settings)).toBe(true);
});
it('restores only the selected AI leaf without removing another model, path or credentials owner', () => {
  const settings = effectiveSettings(); settings.aiConfig = { ...settings.aiConfig!, maxInputTokens:2500000, model:'user-model', apiUrl:'https://example.test', cliExecutablePaths:{ ...settings.aiConfig!.cliExecutablePaths, codex:'/custom/codex' } };
  const patch = defaultSettingPatch('aiConfig.maxInputTokens', settings);
  expect(patch.aiConfig).toMatchObject({ maxInputTokens:128000, model:'user-model', apiUrl:'https://example.test', cliExecutablePaths:{ codex:'/custom/codex' } });
  const pathPatch = defaultSettingPatch('aiConfig.cliExecutablePaths.codex', settings);
  expect(pathPatch.aiConfig!.cliExecutablePaths.codex).toBe('codex'); expect(pathPatch.aiConfig!.model).toBe('user-model');
  expect(settings.aiConfig.maxInputTokens).toBe(2500000);
});
it('fills absent legacy values with real defaults without classifying them as modified', () => {
  const settings = effectiveSettings({ theme:'dark2026' } as typeof DEFAULT_SETTINGS);
  expect(isSettingModified('theme', settings)).toBe(true); expect(isSettingModified('showProfileStatusBar', settings)).toBe(false); expect(isSettingModified('aiConfig.cliExecutablePaths.claude', settings)).toBe(false);
});

it('uses a settings-specific modified label without changing diff labels', () => {
  const t = createTranslator('zh-CN');
  expect(t('Setting modified')).toBe('已修改'); expect(t('Modified')).toBe('修改后');
});

it('defaults legacy tray settings to visible and resets an explicit disabled preference', () => {
  expect(DEFAULT_SETTINGS.showTrayIcon).toBe(true);
  expect(DEFAULT_SETTINGS.closeToTray).toBe(false);
  const legacy = effectiveSettings({ theme: 'system' } as typeof DEFAULT_SETTINGS);
  expect(legacy.showTrayIcon).toBe(true);
  const settings = effectiveSettings({ ...legacy, showTrayIcon: false });
  expect(isSettingModified('showTrayIcon', settings)).toBe(true);
  expect(defaultSettingPatch('showTrayIcon', settings)).toEqual({ showTrayIcon: true });
});
