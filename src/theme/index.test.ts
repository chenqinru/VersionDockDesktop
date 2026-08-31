import { describe, expect, it } from 'vitest';
import { isLightTheme, resolveTheme } from '.';

describe('resolveTheme', () => {
  it('follows the system default to 2026 themes for system preference', () => {
    expect(resolveTheme('system', true)).toBe('dark2026');
    expect(resolveTheme('system', false)).toBe('light2026');
    expect(resolveTheme('dark2026', false)).toBe('dark2026');
    expect(resolveTheme('light2026', true)).toBe('light2026');
    expect(resolveTheme('githubDarkDimmed', false)).toBe('githubDarkDimmed');
    expect(resolveTheme('oneDarkPro', false)).toBe('oneDarkPro');
    expect(resolveTheme('dracula', false)).toBe('dracula');
    expect(resolveTheme('nord', false)).toBe('nord');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('correctly identifies light themes', () => {
    expect(isLightTheme('light2026')).toBe(true);
    expect(isLightTheme('light')).toBe(true);
    expect(isLightTheme('dark2026')).toBe(false);
    expect(isLightTheme('githubDarkDimmed')).toBe(false);
    expect(isLightTheme('oneDarkPro')).toBe(false);
    expect(isLightTheme('dracula')).toBe(false);
    expect(isLightTheme('nord')).toBe(false);
    expect(isLightTheme('dark')).toBe(false);
  });
});

