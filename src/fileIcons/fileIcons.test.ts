import { describe, expect, it } from 'vitest';
import { resolveFileIcon } from './index';

describe('fileIcons resolver', () => {
  it('resolves material theme icons correctly', () => {
    const tsFile = resolveFileIcon('app.ts', false, false, 'material');
    expect(tsFile.type).toBe('svg');
    if (tsFile.type === 'svg') {
      expect(tsFile.svg).toContain('#3178C6');
    }

    const folder = resolveFileIcon('src', true, false, 'material');
    expect(folder.type).toBe('svg');
    if (folder.type === 'svg') {
      expect(folder.svg).toContain('svg');
    }
  });

  it('resolves catppuccin theme icons correctly', () => {
    const pyFile = resolveFileIcon('main.py', false, false, 'catppuccin');
    expect(pyFile.type).toBe('svg');
    if (pyFile.type === 'svg') {
      expect(pyFile.svg).toContain('#74c7ec');
    }
  });

  it('resolves seti theme icons correctly', () => {
    const rsFile = resolveFileIcon('lib.rs', false, false, 'seti');
    expect(rsFile.type).toBe('svg');
    if (rsFile.type === 'svg') {
      expect(rsFile.svg).toContain('#e37933');
    }
  });

  it('resolves codicon theme icons correctly', () => {
    const jsFile = resolveFileIcon('index.js', false, false, 'codicon');
    expect(jsFile.type).toBe('codicon');
    if (jsFile.type === 'codicon') {
      expect(jsFile.icon).toBe('symbol-variable');
      expect(jsFile.tone).toBe('javascript');
    }

    const folder = resolveFileIcon('components', true, true, 'codicon');
    expect(folder.type).toBe('codicon');
    if (folder.type === 'codicon') {
      expect(folder.icon).toBe('folder-opened');
    }
  });
});

it('adapts Catppuccin to Latte in light mode without changing shapes', () => {
  const dark = resolveFileIcon('app.js', false, false, 'catppuccin');
  const light = resolveFileIcon('app.js', false, false, 'catppuccin', true);
  expect(dark.type).toBe('svg'); expect(light.type).toBe('svg');
  if (dark.type === 'svg' && light.type === 'svg') {
    expect(light.svg).toContain('#df8e1d'); expect(light.svg).not.toContain('#f9e2af');
    expect(light.svg.replace(/#[0-9a-f]{6}/g, 'COLOR')).toBe(dark.svg.replace(/#[0-9a-f]{6}/g, 'COLOR'));
  }
});

it.each(['material', 'seti'] as const)('preserves %s SVG paths when improving light-mode colors', (theme) => {
  const dark = resolveFileIcon('app.js', false, false, theme);
  const light = resolveFileIcon('app.js', false, false, theme, true);
  if (dark.type === 'svg' && light.type === 'svg') {
    expect(light.svg).not.toBe(dark.svg);
    expect(light.svg.replace(/#[0-9a-f]{6}/gi, 'COLOR')).toBe(dark.svg.replace(/#[0-9a-f]{6}/gi, 'COLOR'));
  } else { throw new Error('Expected SVG icons'); }
});
