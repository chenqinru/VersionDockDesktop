import type {
  AppStateSnapshot, BootstrapData, BranchInfo, BridgeCommand, CommitDetail, CommitFile, CommitNode,
  MergeCommitSummary,
  DiffDocument, HistoryPage, RemoteInfo, RepositoryStatus, ShelfEntry, StashEntry, SubtreeEntry,
  TagInfo, WorkspaceSnapshot, WorktreeEntry,
} from '../bindings/generated';
import type { BridgeEvent, RequestOptions, VersionDockBridge } from './bridge';

const workspace = {
  id: 'browser-demo', name: 'multi-repo-browser-demo', paths: ['/browser-demo'],
  lastOpenedAt: '2026-08-13T08:00:00.000Z', available: true,
};

const browserDemoMode = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('sidebar') === 'mixed' ? 'mixed' : 'git';

const repository = (
  id: string, name: string, color: string, branch: string, files: RepositoryStatus['files'], ahead = 0, behind = 0,
): RepositoryStatus => ({
  meta: { id, name, rootPath: `/browser-demo/${id}`, color, kind: 'git', parentRepoId: null, depth: 0, isSubmodule: false, isWorktree: false },
  branch, revision: `${id}628f9b3`, ahead, behind, files, conflicts: 0, operation: null,
});

const svnRepository = (
  id: string, name: string, color: string, branch: string, revision: string, behind = 0,
): RepositoryStatus => ({
  meta: { id, name, rootPath: `/browser-demo/${id}`, color, kind: 'svn', parentRepoId: null, depth: 0, isSubmodule: false, isWorktree: false },
  branch, revision, ahead: 0, behind, files: [], conflicts: 0, operation: null,
});

const initialRepositories: RepositoryStatus[] = [
  repository('admin', 'ADMIN', '#4ec9b0', 'main', [
    { path: 'apps/web-antd/src/api/infra/config/index.ts', status: 'modified', staged: false, unstaged: true, conflicted: false },
    { path: 'apps/web-antd/src/views/infra/config/data.ts', status: 'modified', staged: true, unstaged: true, conflicted: false },
  ], 1),
  repository('api', 'API', '#61afef', 'prod', [
    { path: 'youth-module-system/src/main/java/ConfigService.java', status: 'modified', staged: false, unstaged: true, conflicted: false },
  ], 0, 2),
  repository('sentry-admin', 'SENTRY-ADMIN', '#c678dd', 'main', []),
  repository('system-admin', 'SYSTEM-ADMIN', '#dcdcaa', 'prod', [
    { path: 'src/pages/system/config/index.vue', status: 'added', staged: true, unstaged: false, conflicted: false },
  ], 0, 1),
  repository('transaction-works-admin', 'TRANSACTION-WORKS-ADMIN', '#d19a66', 'prod', []),
];

const makeCommit = (repoId: string, hash: string, message: string, author: string, date: string, refs: string[], parents: string[] = []): CommitNode => ({
  repoId, hash: hash.padEnd(40, '0'), shortHash: hash.slice(0, 8), parents, author,
  email: `${author.toLowerCase().replaceAll(' ', '.')}@example.test`, authorDate: date, committerDate: date, message, refs,
});

