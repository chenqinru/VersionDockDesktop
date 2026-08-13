import { describe, expect, it } from 'vitest';
import { resolveTheme } from '.';

describe('resolveTheme', () => {
  it('follows the system only for system preference', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });
});
