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