const histories: Record<string, CommitNode[]> = {
  admin: [
    makeCommit('admin', '06457b02', 'feat(infra): 增强参数配置模块查询与编辑功能', 'chenqinru', '2026-03-31T17:40:00+08:00', ['HEAD -> main', 'origin/main']),
    makeCommit('admin', 'ba5f0012', 'Merge branch prod-task-center into main', 'chenqinru', '2026-03-31T10:02:00+08:00', [], ['06457b02', 'cc813a40']),
    makeCommit('admin', 'cc813a40', 'feat: 增加路由实例通知响应拦截器', 'chenqinru', '2026-03-30T14:48:00+08:00', []),
  ],
  api: [
    makeCommit('api', '27889852', 'chore(ci): 统一 Runner 并优化构建流程', '278898052', '2026-06-30T21:27:00+08:00', ['origin/prod', 'prod']),
    makeCommit('api', '1a1fd3ce', 'feat(bpm): 流程模型新增通用配置功能', 'ziye', '2026-03-30T14:48:00+08:00', []),
  ],
  'sentry-admin': [
    makeCommit('sentry-admin', '92a31c01', 'refactor: 移除冗余业务模块', 'ziye', '2025-11-11T17:31:00+08:00', ['origin/dev-ziye']),
  ],
  'system-admin': [
    makeCommit('system-admin', 'fed41c22', 'chore(ci): 更新 pnpm 版本以确保构建环境一致性', 'chenqinru', '2026-05-08T16:10:00+08:00', ['main', 'origin/main', 'origin/HEAD']),
  ],
  'transaction-works-admin': [
    makeCommit('transaction-works-admin', 'bbd092a1', 'feat: 增强文件预览组件', '叶子', '2025-10-30T17:21:00+08:00', []),
  ],
};

const mixedHistories: Record<string, CommitNode[]> = {
  'mixed-git': histories.admin.map((commit) => ({ ...commit, repoId: 'mixed-git' })),
  'mixed-api-git': histories.api.map((commit) => ({ ...commit, repoId: 'mixed-api-git' })),
  'mixed-admin-svn': [makeCommit('mixed-admin-svn', 'r24', 'SVN 修订 24', 'chenqinru', '2026-08-10T11:36:00+08:00', ['HEAD'], ['r23'])],
  'mixed-api-svn': [makeCommit('mixed-api-svn', 'r30', 'SVN 修订 30', 'ziye', '2026-08-09T16:20:00+08:00', ['HEAD'], ['r29'])],
};

const activeHistories = browserDemoMode === 'mixed' ? mixedHistories : histories;

const branches: Record<string, BranchInfo[]> = Object.fromEntries(initialRepositories.map((repo) => {
  const values: BranchInfo[] = [
    { name: repo.branch, current: true, remote: false, remoteName: null, upstream: `origin/${repo.branch}`, ahead: repo.ahead, behind: repo.behind },
    { name: 'feature/shared-ui', current: false, remote: false, remoteName: null, upstream: null, ahead: 0, behind: 0 },
    { name: `feature/${repo.meta.id}-local`, current: false, remote: false, remoteName: null, upstream: null, ahead: 3, behind: 0 },
    { name: `origin/${repo.branch}`, current: false, remote: true, remoteName: 'origin', upstream: null, ahead: 0, behind: 0 },
    { name: `gitee/${repo.branch}`, current: false, remote: true, remoteName: 'gitee', upstream: null, ahead: 0, behind: 0 },
  ];
  if (repo.branch !== 'main') values.splice(1, 0, { name: 'main', current: false, remote: false, remoteName: null, upstream: 'origin/main', ahead: 0, behind: 0 });
  return [repo.meta.id, values];
}));

const mixedRepositories: RepositoryStatus[] = [
  { ...initialRepositories[0], meta: { ...initialRepositories[0].meta, id: 'mixed-git', name: 'GHCWBX' } },
  { ...initialRepositories[1], meta: { ...initialRepositories[1].meta, id: 'mixed-api-git', name: 'API' } },
  svnRepository('mixed-admin-svn', 'ADMIN', '#d19a66', 'admin_code', '24', 24),
  svnRepository('mixed-api-svn', 'API', '#c678dd', 'api', '30', 30),
];

