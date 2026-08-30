import { describe, expect, it } from 'vitest';
import { createTranslator, resolveLanguage } from '.';

describe('i18n', () => {
  it('uses English on non-Chinese systems and Chinese on Chinese systems', () => {
    expect(resolveLanguage('system', 'en-US')).toBe('en');
    expect(resolveLanguage('system', 'zh-Hans-CN')).toBe('zh-CN');
  });

  it('supports existing positional placeholders', () => {
    const t = createTranslator('en', { 'Changed {0} files': 'Changed {0} files' });
    expect(t('Changed {0} files', 3)).toBe('Changed 3 files');
  });

  it('translates notification messages before the plugin bundle finishes loading', () => {
    const t = createTranslator('zh-CN');
    expect(t('VersionDock: Already up to date. No files updated.')).toBe('VersionDock：已是最新状态，没有更新文件。');
    expect(t('VersionDock: Updated {0} files in {1} commits.', 4, 2)).toBe('VersionDock：已通过 2 个提交更新 4 个文件。');
  });
});
