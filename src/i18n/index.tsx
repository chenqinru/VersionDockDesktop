import { createContext, useContext } from 'react';
import type { LanguagePreference } from '../bindings/generated';

type Messages = Record<string, string>;

const desktopEn: Messages = {
  'Open Workspace': 'Open Workspace', 'Open a folder to discover Git and SVN repositories.': 'Open a folder to discover Git and SVN repositories.',
  'Recent Workspaces': 'Recent Workspaces', 'Drop folders anywhere in this window': 'Drop folders anywhere in this window',
  'No repositories found': 'No repositories found', 'No changes': 'No changes', 'Changes': 'Changes', 'History': 'History', 'Settings': 'Settings',
  'Refresh': 'Refresh', 'Commit': 'Commit', 'Commit & Push': 'Commit & Push', 'Commit message': 'Commit message', 'Branch': 'Branch', 'Tags': 'Tags',
  'Fetch': 'Fetch', 'Pull': 'Pull', 'Push': 'Push', 'Update': 'Update', 'Stage': 'Stage', 'Unstage': 'Unstage', 'Diff': 'Diff',
  'Conflicts': 'Conflicts', 'Resolve conflicts': 'Resolve conflicts', 'Save resolution': 'Save resolution', 'Cancel': 'Cancel',
  'Theme': 'Theme', 'Language': 'Language', 'System': 'System', 'Light': 'Light', 'Dark': 'Dark', 'English': 'English', 'Simplified Chinese': 'Simplified Chinese',
  'Git is not installed': 'Git is not installed', 'SVN is not installed': 'SVN is not installed', 'Loading workspace…': 'Loading workspace…',
  'Select a repository': 'Select a repository', 'Select a commit': 'Select a commit', 'Select a changed file to inspect its diff.': 'Select a changed file to inspect its diff.',
  'Diff is too large to display': 'Diff is too large to display', 'Binary diff cannot be displayed': 'Binary diff cannot be displayed',
  'Apply ours': 'Apply ours', 'Apply theirs': 'Apply theirs', 'Result': 'Result', 'Ours': 'Ours', 'Theirs': 'Theirs', 'Base': 'Base',
  'Repository': 'Repository', 'Author': 'Author', 'Search commits': 'Search commits', 'Back to history': 'Back to history',
  'Remove from recent': 'Remove from recent', 'Path is unavailable': 'Path is unavailable', 'Operation failed': 'Operation failed', 'Working tree': 'Working tree',
  'Tree view': 'Tree view', 'List view': 'List view', 'Create tag': 'Create tag', 'Rename': 'Rename', 'Delete': 'Delete', 'Copy': 'Copy',
  'Open': 'Open', 'Reveal': 'Reveal', 'Reset': 'Reset', 'No history': 'No history', 'files': 'files', 'Remote': 'Remote', 'Local': 'Local',
  'Git and SVN are not installed': 'Git and SVN are not installed', 'Install at least one command-line tool to load repositories.': 'Install at least one command-line tool to load repositories.',
  'No repositories were found in this workspace.': 'No repositories were found in this workspace.', 'Force delete branch': 'Force delete branch',
  'Delete branch {0}?': 'Delete branch {0}?', 'Delete tag {0}?': 'Delete tag {0}?', 'Checkout branch {0}?': 'Checkout branch {0}?',
  'Lines': 'lines', 'Staged': 'Staged', 'Amend': 'Amend',
  'Stash': 'Stash', 'Stashes': 'Stashes', 'Stash changes': 'Stash changes', 'No stashes': 'No stashes', 'Apply': 'Apply', 'Pop': 'Pop', 'Drop': 'Drop',
  'Include untracked files': 'Include untracked files', 'Stash message': 'Stash message', 'Drop stash {0}?': 'Drop stash {0}?', 'WIP stash': 'WIP stash',
  'Shelf': 'Shelf', 'Shelves': 'Shelves', 'Shelve changes': 'Shelve changes', 'No shelves': 'No shelves', 'Shelf name': 'Shelf name',
  'Drop shelf {0}?': 'Drop shelf {0}?', 'WIP shelf': 'WIP shelf', 'file': 'file',
  'Changelists': 'Changelists', 'New changelist': 'New changelist', 'Changelist name': 'Changelist name', 'Move to changelist': 'Move to changelist',
  'Remove from changelist': 'Remove from changelist', 'Delete changelist {0}?': 'Delete changelist {0}?', 'Unassigned': 'Unassigned',
  'Worktrees': 'Worktrees', 'Add worktree': 'Add worktree', 'No worktrees': 'No worktrees', 'Branch name': 'Branch name', 'Create new branch': 'Create new branch',
  'Lock': 'Lock', 'Unlock': 'Unlock', 'Prune': 'Prune', 'Remove worktree {0}?': 'Remove worktree {0}?', 'Force remove worktree {0}?': 'Force remove worktree {0}?', 'Main worktree': 'Main worktree',
  'Branch Compare': 'Branch Compare', 'Compare': 'Compare', 'Target': 'Target', 'Select two branches to compare': 'Select two branches to compare',
  'Only in {0}': 'Only in {0}', 'Changed files': 'Changed files', 'No changed files': 'No changed files', 'No unique commits': 'No unique commits',
  'Remotes': 'Remotes', 'Remote name': 'Remote name', 'Remote URL': 'Remote URL', 'No remotes': 'No remotes', 'Add': 'Add', 'Close': 'Close',
  'Fetch URL': 'Fetch URL', 'Push URL': 'Push URL', 'Set fetch URL': 'Set fetch URL', 'Set push URL': 'Set push URL', 'Remove remote {0}?': 'Remove remote {0}?',
  'External editor': 'External editor', 'Executable path': 'Executable path', 'One argument per line': 'One argument per line', 'Available placeholders: {path}, {relativePath}, {repo}': 'Available placeholders: {path}, {relativePath}, {repo}', 'Save': 'Save', 'Open in external editor': 'Open in external editor',
  'Switch Workspace': 'Switch Workspace', 'Open Another Workspace': 'Open Another Workspace',
  'Binary conflict cannot be edited': 'Binary conflict cannot be edited', 'Choose which complete version to keep.': 'Choose which complete version to keep.', 'Keep mine': 'Keep mine', 'Keep theirs': 'Keep theirs', 'Keep working': 'Keep working', 'Keep mine and mark resolved?': 'Keep mine and mark resolved?', 'Keep theirs and mark resolved?': 'Keep theirs and mark resolved?', 'Keep working file and mark resolved?': 'Keep working file and mark resolved?',
};