const mixedBranches: Record<string, BranchInfo[]> = {
  'mixed-git': [
    { name: 'main', current: true, remote: false, remoteName: null, upstream: 'origin/main', ahead: 0, behind: 0 },
    { name: 'prod', current: false, remote: false, remoteName: null, upstream: 'origin/prod', ahead: 3, behind: 0 },
    { name: 'origin/main', current: false, remote: true, remoteName: 'origin', upstream: null, ahead: 0, behind: 0 },
  ],
  'mixed-api-git': [
    { name: 'main', current: true, remote: false, remoteName: null, upstream: 'origin/main', ahead: 0, behind: 0 },
    { name: 'feature/api', current: false, remote: false, remoteName: null, upstream: null, ahead: 0, behind: 0 },
    { name: 'origin/main', current: false, remote: true, remoteName: 'origin', upstream: null, ahead: 0, behind: 0 },
  ],
  'mixed-admin-svn': [
    { name: 'admin_code', current: true, remote: false, remoteName: null, upstream: null, ahead: 0, behind: 24 },
    { name: 'trunk', current: false, remote: false, remoteName: null, upstream: null, ahead: 0, behind: 0 },
  ],
  'mixed-api-svn': [
    { name: 'api', current: true, remote: false, remoteName: null, upstream: null, ahead: 0, behind: 30 },
    { name: 'trunk', current: false, remote: false, remoteName: null, upstream: null, ahead: 0, behind: 0 },
  ],
};

const tags: Record<string, TagInfo[]> = Object.fromEntries(initialRepositories.map((repo) => [repo.meta.id, [
  { name: 'v1.0.0', hash: histories[repo.meta.id][0].hash, date: histories[repo.meta.id][0].committerDate },
]]));

const versionNames = ['prod/v0.0.2', 'prod/v0.0.3', 'prod/v1.0.0', 'prod/v1.0.1', 'prod/v1.0.2', 'test/v0.0.1', 'test/v1.0.0', 'test/v1.0.1', 'v0.0.1', 'v0.0.2', 'v1.0.0-bate', 'v1.0.1', 'v1.7.1', 'v1.7.2', 'v1.7.3', 'v1.8.0', 'v1.8.1', 'v1.8.2', 'v1.8.3', 'v1.9.0', 'v2.0.0', 'v2.0.1', 'v2.1.0'];
const demoTags: Record<string, TagInfo[]> = Object.fromEntries(initialRepositories.map((repo) => [repo.meta.id, [
  ...(tags[repo.meta.id] ?? []),
  ...versionNames.map((name, index) => ({ name, hash: `${repo.meta.id}-tag-${index}`, date: '2026-08-13T08:00:00.000Z' })),
]]));

const detailFiles: Record<string, CommitFile[]> = {
  admin: [
    { path: 'apps/web-antd/src/api/infra/config/index.ts', status: 'M', added: 11, removed: 2 },
    { path: 'apps/web-antd/src/views/infra/config/data.ts', status: 'M', added: 11, removed: 1 },
  ],
  api: [
    { path: 'src/main/java/cn/versiondock/api/ConfigService.java', status: 'M', added: 18, removed: 4 },
    { path: 'src/main/resources/application.yml', status: 'M', added: 4, removed: 2 },
  ],
};

const activeDetailFiles: Record<string, CommitFile[]> = browserDemoMode === 'mixed' ? {
  ...detailFiles,
  'mixed-git': detailFiles.admin,
  'mixed-api-git': detailFiles.api,
  'mixed-admin-svn': [{ path: 'src/admin/ConfigService.java', status: 'M', added: 9, removed: 2 }],
  'mixed-api-svn': [{ path: 'src/api/ConfigService.java', status: 'M', added: 6, removed: 1 }],
} : detailFiles;

const initialState: AppStateSnapshot = {
  theme: 'dark', language: 'zhCn', lastWorkspaceId: workspace.id, recentWorkspaces: [workspace],
  panelSizes: { commit: 345, branches: 220, detail: 350 }, activeTab: 'changes', fileViewMode: 'tree', externalEditor: null,
  branchSidebarCollapsed: false, branchSidebarCollapsedSections: [],
};

