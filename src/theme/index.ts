import type { ThemePreference } from '../bindings/generated';

export type EffectiveTheme = 'dark2026' | 'light2026' | 'githubDarkDimmed' | 'oneDarkPro' | 'dracula' | 'nord' | 'dark' | 'light';

export function isLightTheme(theme: EffectiveTheme): boolean {
  return theme === 'light' || theme === 'light2026';
}

export function resolveTheme(preference: ThemePreference, systemDark: boolean): EffectiveTheme {
  if (preference === 'system') {
    return systemDark ? 'dark2026' : 'light2026';
  }
  return preference;
}

export function applyTheme(theme: EffectiveTheme): void {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = isLightTheme(theme) ? 'light' : 'dark';
}

export { resolveShikiTheme, theme2026Dark, theme2026Light } from './shiki2026';

