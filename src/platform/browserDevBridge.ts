import type {
  AppStateSnapshot, BootstrapData, BranchInfo, BridgeCommand, CommitDetail, CommitFile, CommitNode,
  MergeCommitSummary,
  DiffDocument, GraphCommitNode, HistoryPage, RemoteInfo, RepositoryStatus, ShelfEntry, StashEntry, SubtreeEntry,
  TagInfo, WorkspaceSnapshot, WorktreeEntry, SubmoduleEntry,
  WindowTabTransfer,
} from '../bindings/generated';
import type { BridgeEvent, NewWindowPlacement, RequestOptions, VersionDockBridge } from './bridge';

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
  repository('sentry-admin', 'SENTRY-ADMIN', '#dcdcaa', 'main', []),
  repository('system-admin', 'SYSTEM-ADMIN', '#c678dd', 'prod', [
    { path: 'src/pages/system/config/index.vue', status: 'added', staged: true, unstaged: false, conflicted: false },
  ], 0, 1),
  repository('transaction-works-admin', 'TRANSACTION-WORKS-ADMIN', '#f14c4c', 'prod', []),
];

const makeCommit = (repoId: string, hash: string, message: string, author: string, date: string, refs: string[], parents: string[] = []): CommitNode => ({
  repoId, hash: hash.padEnd(40, '0'), shortHash: hash.slice(0, 8), parents: parents.map((parent) => parent.padEnd(40, '0')), author,
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

const demoHash = (repoId: string, index: number) => `${repoId}-${index.toString(36).padStart(2, '0')}`;

function createDemoHistory(repoId: string, branch: string, authors: string[]): CommitNode[] {
  const count = 54;
  const mergeIndexes = new Set([7, 15, 26, 39]);
  return Array.from({ length: count }, (_, index) => {
    const hash = demoHash(repoId, index);
    const parents = index === count - 1 ? [] : [demoHash(repoId, index + 1)];
    if (mergeIndexes.has(index) && index + 6 < count) parents.push(demoHash(repoId, index + 6));
    const refs = index === 0 ? [`HEAD -> ${branch}`, `origin/${branch}`] : [];
    if (index === 5) refs.push('origin/feature/phase2-dev');
    if (index === 10) refs.push(branch);
    if (index === 18) refs.push('tag: v1.0.0');
    if (index === 32) refs.push('tag: v0.9.0');
    const date = new Date(Date.UTC(2026, 7, 13, 9, 30) - index * 1000 * 60 * 95).toISOString();
    const author = authors[index % authors.length];
    const message = mergeIndexes.has(index)
      ? `Merge branch '${index % 2 ? 'feature/phase2-dev' : 'prod'}' into ${branch}`
      : `${index % 3 === 0 ? 'feat' : index % 3 === 1 ? 'fix' : 'refactor'}(${repoId}): ${index % 2 ? '优化提交日志和项目配置展示' : '完善业务模块查询与编辑能力'}`;
    return { ...makeCommit(repoId, hash, message, author, date, refs, parents), incoming: index % 9 === 5, unpushed: index % 13 === 0 };
  });
}

const officeRulesMessages = [
  'feat(office-rules): 新增即发年月字段并更新通讯录标题和组织架构名称',
  'feat(office-rules): 调整制度统计卡片样式并支持点击筛选',
  'fix(office-rules): 卡片 hover 改用分类间色蓝底白字',
  'fix(office-rules): 制度卡片 hover 改为紫底白字',
  'fix(office-rules): 卡片 hover 改为文字颜色加深',
  'fix(office-rules): 卡片 hover 改为阴影提高，避免位移截断顶部',
  'fix(office-rules): 废止状态标签红并修复卡片 hover 顶边被截断',
  'fix(office-rules): 回退状态强调样式，卡片仅加粗区分',
  'feat(office-rules): 制度查询新增横向并优化状态样式区分',
  'fix(office-rules): 废止与版本变更后同步刷新制度统计',
  'refactor(office-rules): 移除当前展示版本列与版本号表单字段',
  'feat(office-rules): 列表增加当前展示版本列',
  'refactor(office-rules): 列表表序号并移除制度编号字段',
  'feat(office-rules): 制度管理顶部增加状态统计条',
  'feat(office-rules): 优化制度列表字段、操作列与编辑弹窗体验',
  'fix(teacher): 岗位责任书为空时不展示查看责任书按钮',
  'style(responsibility-preview): 收紧当前岗位责任文本字号与行距',
  'feat(contacts): 部门通讯录布局与岗位责任预览交互优化',
  'style(teacher): 优化代码格式，调整选项获取方式并重新添加从数组时长字段',
  'feat(teacher): 移除正式入职时间和参加工会活动情况字段，新增最新处理时间排序功能',
  'feat(bpm-my): 我发起的列表区分已结束与进行中，近3天有更新时突出显示',
  'style(workspace): 加宽我的面板顶部统计卡片',
  'feat(bpm-copy): 菜单角标与工作台抄送计数改为仅统计未读',
  'feat(bpm-copy): 抄送列表支持已读状态并突出显示未读选项',
  'feat(menu): 我发起的菜单角标与工作台进行中数量保持一致',
  'style(workspace): 统一我的待办、通知公告与我的消息列表字体与配色',
  'feat(workspace): 最新消息改名为我的消息并增加更新红点',
  'feat(workspace): 通知公告有更新时间标题显示红点，点击后清除',
  'feat(workspace): 我的面板改版，顶栏统计可跳转并优化列表布局',
  'feat(common-ui): 常用功能卡片样式改版',
  'feat(common-ui): 工作台头部支持统计项展示与点击',
  'refactor(notify): 将“我的站内信”文案统一为“我的消息”',
  'feat(menu): 我的待办与抄送的菜单增加计数角标',
] as const;

function createOfficeRulesHistory(): CommitNode[] {
  const count = 54;
  const branchPlans = [
    { merge: 31, head: 36, root: 37, base: 42 },
    { merge: 44, head: 48, root: 49, base: 53 },
  ];
  const mergeIndexes = new Set(branchPlans.map((plan) => plan.merge));
  const branchRows = new Map<number, { hash: string; parent: string }>();
  branchPlans.forEach((plan, branchIndex) => {
    const headHash = `transaction-works-admin-branch-${branchIndex}`;
    const rootHash = `transaction-works-admin-branch-root-${branchIndex}`;
    branchRows.set(plan.head, { hash: headHash, parent: rootHash });
    branchRows.set(plan.root, { hash: rootHash, parent: demoHash('transaction-works-admin', plan.base) });
  });
  const hashAt = (index: number) => branchRows.get(index)?.hash ?? demoHash('transaction-works-admin', index);
  const nextMainIndex = (index: number) => {
    for (let next = index + 1; next < count; next += 1) if (!branchRows.has(next)) return next;
    return -1;
  };
  const leadRows = [
    { message: 'chore(config): 忽略 Rebel 配置文件', author: 'chenqinru', date: '2026-08-14T18:01:00+08:00', refs: ['chenqinru', 'HEAD -> chenqinru'] },
  ] as const;
  const start = new Date('2026-08-14T17:32:00+08:00');
  return Array.from({ length: count }, (_, index) => {
    const hash = hashAt(index);
    const branchRow = branchRows.get(index);
    const nextMain = nextMainIndex(index);
    const plan = branchPlans.find((value) => value.merge === index);
    const parents = branchRow
      ? [branchRow.parent]
      : plan
        ? [nextMain >= 0 ? hashAt(nextMain) : '', hashAt(plan.head)].filter(Boolean)
        : nextMain >= 0 ? [hashAt(nextMain)] : [];
    const lead = leadRows[index];
    const date = lead?.date ?? new Date(start.getTime() - (index - leadRows.length) * 4 * 60_000).toISOString();
    const refs: string[] = lead ? [...lead.refs] : [];
    if (index === 1) refs.push('origin/feat/phase2-dev');
    if (index === 17) refs.push('origin/prod');
    if (index === 22) refs.push('prod');
    if (index === 30) refs.push('origin/dev-ziye');
    if (index === 40) refs.push('tag: v1.0.0');
    const author = lead?.author ?? (index % 9 === 0 ? 'chenqinru' : index % 7 === 0 ? 'huguoliang' : 'ziye');
    const message = lead?.message ?? (mergeIndexes.has(index)
      ? `Merge branch '${index % 2 ? 'main' : 'prod'}' into feat/office-rules`
      : officeRulesMessages[(index - leadRows.length) % officeRulesMessages.length]);
    return { ...makeCommit('transaction-works-admin', hash, message, author, date, refs, parents), incoming: index % 11 === 4, unpushed: index % 17 === 0 };
  });
}

function createSvnHistory(repoId: string, branch: string, author: string): CommitNode[] {
  return Array.from({ length: 42 }, (_, index) => {
    const revision = 7453 - index;
    const parents = index === 41 ? [] : [`r${revision - 1}`];
    const date = new Date(Date.UTC(2026, 7, 13, 8, 50) - index * 1000 * 60 * 125).toISOString();
    return makeCommit(repoId, `r${revision}`, index === 0 ? `SVN 修订 ${revision}` : `feat(${branch}): 完善业务配置与列表展示`, author, date, index === 0 ? ['HEAD'] : [], parents);
  });
}

const demoHistories: Record<string, CommitNode[]> = Object.fromEntries([
  ['admin', createDemoHistory('admin', 'main', ['chenqinru', 'ziye', 'huguoliang'])],
  ['api', createDemoHistory('api', 'prod', ['ziye', 'huguoliang', 'chenqinru'])],
  ['sentry-admin', createDemoHistory('sentry-admin', 'main', ['ziye', 'xih'])],
  ['system-admin', createDemoHistory('system-admin', 'prod', ['chenqinru', 'ziye'])],
  ['transaction-works-admin', createOfficeRulesHistory()],
]);

const mixedHistories: Record<string, CommitNode[]> = {
  'mixed-git': createDemoHistory('mixed-git', 'main', ['chenqinru', 'ziye']),
  'mixed-api-git': createDemoHistory('mixed-api-git', 'main', ['ziye', 'huguoliang']),
  'mixed-admin-svn': createSvnHistory('mixed-admin-svn', 'admin_code', 'xih'),
  'mixed-api-svn': createSvnHistory('mixed-api-svn', 'api', 'xih'),
};

const activeHistories = browserDemoMode === 'mixed' ? mixedHistories : demoHistories;

const demoLocalBranchNames = [
  'prod', 'main', 'chenqinru', 'bpm-feature', 'bpm-listener', 'cqr', 'data-permission1', 'data-permission2',
  'DataPermission', 'demo1', 'dev-remote', 'dev-ziye', 'feat/work-report-push', 'file-type-handler',
  'fleet-local-history', 'HealthCheck', 'hugl', 'prod_sys', 'prod-metadata', 'prod-redis-dqueue',
  'prod-task-center', 'prod-ziye', 'RedisDelay', 'resilience4j', 'rocketmq', 'send-mail', 'send-sms',
  'sentry', 'task-center', 'test', 'transaction-works-task-center', 'upgrade', 'upload-task', 'upload-validate',
];

const branches: Record<string, BranchInfo[]> = Object.fromEntries(initialRepositories.map((repo) => {
  if (repo.meta.id === 'transaction-works-admin') {
    const local = demoLocalBranchNames.map((name) => ({ name, current: name === repo.branch, remote: false, remoteName: null, upstream: name === repo.branch ? `origin/${name}` : null, ahead: name === repo.branch ? repo.ahead : 0, behind: name === repo.branch ? repo.behind : 0 }));
    return [repo.meta.id, [
      ...local,
      { name: 'origin/prod', current: false, remote: true, remoteName: 'origin', upstream: null, ahead: 0, behind: 0 },
      { name: 'gitee/prod', current: false, remote: true, remoteName: 'gitee', upstream: null, ahead: 0, behind: 0 },
    ]];
  }
  const values: BranchInfo[] = [
    { name: repo.branch, current: true, remote: false, remoteName: null, upstream: `origin/${repo.branch}`, ahead: repo.ahead, behind: repo.behind },
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
  'transaction-works-admin': [
    { path: 'apps/web-antd/src/views/service/office-service/rules/data.ts', status: 'M', added: 6, removed: 2 },
    { path: 'apps/web-antd/src/views/service/personnel/contacts/modules/dept-sider.vue', status: 'M', added: 2, removed: 2 },
    { path: 'apps/web-antd/src/views/service/personnel/contacts/index.vue', status: 'M', added: 1, removed: 1 },
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
  schemaVersion: 3, lastWorkspaceId: workspace.id, recentWorkspaces: [workspace],
  settings: { theme: 'dark', language: 'zhCn', uiFontSize: 'standard', changesDisplayMode: 'simplified', defaultCommitAction: 'commit', defaultSaveAction: 'stash', promptBeforeAddingUntracked: true, suppressDivergedWarning: false, autoRefreshInterval: 0, fetchOnStartup: false, resetViewLocationsOnStartup: false, notifyIncomingCommits: false, notifyUnpushedCommits: false, repositoryScanDepth: 4, ignoredFolders: ['node_modules', 'target', 'dist'], maximumGraphCommits: 1000, projectColors: {}, externalEditor: null },
  layout: { panelSizes: { commit: 345, branches: 220, detail: 380 }, activeTab: 'changes', fileViewMode: 'tree', stashViewMode: 'tree', branchSidebarCollapsed: false, branchSidebarCollapsedSections: [] },
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
    dragGeometry: async () => null,
    setCursorIcon: async () => undefined,
    onDragDrop: async () => () => undefined,
  };

  platform(): 'macos' | 'windows' | 'linux' { return 'macos'; }
  subscribe(handler: (event: BridgeEvent) => void): () => void { this.handlers.add(handler); return () => this.handlers.delete(handler); }
  getState<T>(): T | undefined { return this.state as T; }
  setState<T>(state: T): void { this.state = structuredClone(state as AppStateSnapshot); }
  send(command: BridgeCommand): void { void this.request(command); }
  async selectWorkspaceFolders(): Promise<string[]> { return workspace.paths; }
  async notify(): Promise<boolean> { return false; }
  async openInNewWindow(paths?: string[], _position?: NewWindowPlacement, transfer?: WindowTabTransfer): Promise<string> {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams({ window: 'new' });
      if (paths && paths.length > 0) params.set('workspacePaths', JSON.stringify(paths));
      if (transfer) params.set('tabTransfer', JSON.stringify(transfer));
      const url = `/?${params.toString()}`;
      window.open(url, '_blank');
    }
    return 'browser-window-new';
  }
  async transferTab(transfer: WindowTabTransfer, _point: { screenX: number; screenY: number }, placement: NewWindowPlacement): Promise<boolean> {
    await this.openInNewWindow(transfer.paths, placement, transfer);
    return true;
  }
  async syncWindowTabs(): Promise<void> {
    return Promise.resolve();
  }
  async syncWindowBounds(): Promise<void> {
    return Promise.resolve();
  }
  async focusWorkspaceAcrossWindows(): Promise<boolean> {
    return Promise.resolve(false);
  }
  async onFocusTab(): Promise<() => void> {
    return Promise.resolve(() => undefined);
  }
  async windowTabDrop(): Promise<boolean> {
    return Promise.resolve(false);
  }
  async onImportTab(): Promise<() => void> {
    return Promise.resolve(() => undefined);
  }
  async completeTabTransfer(): Promise<void> {
    return Promise.resolve();
  }
  async onTabTransferCompleted(): Promise<() => void> {
    return Promise.resolve(() => undefined);
  }
  async getWindowLabel(): Promise<string> {
    return 'main';
  }
  async broadcastTabDragState(): Promise<void> {
    return Promise.resolve();
  }
  async onTabDragState(): Promise<() => void> {
    return Promise.resolve(() => undefined);
  }

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
      case 'updateSettings': this.state.settings = structuredClone(command.payload.settings); return { settings: command.payload.settings, effects: { rescanWorkspace: false, reloadHistory: false, restartAutoRefresh: true } };
      case 'updateLayout': this.state.layout = structuredClone(command.payload.layout); return command.payload.layout;
      case 'workspaceOpen': case 'workspaceRefresh': this.generation += 1; return this.snapshot();
      case 'workspaceRemoveRecent': return true;
      case 'repositoryStatus': return this.repositories.find((repo) => repo.meta.id === command.payload.repo_id);
      case 'history': {
        const values = activeHistories[command.payload.repo_id] ?? [];
        const revision = command.payload.revision?.replace(/^refs\/(?:heads|tags)\//, '');
        const head = revision ? values.find((commit) => commit.refs.some((ref) => ref.replace(/^HEAD -> /, '').replace(/^refs\/(?:heads|tags)\//, '').replace(/^tag: /, '') === revision)) : undefined;
        const reachable = new Set<string>();
        const byHash = new Map(values.map((commit) => [commit.hash, commit]));
        const pending = head ? [head.hash] : [];
        while (pending.length) {
          const hash = pending.pop()!;
          if (reachable.has(hash)) continue;
          reachable.add(hash);
          pending.push(...(byHash.get(hash)?.parents ?? []));
        }
        const scoped = head ? values.filter((commit) => reachable.has(commit.hash)) : values;
        const filtered = command.payload.filter ? scoped.filter((commit) => commit.message.toLowerCase().includes(command.payload.filter!.toLowerCase())) : scoped;
        return { commits: filtered.slice(command.payload.skip, command.payload.skip + command.payload.limit), hasMore: false } satisfies HistoryPage;
      }
      case 'historyTopology': return (activeHistories[command.payload.repo_id] ?? []).map(({ repoId, hash, parents, committerDate, refs }) => ({ repoId, hash, parents, committerDate, refs })) satisfies GraphCommitNode[];
      case 'branches': return this.branchValues[command.payload.repo_id] ?? [];
      case 'tags': return this.tagValues[command.payload.repo_id] ?? [];
      case 'commitDetail': return this.commitDetail(command.payload.repo_id, command.payload.revision);
      case 'commitMergeCommits': return this.mergeCommits(command.payload.repo_id, command.payload.revision) satisfies MergeCommitSummary[];
      case 'commitMergeParentFiles': return [
        { path: 'src/demo-parent-change.ts', status: 'M', added: 12, removed: 4 },
      ] satisfies CommitFile[];
      case 'fileDiff': return this.diff(command.payload.relative_path);
      case 'stashFileDiff': case 'shelfFileDiff': return this.diff(command.payload.relative_path);
      case 'fileHistory': return { entries: (activeHistories[command.payload.repo_id] ?? []).slice(Number(command.payload.cursor ?? 0), Number(command.payload.cursor ?? 0) + command.payload.limit).map((commit, index) => ({ revision: commit.hash, previousRevision: commit.parents[0] ?? null, path: command.payload.relative_path, previousPath: null, author: commit.author, date: commit.committerDate, message: commit.message, status: index === 0 ? 'M' : 'A' })), nextCursor: null };
      case 'fileRevisionContent': return { revision: command.payload.revision, path: command.payload.relative_path, content: `// Browser demo content for ${command.payload.relative_path}\n`, binary: false, truncated: false };
      case 'gitIdentity': return { profiles: [], selectedProfileId: null, local: { userName: 'VersionDock Demo', email: 'demo@example.test', source: 'local', profileId: null, valid: true }, global: null, effective: { userName: 'VersionDock Demo', email: 'demo@example.test', source: 'local', profileId: null, valid: true } };
      case 'gitProfileOperation': return { profiles: [], selectedProfileId: null, local: null, global: null, effective: { userName: '', email: '', source: 'missing', profileId: null, valid: false } };
      case 'svnAccount': case 'svnAccountOperation': return { repositoryRoot: 'file:///browser-demo', username: null, passwordStored: false, secureStorageAvailable: false, passwordStdinSupported: true, connectionOk: null };
      case 'conflicts': return [];
      case 'stashes': return [{ reference: 'stash@{0}', hash: '7e32b010', branch: 'main', message: 'WIP: browser demo', fullMessage: 'WIP: browser demo\n\nDetailed demo body', date: '2026-08-13T08:00:00Z', files: [{ path: 'src/demo.ts', status: 'modified' }] }] satisfies StashEntry[];
      case 'shelves': return [{ id: 'shelf-demo', name: '浏览器演示搁置', createdAt: '2026-08-13T08:00:00Z', branch: 'main', files: [{ path: 'src/demo.ts', status: 'modified' }] }] satisfies ShelfEntry[];
      case 'worktrees': return [{ path: `/browser-demo/${command.payload.repo_id}`, head: '06457b02', branch: this.repositories.find((repo) => repo.meta.id === command.payload.repo_id)?.branch ?? 'main', bare: false, detached: false, locked: false, lockReason: null, prunable: false, main: true }] satisfies WorktreeEntry[];
      case 'worktreeDiff': return { path: command.payload.path, baseRef: command.payload.base_ref, currentRef: 'main', files: [] };
      case 'worktreeFileDiff': return this.diff(command.payload.relative_path);
      case 'subtrees': return this.subtreeValues[command.payload.repo_id] ?? [];
      case 'submodules': return [] satisfies SubmoduleEntry[];
      case 'remotes': return [{ name: 'origin', fetchUrl: 'https://example.test/versiondock/demo.git', pushUrl: 'https://example.test/versiondock/demo.git' }] satisfies RemoteInfo[];
      case 'subtreeOperation': this.applySubtree(command.payload.repo_id, command.payload.operation); return true;
      case 'unpushedOperation': return true;
      case 'createPatch': return { fileName: `versiondock-${command.payload.revisions.length}.patch`, content: 'From browser demo\n' };
      case 'stage': this.updateFiles(command.payload.repo_id, command.payload.paths, true); return true;
      case 'unstage': this.updateFiles(command.payload.repo_id, command.payload.paths, false); return true;
      case 'deletePaths': this.repositories = this.repositories.map((repo) => repo.meta.id === command.payload.repo_id ? { ...repo, files: repo.files.filter((file) => !command.payload.paths.includes(file.path)) } : repo); return true;
      case 'addIgnore': return { directory: '', source: '.gitignore', patterns: [command.payload.relative_path] };
      case 'ignoreRules': return { directory: command.payload.directory, source: '.gitignore', patterns: [] };
      case 'updateIgnoreRules': return true;
      case 'commit': return activeHistories[command.payload.repo_id]?.[0]?.hash ?? 'browser-demo-commit';
      case 'batchCommit': return command.payload.targets.map((target) => ({ repoId: target.repoId, committed: true, revision: activeHistories[target.repoId]?.[0]?.hash ?? 'browser-demo-commit', pushed: command.payload.push, error: null }));
      case 'branchCompare': return { base: command.payload.base, target: command.payload.target, baseCommits: [], targetCommits: [], files: activeDetailFiles[command.payload.repo_id] ?? [] };
      case 'conflictVersions': return { path: command.payload.relative_path, base: '', ours: '', theirs: '', working: '', language: 'text', fingerprint: 'browser-demo', binary: false };
      case 'sync': case 'branchOperation': case 'tagOperation': case 'stashOperation': case 'shelfOperation':
      case 'changelistOperation': case 'worktreeOperation': case 'openWorktree': case 'remoteOperation': case 'svnOperation': case 'submoduleOperation': case 'historyOperation': case 'systemOpen':
      case 'conflictSave': case 'conflictAccept': case 'abortRepositoryOperation': return true;
      case 'changelists': return [];
    }
  }

  private commitDetail(repoId: string, revision: string): CommitDetail {
    const values = activeHistories[repoId] ?? [];
    const commit = values.find((item) => item.hash === revision) ?? values[0] ?? Object.values(activeHistories)[0]?.[0] ?? histories.admin[0];
    const isMerge = commit.parents.length >= 2;
    return {
      commit,
      fullMessage: `${commit.message}\n\n- 新增参数配置分页查询接口的筛选参数定义\n- 更新参数配置列表查询及导出接口请求参数类型\n- 将参数键值输入框调整为多行文本域以支持更长内容`,
      files: isMerge ? [] : (activeDetailFiles[repoId] ?? [{ path: 'README.md', status: 'M', added: 7, removed: 1 }]),
      branches: {
        local: commit.refs.filter((ref) => !ref.includes('/') && !ref.includes('HEAD') && !ref.startsWith('tag: ')),
        remote: commit.refs.filter((ref) => ref.includes('origin/') || ref.includes('remotes/')),
        tags: commit.refs.filter((ref) => ref.startsWith('tag: ')),
      },
      mergeParentChanges: isMerge ? commit.parents.map((parent, idx) => ({
        hash: parent,
        shortHash: parent.slice(0, 7),
        message: idx === 1 ? 'feat: merged branch changes' : 'main branch updates',
        authorName: commit.author,
        authorDate: commit.authorDate,
        parentIndex: idx,
        fileCount: 1,
      })) : [],
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
    if (operation.type === 'register') this.subtreeValues[repoId] = [...values, { id: `browser-${Date.now()}`, prefix: operation.prefix, remote: operation.remote, branch: operation.branch, squash: operation.squash, state: 'active' }];
    if (operation.type === 'edit') this.subtreeValues[repoId] = values.map((entry) => entry.id === operation.subtree_id ? { ...entry, prefix: operation.prefix, remote: operation.remote, branch: operation.branch, squash: operation.squash } : entry);
    if (operation.type === 'deleteRegistry') this.subtreeValues[repoId] = values.filter((entry) => entry.id !== operation.subtree_id);
  }
}