export class BrowserDevBridge implements VersionDockBridge {
  private state: AppStateSnapshot = structuredClone(initialState);
  private repositories = structuredClone(browserDemoMode === 'mixed' ? mixedRepositories : initialRepositories);
  private readonly branchValues = browserDemoMode === 'mixed' ? mixedBranches : branches;
  private readonly tagValues = browserDemoMode === 'mixed' ? {} : demoTags;
  private generation = 1;
  private handlers = new Set<(event: BridgeEvent) => void>();
  private subtreeValues: Record<string, SubtreeEntry[]> = {
    admin: [{ id: 'demo-subtree', prefix: 'packages/shared-contracts', remote: 'origin', branch: 'main', squash: true, state: 'active' }],
  };

  readonly window = {
    startDragging: async () => undefined,
    toggleMaximize: async () => undefined,
    minimize: async () => undefined,
    close: async () => undefined,
    isMaximized: async () => false,
    onDragDrop: async () => () => undefined,
  };

  platform(): 'macos' | 'windows' | 'linux' { return 'macos'; }
  subscribe(handler: (event: BridgeEvent) => void): () => void { this.handlers.add(handler); return () => this.handlers.delete(handler); }
  getState<T>(): T | undefined { return this.state as T; }
  setState<T>(state: T): void { this.state = structuredClone(state as AppStateSnapshot); }
  send(command: BridgeCommand): void { void this.request(command); }
  async selectWorkspaceFolders(): Promise<string[]> { return workspace.paths; }

  async request<T>(command: BridgeCommand, options: RequestOptions = {}): Promise<T> {
    if (options.signal?.aborted) throw new DOMException('Operation aborted', 'AbortError');
    const value = await this.respond(command);
    return structuredClone(value) as T;
  }

  private snapshot(): WorkspaceSnapshot {
    return { workspace, repositories: this.repositories, generation: this.generation, tools: { git: true, svn: true, svnadmin: true } };
  }

  private async respond(command: BridgeCommand): Promise<unknown> {
    switch (command.type) {
      case 'bootstrap': return {
        state: this.state, tools: { git: true, svn: true, svnadmin: true },
        capabilities: { ai: false, stash: true, shelf: true, changelist: true, worktree: true, subtree: true, compare: true, remoteManagement: true },
      } satisfies BootstrapData;
      case 'saveAppState': this.state = structuredClone(command.payload.state); return true;
      case 'workspaceOpen': case 'workspaceRefresh': this.generation += 1; return this.snapshot();
      case 'workspaceRemoveRecent': return true;
      case 'repositoryStatus': return this.repositories.find((repo) => repo.meta.id === command.payload.repo_id);
      case 'history': {
        const values = activeHistories[command.payload.repo_id] ?? [];
        const filtered = command.payload.filter ? values.filter((commit) => commit.message.toLowerCase().includes(command.payload.filter!.toLowerCase())) : values;
        return { commits: filtered.slice(command.payload.skip, command.payload.skip + command.payload.limit), hasMore: false } satisfies HistoryPage;
      }
      case 'branches': return this.branchValues[command.payload.repo_id] ?? [];
      case 'tags': return this.tagValues[command.payload.repo_id] ?? [];
      case 'commitDetail': return this.commitDetail(command.payload.repo_id, command.payload.revision);
      case 'commitMergeCommits': return this.mergeCommits(command.payload.repo_id, command.payload.revision) satisfies MergeCommitSummary[];
      case 'fileDiff': return this.diff(command.payload.relative_path);
      case 'conflicts': return [];
      case 'stashes': return [{ reference: 'stash@{0}', hash: '7e32b010', branch: 'main', message: 'WIP: browser demo', date: '2026-08-13T08:00:00Z' }] satisfies StashEntry[];
      case 'shelves': return [{ id: 'shelf-demo', name: '浏览器演示搁置', createdAt: '2026-08-13T08:00:00Z', files: ['src/demo.ts'] }] satisfies ShelfEntry[];
      case 'worktrees': return [{ path: `/browser-demo/${command.payload.repo_id}`, head: '06457b02', branch: this.repositories.find((repo) => repo.meta.id === command.payload.repo_id)?.branch ?? 'main', bare: false, detached: false, locked: false, lockReason: null, prunable: false, main: true }] satisfies WorktreeEntry[];
      case 'subtrees': return this.subtreeValues[command.payload.repo_id] ?? [];
      case 'remotes': return [{ name: 'origin', fetchUrl: 'https://example.test/versiondock/demo.git', pushUrl: 'https://example.test/versiondock/demo.git' }] satisfies RemoteInfo[];
      case 'subtreeOperation': this.applySubtree(command.payload.repo_id, command.payload.operation); return true;
      case 'stage': this.updateFiles(command.payload.repo_id, command.payload.paths, true); return true;
      case 'unstage': this.updateFiles(command.payload.repo_id, command.payload.paths, false); return true;
      case 'commit': return activeHistories[command.payload.repo_id]?.[0]?.hash ?? 'browser-demo-commit';
      case 'branchCompare': return { base: command.payload.base, target: command.payload.target, baseCommits: [], targetCommits: [], files: activeDetailFiles[command.payload.repo_id] ?? [] };
      case 'conflictVersions': return { path: command.payload.relative_path, base: '', ours: '', theirs: '', working: '', language: 'text', fingerprint: 'browser-demo', binary: false };
      case 'sync': case 'branchOperation': case 'tagOperation': case 'stashOperation': case 'shelfOperation':
      case 'changelistOperation': case 'worktreeOperation': case 'remoteOperation': case 'systemOpen':
      case 'conflictSave': case 'conflictAccept': return true;
      case 'changelists': return [];
    }
  }

