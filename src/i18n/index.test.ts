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
});
