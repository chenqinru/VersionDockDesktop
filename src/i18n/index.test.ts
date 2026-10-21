import { describe, expect, it } from 'vitest';
import { createTranslator, resolveLanguage } from '.';

describe('i18n', () => {
  it('translates the queued discard task before plugin translations load', () => {
    expect(createTranslator('zh-CN')('Discard Changes')).toBe('丢弃更改');
    expect(createTranslator('en')('Discard Changes')).toBe('Discard Changes');
  });
  it('uses English on non-Chinese systems and Chinese on Chinese systems', () => {
    expect(resolveLanguage('system', 'en-US')).toBe('en');
    expect(resolveLanguage('system', 'zh-Hans-CN')).toBe('zh-CN');
    expect(resolveLanguage('system', 'zh-TW')).toBe('zh-CN');
    expect(resolveLanguage('zhCn', 'en-US')).toBe('zh-CN');
    expect(resolveLanguage('en', 'zh-CN')).toBe('en');
  });

  it('supports existing positional placeholders', () => {
    const t = createTranslator('en');
    expect(t('CRLF line separators: {0}', 'App.vue')).toBe('CRLF line separators: App.vue');
  });

  it('loads shared dialog translations immediately and keeps translators in different languages independent', () => {
    const zh = createTranslator('zh-CN');
    const en = createTranslator('en');
    expect(zh('Commit Safety Check')).toBe('提交安全检查');
    expect(zh('Commit Anyway')).toBe('仍然提交');
    expect(zh('CRLF line separators: {0}', 'App.vue')).toBe('包含 CRLF 行分隔符: App.vue');
    expect(en('Commit Anyway')).toBe('Commit Anyway');
    expect(createTranslator('zh-CN')('Commit Anyway')).toBe('仍然提交');
    expect(zh('VersionDock Warning: The commit contains potential issues:\n{0}\nDo you want to commit anyway?', '风险')).toBe('VersionDock 警告：即将提交的内容存在潜在风险:\n风险\n是否仍要继续提交？');
  });

  it('preserves unknown diagnostic text and placeholder values literally', () => {
    const t = createTranslator('zh-CN');
    expect(t('external-tool: unknown diagnostic')).toBe('external-tool: unknown diagnostic');
    expect(t('CRLF line separators: {0}', 'src/{1}.vue')).toBe('包含 CRLF 行分隔符: src/{1}.vue');
  });

  it('translates notification messages before the plugin bundle finishes loading', () => {
    const t = createTranslator('zh-CN');
    expect(t('VersionDock: Already up to date. No files updated.')).toBe('VersionDock：已是最新版本，无文件更新。');
    expect(t('VersionDock: Updated {0} files in {1} commits.', 4, 2)).toBe('VersionDock：已更新 4 个文件（2 个提交）。');
    expect(t('VersionDock: Merge conflicts detected. Use the Merge Editor to resolve them.')).toBe('VersionDock：检测到合并冲突，请使用合并编辑器解决。');
    expect(t('Rebase & Push')).toBe('变基并推送');
  });

  it('uses consistent squash terminology for both menus, the editor, and completion notifications', () => {
    const t = createTranslator('zh-CN');
    expect(t('Squash {0} Commits...', 2)).toBe('压缩 2 个提交...');
    expect(t('Squash {0} commits…', 2)).toBe('压缩 2 个提交…');
    expect(t('Squash {0} commits', 2)).toBe('压缩 2 个提交');
    expect(t('VersionDock [{0}]: squash completed.', 'repo')).toBe('VersionDock [repo]：压缩提交已完成。');
    expect(createTranslator('en')('VersionDock [{0}]: squash completed.', 'repo')).toBe('VersionDock [repo]: Squash completed.');
  });

  it.each([
    ['Reading repository data', '正在读取仓库数据'],
    ['Waiting for a repository read slot', '正在等待仓库读取许可'],
    ['Waiting for a repository write slot', '正在等待仓库写入许可'],
    ['Waiting for the repository write lock', '正在等待仓库写入锁'],
    ['Stopping automatic fetch before repository operation', '正在停止自动获取，以执行仓库操作'],
    ['Preparing selected paths and creating commit', '正在准备所选文件并创建提交'],
    ['Pulling repository changes with fast-forward only', '正在以快进方式拉取仓库更改'],
  ])('translates native operation text without depending on plugin bundles: %s', (english, chinese) => {
    expect(createTranslator('zh-CN')(english)).toBe(chinese);
    expect(createTranslator('en')(english)).toBe(english);
  });
});
