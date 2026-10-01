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
    expect(t('VersionDock: Already up to date. No files updated.')).toBe('VersionDock：已是最新版本，无文件更新。');
    expect(t('VersionDock: Updated {0} files in {1} commits.', 4, 2)).toBe('VersionDock：已更新 4 个文件（2 个提交）。');
    expect(t('VersionDock: Merge conflicts detected. Use the Merge Editor to resolve them.')).toBe('VersionDock：检测到合并冲突，请使用合并编辑器解决。');
    expect(t('Rebase & Push')).toBe('变基并推送');
  });

  it.each([
    ['Reading repository data', '正在读取仓库数据'],
    ['Waiting for a repository read slot', '正在等待仓库读取许可'],
    ['Waiting for a repository write slot', '正在等待仓库写入许可'],
    ['Waiting for the repository write lock', '正在等待仓库写入锁'],
    ['Preparing selected paths and creating commit', '正在准备所选文件并创建提交'],
    ['Pulling repository changes with fast-forward only', '正在以快进方式拉取仓库更改'],
  ])('translates native operation text without depending on plugin bundles: %s', (english, chinese) => {
    expect(createTranslator('zh-CN')(english)).toBe(chinese);
    expect(createTranslator('en')(english)).toBe(english);
  });
});