const desktopZh: Messages = {
  'Open Workspace': '打开工作区', 'Open a folder to discover Git and SVN repositories.': '打开文件夹以发现 Git 和 SVN 仓库。',
  'Recent Workspaces': '最近工作区', 'Drop folders anywhere in this window': '将文件夹拖入窗口任意位置',
  'No repositories found': '未发现仓库', 'No changes': '没有更改', 'Changes': '更改', 'History': '历史', 'Settings': '设置',
  'Refresh': '刷新', 'Commit': '提交', 'Commit & Push': '提交并推送', 'Commit message': '提交信息', 'Branch': '分支', 'Tags': '标签',
  'Fetch': '获取', 'Pull': '拉取', 'Push': '推送', 'Update': '更新', 'Stage': '暂存', 'Unstage': '取消暂存', 'Diff': '差异',
  'Conflicts': '冲突', 'Resolve conflicts': '解决冲突', 'Save resolution': '保存解决结果', 'Cancel': '取消',
  'Theme': '主题', 'Language': '语言', 'System': '跟随系统', 'Light': '浅色', 'Dark': '深色', 'English': '英文', 'Simplified Chinese': '简体中文',
  'Git is not installed': '未安装 Git', 'SVN is not installed': '未安装 SVN', 'Loading workspace…': '正在加载工作区…',
  'Select a repository': '选择仓库', 'Select a commit': '选择提交', 'Select a changed file to inspect its diff.': '选择更改文件以查看差异。',
  'Diff is too large to display': '差异内容过大，无法显示', 'Binary diff cannot be displayed': '无法显示二进制差异',
  'Apply ours': '采用当前', 'Apply theirs': '采用对方', 'Result': '结果', 'Ours': '当前', 'Theirs': '对方', 'Base': '基准',
  'Repository': '仓库', 'Author': '作者', 'Search commits': '搜索提交', 'Back to history': '返回历史',
  'Remove from recent': '从最近列表移除', 'Path is unavailable': '路径不可用', 'Operation failed': '操作失败', 'Working tree': '工作区',
  'Tree view': '树视图', 'List view': '平铺视图', 'Create tag': '创建标签', 'Rename': '重命名', 'Delete': '删除', 'Copy': '复制',
  'Open': '打开', 'Reveal': '在文件管理器中显示', 'Reset': '重置', 'No history': '暂无历史', 'files': '个文件', 'Remote': '远程', 'Local': '本地',
  'Git and SVN are not installed': '未安装 Git 和 SVN', 'Install at least one command-line tool to load repositories.': '请至少安装一个命令行工具以加载仓库。',
  'No repositories were found in this workspace.': '此工作区中未发现仓库。', 'Force delete branch': '强制删除分支',
  'Delete branch {0}?': '删除分支 {0}？', 'Delete tag {0}?': '删除标签 {0}？', 'Checkout branch {0}?': '切换到分支 {0}？',
  'Lines': '行', 'Staged': '已暂存', 'Amend': '修订提交',
  'Stash': '暂存区', 'Stashes': '暂存记录', 'Stash changes': '暂存更改', 'No stashes': '没有暂存记录', 'Apply': '应用', 'Pop': '弹出', 'Drop': '删除',
  'Include untracked files': '包含未跟踪文件', 'Stash message': '暂存说明', 'Drop stash {0}?': '删除暂存记录 {0}？', 'WIP stash': '临时暂存',
  'Shelf': '搁置', 'Shelves': '搁置记录', 'Shelve changes': '搁置更改', 'No shelves': '没有搁置记录', 'Shelf name': '搁置名称',
  'Drop shelf {0}?': '删除搁置记录 {0}？', 'WIP shelf': '临时搁置', 'file': '个文件',
  'Changelists': '更改列表', 'New changelist': '新建更改列表', 'Changelist name': '更改列表名称', 'Move to changelist': '移动到更改列表',
  'Remove from changelist': '移出更改列表', 'Delete changelist {0}?': '删除更改列表 {0}？', 'Unassigned': '未分组',
  'Worktrees': '工作树', 'Add worktree': '添加工作树', 'No worktrees': '没有工作树', 'Branch name': '分支名称', 'Create new branch': '创建新分支',
  'Lock': '锁定', 'Unlock': '解锁', 'Prune': '清理失效项', 'Remove worktree {0}?': '移除工作树 {0}？', 'Force remove worktree {0}?': '强制移除工作树 {0}？', 'Main worktree': '主工作树',
  'Branch Compare': '分支比较', 'Compare': '比较', 'Target': '目标', 'Select two branches to compare': '选择两个分支进行比较',
  'Only in {0}': '仅存在于 {0}', 'Changed files': '更改文件', 'No changed files': '没有文件差异', 'No unique commits': '没有独有提交',
  'Remotes': '远程仓库', 'Remote name': '远程名称', 'Remote URL': '远程 URL', 'No remotes': '没有远程仓库', 'Add': '添加', 'Close': '关闭',
  'Fetch URL': '拉取 URL', 'Push URL': '推送 URL', 'Set fetch URL': '设置拉取 URL', 'Set push URL': '设置推送 URL', 'Remove remote {0}?': '移除远程仓库 {0}？',
  'External editor': '外部编辑器', 'Executable path': '可执行文件路径', 'One argument per line': '每行一个参数', 'Available placeholders: {path}, {relativePath}, {repo}': '可用占位符：{path}、{relativePath}、{repo}', 'Save': '保存', 'Open in external editor': '在外部编辑器中打开',
  'Switch Workspace': '切换项目', 'Open Another Workspace': '打开其他项目',
  'Binary conflict cannot be edited': '无法编辑二进制冲突', 'Choose which complete version to keep.': '请选择要保留的完整版本。', 'Keep mine': '保留当前版本', 'Keep theirs': '保留对方版本', 'Keep working': '保留工作文件', 'Keep mine and mark resolved?': '保留当前版本并标记为已解决？', 'Keep theirs and mark resolved?': '保留对方版本并标记为已解决？', 'Keep working file and mark resolved?': '保留工作文件并标记为已解决？',
};

export interface I18nContextValue {
  language: 'en' | 'zh-CN';
  preference: LanguagePreference;
  t: (message: string, ...args: Array<string | number>) => string;
}

export const I18nContext = createContext<I18nContextValue>({ language: 'en', preference: 'system', t: (message) => message });
export const useI18n = () => useContext(I18nContext);

export function resolveLanguage(preference: LanguagePreference, systemLanguage = navigator.language): 'en' | 'zh-CN' {
  if (preference === 'zhCn') return 'zh-CN';
  if (preference === 'en') return 'en';
  return systemLanguage.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}

export function createTranslator(language: 'en' | 'zh-CN', pluginBundle: Messages = {}) {
  const messages = language === 'zh-CN' ? { ...pluginBundle, ...desktopZh } : { ...pluginBundle, ...desktopEn };
  return (message: string, ...args: Array<string | number>) => {
    const translated = messages[message] ?? message;
    return args.reduce<string>((value, arg, index) => value.replaceAll(`{${index}}`, String(arg)), translated);
  };
}
