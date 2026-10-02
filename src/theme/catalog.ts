import type { ThemePreference } from '../bindings/generated';

export const themeChoices = [
  { id: 'system', label: 'System (Default 2026)', icon: 'color-mode' },
  { id: 'dark2026', label: '2026 Dark', icon: 'moon' },
  { id: 'light2026', label: '2026 Light', icon: 'sun' },
  { id: 'githubDarkDimmed', label: 'GitHub Dark Dimmed', icon: 'github' },
  { id: 'oneDarkPro', label: 'One Dark Pro', icon: 'symbol-color' },
  { id: 'dracula', label: 'Dracula', icon: 'symbol-color' },
  { id: 'nord', label: 'Nord', icon: 'symbol-color' },
  { id: 'dark', label: 'Classic Dark', icon: 'symbol-color' },
  { id: 'light', label: 'Classic Light', icon: 'symbol-color' },
] as const satisfies ReadonlyArray<{ id: ThemePreference; label: string; icon: string }>;