  private commitDetail(repoId: string, revision: string): CommitDetail {
    const values = activeHistories[repoId] ?? [];
    const commit = values.find((item) => item.hash === revision) ?? values[0] ?? Object.values(activeHistories)[0]?.[0] ?? histories.admin[0];
    return {
      commit,
      fullMessage: `${commit.message}\n\n- 新增参数配置分页查询接口的筛选参数定义\n- 更新参数配置列表查询及导出接口请求参数类型\n- 将参数键值输入框调整为多行文本域以支持更长内容`,
      files: activeDetailFiles[repoId] ?? [{ path: 'README.md', status: 'M', added: 7, removed: 1 }],
      branches: {
        local: commit.refs.filter((ref) => !ref.includes('/') && !ref.includes('HEAD') && !ref.startsWith('tag: ')),
        remote: commit.refs.filter((ref) => ref.includes('origin/') || ref.includes('remotes/')),
        tags: commit.refs.filter((ref) => ref.startsWith('tag: ')),
      },
    };
  }

  private mergeCommits(repoId: string, revision: string): MergeCommitSummary[] {
    const commit = (activeHistories[repoId] ?? []).find((item) => item.hash === revision);
    if (!commit || commit.parents.length < 2) return [];
    return [{
      hash: `${repoId}-merged-commit`, shortHash: 'merged01', message: 'feat: merged branch changes',
      author: commit.author, authorDate: commit.authorDate, parentIndex: 1,
    }];
  }

  private diff(path: string): DiffDocument {
    return { path, language: 'typescript', binary: false, truncated: false, lineCount: 8, content: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,2 +1,3 @@\n export const config = {\n+  browserDev: true,\n };` };
  }

  private updateFiles(repoId: string, paths: string[], staged: boolean): void {
    this.repositories = this.repositories.map((repo) => repo.meta.id !== repoId ? repo : {
      ...repo, files: repo.files.map((file) => paths.includes(file.path) ? { ...file, staged, unstaged: !staged } : file),
    });
  }

  private applySubtree(repoId: string, operation: Extract<BridgeCommand, { type: 'subtreeOperation' }>['payload']['operation']): void {
    const values = this.subtreeValues[repoId] ?? [];
    if (operation.type === 'add') this.subtreeValues[repoId] = [...values, { id: `browser-${Date.now()}`, prefix: operation.prefix, remote: operation.remote, branch: operation.branch, squash: operation.squash, state: 'active' }];
    if (operation.type === 'remove') this.subtreeValues[repoId] = values.filter((entry) => entry.id !== operation.subtree_id);
  }
}
