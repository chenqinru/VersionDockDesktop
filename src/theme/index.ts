import type { ThemePreference } from '../bindings/generated';

export type EffectiveTheme = 'light' | 'dark';

export function resolveTheme(preference: ThemePreference, systemDark: boolean): EffectiveTheme {
  return preference === 'system' ? (systemDark ? 'dark' : 'light') : preference;
}

export function applyTheme(theme: EffectiveTheme): void {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}
