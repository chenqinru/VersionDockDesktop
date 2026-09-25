import type {
  AppStateSnapshot, BootstrapData, BranchInfo, BridgeCommand, CommitDetail, CommitFile, CommitNode,
  MergeCommitSummary,
  DiffDocument, GraphCommitNode, HistoryPage, RemoteInfo, RepositoryStatus, ShelfEntry, StashEntry, SubtreeEntry,
  IncomingCommit, RuntimeCapabilities, TagInfo, UnpushedCommit, WorkspaceSnapshot, WorktreeEntry, SubmoduleEntry,
  WindowTabTransfer, LogEntry, LogLevel, LogChannel,
} from '../bindings/generated';
import type { BridgeEvent, NewWindowPlacement, RequestOptions, VersionDockBridge } from './bridge';

const workspace = {
  id: 'browser-demo', name: 'multi-repo-browser-demo', paths: ['/browser-demo'],
  lastOpenedAt: '2026-08-13T08:00:00.000Z', available: true,
};

const browserDemoMode = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('sidebar') === 'mixed' ? 'mixed' : 'git';

const unavailableRuntime: RuntimeCapabilities = {
  systemNotifications: { available: false, reasonCode: 'BROWSER_DEMO', detail: 'System notifications are unavailable in browser demo mode' },
  notificationPermission: 'unavailable',
  secureCredentials: {
    status: { available: false, reasonCode: 'BROWSER_DEMO', detail: 'Secure storage is unavailable in browser demo mode' },
    backend: null,
    passwordStdinSupported: false,
  },
};

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
    { path: 'apps/service-api/src/main/java/ConfigService.java', status: 'modified', staged: false, unstaged: true, conflicted: false },
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
    makeCommit('admin', '06457b02', 'feat(infra): enhance configuration query and edit capabilities', 'chenqinru', '2026-03-31T17:40:00+08:00', ['HEAD -> main', 'origin/main']),
    makeCommit('admin', 'ba5f0012', 'Merge branch feat/task-center into main', 'chenqinru', '2026-03-31T10:02:00+08:00', [], ['06457b02', 'cc813a40']),
    makeCommit('admin', 'cc813a40', 'feat(router): add response interceptor for route notifications', 'chenqinru', '2026-03-30T14:48:00+08:00', []),
  ],
  api: [
    makeCommit('api', '27889852', 'chore(ci): standardize runner configuration and build workflow', 'alex', '2026-06-30T21:27:00+08:00', ['origin/prod', 'prod']),
    makeCommit('api', '1a1fd3ce', 'feat(workflow): add general configuration support for model definitions', 'sarah', '2026-03-30T14:48:00+08:00', []),
  ],
  'sentry-admin': [
    makeCommit('sentry-admin', '92a31c01', 'refactor: remove deprecated telemetry modules', 'sarah', '2025-11-11T17:31:00+08:00', ['origin/feat/telemetry-cleanup']),
  ],
  'system-admin': [
    makeCommit('system-admin', 'fed41c22', 'chore(ci): bump pnpm version to align build environment', 'chenqinru', '2026-05-08T16:10:00+08:00', ['main', 'origin/main', 'origin/HEAD']),
  ],
  'transaction-works-admin': [
    makeCommit('transaction-works-admin', 'bbd092a1', 'feat: enhance file preview component integration', 'jordan', '2025-10-30T17:21:00+08:00', []),
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
      : `${index % 3 === 0 ? 'feat' : index % 3 === 1 ? 'fix' : 'refactor'}(${repoId}): ${index % 2 ? 'optimize commit log and workspace rendering' : 'improve module queries and state management'}`;
    return { ...makeCommit(repoId, hash, message, author, date, refs, parents), incoming: index % 9 === 5, unpushed: index % 13 === 0 };
  });
}

const standardDemoMessages = [
  'feat(settings): add dynamic property filtering and update layout schema',
  'feat(analytics): adjust statistical metrics cards with filter triggers',
  'fix(ui): customize card hover palette and elevation contrast',
  'fix(theme): optimize dark mode badge contrast and border radius',
  'fix(style): refine hover transition timing on action buttons',
  'fix(components): prevent top boundary clipping during modal popups',
  'fix(badge): correct status tag variant and update badge indicators',
  'fix(history): emphasize revert status and improve row contrast',
  'feat(query): add horizontal scrolling for wide query tables',
  'fix(cache): refresh store state following schema migration',
  'refactor(schema): remove deprecated display version properties',
  'feat(views): introduce active version column to revision list',
  'refactor(grid): clean up table column indexes and identifiers',
  'feat(dashboard): add status overview ribbon to main header',
  'feat(dialog): streamline dialog actions and edit form UX',
  'fix(action): hide trigger button when target entity is empty',
  'style(typography): tighten monospace font scale and line height',
  'feat(navigation): optimize tree layout and sidebar breadcrumbs',
  'style(formatter): standardize code formatting and array duration helper',
  'feat(filters): add sort by latest updated timestamp',
  'feat(tasks): separate completed and active jobs in task list',
  'style(layout): widen top statistical summary panels',
  'feat(notifications): only count unread items for badge indicator',
  'feat(notifications): support mark-as-read state in notification center',
  'feat(menu): sync sidebar badge counters with pending task count',
  'style(theme): harmonize font and color palette across list views',
  'feat(messages): add real-time unread dot indicators',
  'feat(announcements): clear notification dot on item click',
  'feat(workspace): redesign dashboard header with navigation shortcuts',
  'feat(widgets): update common utility widget styles',
  'feat(metrics): support click-to-filter on dashboard counters',
  'refactor(i18n): unify notification terminology across localizations',
  'feat(badge): add badge indicators for pending work items',
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
    { message: 'chore(config): ignore local environment override files', author: 'chenqinru', date: '2026-08-14T18:01:00+08:00', refs: ['main', 'HEAD -> main'] },
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
    if (index === 30) refs.push('origin/feat/query-builder');
    if (index === 40) refs.push('tag: v1.0.0');
    const author = lead?.author ?? (index % 9 === 0 ? 'chenqinru' : index % 7 === 0 ? 'alex' : 'sarah');
    const message = lead?.message ?? (mergeIndexes.has(index)
      ? `Merge branch '${index % 2 ? 'main' : 'prod'}' into feat/workspace-analytics`
      : standardDemoMessages[(index - leadRows.length) % standardDemoMessages.length]);
    return { ...makeCommit('transaction-works-admin', hash, message, author, date, refs, parents), incoming: index % 11 === 4, unpushed: index % 17 === 0 };
  });
}

function createSvnHistory(repoId: string, branch: string, author: string): CommitNode[] {
  return Array.from({ length: 42 }, (_, index) => {
    const revision = 7453 - index;
    const parents = index === 41 ? [] : [`r${revision - 1}`];
    const date = new Date(Date.UTC(2026, 7, 13, 8, 50) - index * 1000 * 60 * 125).toISOString();
    return makeCommit(repoId, `r${revision}`, index === 0 ? `SVN revision ${revision}` : `feat(${branch}): update service config and table schema`, author, date, index === 0 ? ['HEAD'] : [], parents);
  });
}

const demoHistories: Record<string, CommitNode[]> = Object.fromEntries([
  ['admin', createDemoHistory('admin', 'main', ['chenqinru', 'sarah', 'alex'])],
  ['api', createDemoHistory('api', 'prod', ['sarah', 'alex', 'chenqinru'])],
  ['sentry-admin', createDemoHistory('sentry-admin', 'main', ['sarah', 'jordan'])],
  ['system-admin', createDemoHistory('system-admin', 'prod', ['chenqinru', 'sarah'])],
  ['transaction-works-admin', createOfficeRulesHistory()],
]);

const mixedHistories: Record<string, CommitNode[]> = {
  'mixed-git': createDemoHistory('mixed-git', 'main', ['chenqinru', 'sarah']),
  'mixed-api-git': createDemoHistory('mixed-api-git', 'main', ['sarah', 'alex']),
  'mixed-admin-svn': createSvnHistory('mixed-admin-svn', 'admin_code', 'jordan'),
  'mixed-api-svn': createSvnHistory('mixed-api-svn', 'api', 'jordan'),
};

const activeHistories = browserDemoMode === 'mixed' ? mixedHistories : demoHistories;

const demoLocalBranchNames = [
  'prod', 'main', 'feat/auth-service', 'feat/event-listener', 'feat/data-permissions',
  'feat/remote-sync', 'feat/export-pdf', 'feat/local-history', 'feat/health-check',
  'feat/metadata-sync', 'feat/delay-queue', 'feat/task-center', 'feat/messaging',
  'feat/telemetry', 'feat/file-uploader', 'release/v1.0.0', 'release/v1.1.0',
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
  { ...initialRepositories[0], meta: { ...initialRepositories[0].meta, id: 'mixed-git', name: 'CORE-WEB' } },
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

const versionNames = ['prod/v0.0.2', 'prod/v0.0.3', 'prod/v1.0.0', 'prod/v1.0.1', 'prod/v1.0.2', 'test/v0.0.1', 'test/v1.0.0', 'test/v1.0.1', 'v0.0.1', 'v0.0.2', 'v1.0.0-beta', 'v1.0.1', 'v1.7.1', 'v1.7.2', 'v1.7.3', 'v1.8.0', 'v1.8.1', 'v1.8.2', 'v1.8.3', 'v1.9.0', 'v2.0.0', 'v2.0.1', 'v2.1.0'];
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
    { path: 'apps/service-api/src/main/java/cn/versiondock/api/ConfigService.java', status: 'M', added: 18, removed: 4 },
    { path: 'apps/service-api/src/main/resources/application.yml', status: 'M', added: 4, removed: 2 },
  ],
  'transaction-works-admin': [
    { path: 'apps/web-antd/src/views/service/analytics/data.ts', status: 'M', added: 6, removed: 2 },
    { path: 'apps/web-antd/src/views/service/dashboard/modules/chart-card.vue', status: 'M', added: 2, removed: 2 },
    { path: 'apps/web-antd/src/views/service/dashboard/index.vue', status: 'M', added: 1, removed: 1 },
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
  schemaVersion: 7, lastWorkspaceId: workspace.id, recentWorkspaces: [workspace], commitSelections: {},
  settings: { theme: 'dark', language: 'zhCn', uiFontSize: 'standard', fileIconTheme: 'material', changesDisplayMode: 'simplified', defaultCommitAction: 'commit', defaultSaveAction: 'stash', promptBeforeAddingUntracked: true, suppressDivergedWarning: false, autoRefreshInterval: 0, fetchOnStartup: false, resetViewLocationsOnStartup: false, notifyIncomingCommits: true, notifyUnpushedCommits: true, repositoryScanDepth: 4, ignoredFolders: ['node_modules', 'target', 'dist'], maximumGraphCommits: 1000, projectColors: {}, externalEditor: null },
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
    setSize: async () => undefined,
    onDragDrop: async () => () => undefined,
  };

  platform(): 'macos' | 'windows' | 'linux' { return 'macos'; }
  subscribe(handler: (event: BridgeEvent) => void): () => void { this.handlers.add(handler); return () => this.handlers.delete(handler); }
  getState<T>(): T | undefined { return this.state as T; }
  setState<T>(state: T): void { this.state = structuredClone(state as AppStateSnapshot); }
  send(command: BridgeCommand): void { void this.request(command); }
  async cancelOperation(): Promise<boolean> { return false; }
  async selectWorkspaceFolders(): Promise<string[]> { return workspace.paths; }
  async selectDirectory(): Promise<string | null> { return workspace.paths[0] ?? null; }
  async selectExecutable(): Promise<string | null> { return '/usr/local/bin/zed'; }
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

  private logs: LogEntry[] = [
    {
      id: 'demo-log-1',
      timestamp: new Date(Date.now() - 60000).toISOString(),
      level: 'info',
      channel: 'core',
      message: 'VersionDock Desktop workspace bootstrap initialized',
      details: null,
      durationMs: 12,
      exitCode: 0,
    },
    {
      id: 'demo-log-2',
      timestamp: new Date(Date.now() - 45000).toISOString(),
      level: 'info',
      channel: 'git',
      message: 'git status --porcelain=v2 -z --untracked-files=all --ignored=matching',
      details: null,
      durationMs: 34,
      exitCode: 0,
    },
    {
      id: 'demo-log-3',
      timestamp: new Date(Date.now() - 20000).toISOString(),
      level: 'warn',
      channel: 'svn',
      message: 'svn status --xml',
      details: null,
      durationMs: 88,
      exitCode: 0,
    },
  ];
  private logHandlers = new Set<(entry: LogEntry) => void>();

  async onLogEntry(handler: (entry: LogEntry) => void): Promise<() => void> {
    this.logHandlers.add(handler);
    return () => this.logHandlers.delete(handler);
  }
  async getLogs(channel?: LogChannel, level?: LogLevel, limit?: number): Promise<LogEntry[]> {
    return this.logs.filter((entry) => {
      if (channel && entry.channel !== channel) return false;
      if (level && entry.level !== level) return false;
      return true;
    }).slice(-(limit ?? 3000));
  }
  async clearLogs(): Promise<void> {
    this.logs = [];
  }
  async openLogFolder(): Promise<void> {
    console.info('[BrowserDevBridge] openLogFolder called');
  }
  async exportLogs(): Promise<boolean> {
    return true;
  }
  async pushClientLog(level: LogLevel, channel: LogChannel, message: string, details?: string): Promise<void> {
    const entry: LogEntry = {
      id: `client-log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date().toISOString(),
      level,
      channel,
      message,
      details: details ?? null,
      durationMs: null,
      exitCode: null,
    };
    this.logs.push(entry);
    this.logHandlers.forEach((h) => h(entry));
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
        applicationSessionId: 'browser-demo-session',
        capabilities: { ai: false, stash: true, shelf: true, changelist: true, worktree: true, subtree: true, submodule: true, compare: true, remoteManagement: true },
        runtime: unavailableRuntime,
      } satisfies BootstrapData;
      case 'runtimeCapabilities': return unavailableRuntime;
      case 'saveAppState': this.state = structuredClone(command.payload.state); return true;
      case 'updateSettings': this.state.settings = structuredClone(command.payload.settings); return { settings: command.payload.settings, effects: { rescanWorkspace: false, reloadHistory: false, restartAutoRefresh: true } };
      case 'updateLayout': this.state.layout = structuredClone(command.payload.layout); return command.payload.layout;
      case 'workspaceOpen': case 'workspaceRefresh': this.generation += 1; return this.snapshot();
      case 'initializeRepository': this.generation += 1; return { snapshot: this.snapshot(), repositoryId: this.repositories[0]?.meta.id ?? 'admin' };
      case 'cloneRepository': return { path: `${command.payload.parent_path}/${command.payload.target_name}` };
      case 'checkoutSvnRepository': return { path: `${command.payload.parent_path}/${command.payload.target_name}` };
      case 'saveCommitSelections': return command.payload.selections;
      case 'branchRecovery': return { status: 'completed', target: command.payload.operation.target, stashReference: command.payload.operation.type === 'forceCheckout' ? null : 'stash@{0}', changesRestored: command.payload.operation.type === 'carryChanges', error: null, recoveryHint: null };
      case 'restoreConflicts': return { restoredPaths: [], failures: [] };
      case 'providerAccounts': return [];
      case 'providerGithubBegin': return { flowId: 'demo-flow', userCode: 'DEMO-CODE', verificationUri: 'https://github.com/login/device', expiresAt: new Date(Date.now() + 900000).toISOString(), interval: 5 };
      case 'providerGithubComplete': throw new Error('GitHub OAuth is unavailable in browser demo');
      case 'providerGithubSave': return { id: command.payload.account_id ?? 'github-demo', provider: 'github', host: 'https://github.com', login: 'github-demo-user', displayName: 'Demo GitHub User', secureStorageRef: 'browser-demo' };
      case 'providerGitlabSave': return { id: command.payload.account_id ?? 'gitlab-demo', provider: 'gitlab', host: command.payload.host, login: 'demo', displayName: 'Demo', secureStorageRef: 'browser-demo' };
      case 'providerGiteeSave': return { id: command.payload.account_id ?? 'gitee-demo', provider: 'gitee', host: 'https://gitee.com', login: 'gitee-demo-user', displayName: 'Demo Gitee User', secureStorageRef: 'browser-demo' };
      case 'providerRemove': return true;
      case 'providerRepositories': return { items: [], page: command.payload.page, hasMore: false };
      case 'providerNamespaces': return [];
      case 'publishRepository': return { repository: { id: 'demo', provider: 'github', host: 'https://github.com', name: command.payload.name, fullName: `demo/${command.payload.name}`, cloneUrl: `https://github.com/demo/${command.payload.name}.git`, webUrl: null, defaultBranch: 'main', namespace: null, private: command.payload.visibility === 'private' }, remoteCreated: true, remoteConfigured: true, pushAttempted: command.payload.push, pushed: command.payload.push, failedStage: null, recoveryHint: null, error: null };
      case 'workspaceRemoveRecent': return true;
      case 'repositoryStatus': return this.repositories.find((repo) => repo.meta.id === command.payload.repo_id);
      case 'history': {
        const values = activeHistories[command.payload.repo_id] ?? [];
        const revision = command.payload.query.revision?.replace(/^refs\/(?:heads|tags)\//, '');
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
        const query = command.payload.query;
        const filtered = scoped.filter((commit) => (!query.text || `${commit.hash} ${commit.message} ${commit.author}`.toLowerCase().includes(query.text.toLowerCase())) && (!query.author || commit.author.toLowerCase().includes(query.author.toLowerCase())) && (!query.fromDate || commit.committerDate.slice(0, 10) >= query.fromDate) && (!query.toDate || commit.committerDate.slice(0, 10) <= query.toDate));
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
      case 'unpushedCommits': {
        const values = command.payload.repo_id === 'admin' ? (activeHistories.admin ?? []).slice(0, 1) : [];
        return values.map((commit, index) => ({
          hash: commit.hash,
          shortHash: commit.shortHash,
          message: commit.message,
          body: index === 0 ? 'Updates the configuration workflow and keeps the browser preview representative.' : null,
          fullMessage: commit.message,
          author: commit.author,
          date: commit.committerDate,
          filesChanged: 3,
          additions: 24,
          deletions: 6,
          parents: commit.parents,
        })) satisfies UnpushedCommit[];
      }
      case 'incomingCommits': {
        const count = this.repositories.find((repo) => repo.meta.id === command.payload.repo_id)?.behind ?? 0;
        const values = (activeHistories[command.payload.repo_id] ?? activeHistories.api ?? []).slice(0, count);
        return values.map((commit, index) => ({
          hash: commit.hash,
          shortHash: commit.shortHash,
          message: commit.message,
          body: index === 0 ? 'Remote changes ready to be reviewed before updating the local branch.' : null,
          fullMessage: commit.message,
          author: commit.author,
          date: commit.committerDate,
          filesChanged: Math.max(1, 3 - index),
          additions: 18 + index * 7,
          deletions: 4 + index * 2,
          parents: commit.parents,
          potentialConflictPaths: [],
        })) satisfies IncomingCommit[];
      }
      case 'unpushedChanges': return {
        fromRevision: command.payload.oldest_revision ?? 'origin/main',
        toRevision: this.repositories.find((repo) => repo.meta.id === command.payload.repo_id)?.revision ?? 'HEAD',
        files: activeDetailFiles[command.payload.repo_id] ?? [],
      };
      case 'incomingChanges': return {
        fromRevision: this.repositories.find((repo) => repo.meta.id === command.payload.repo_id)?.revision ?? 'HEAD',
        toRevision: `origin/${this.repositories.find((repo) => repo.meta.id === command.payload.repo_id)?.branch ?? 'main'}`,
        files: activeDetailFiles[command.payload.repo_id] ?? [],
      };
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
      case 'recentCommitMessages': return command.payload.repo_ids.flatMap((repoId) => (activeHistories[repoId] ?? []).slice(0, 10).map((commit) => ({ repoId, revision: commit.hash, committedAt: commit.committerDate, message: commit.message }))).slice(0, command.payload.limit);
      case 'lastCommitMessage': return activeHistories[command.payload.repo_id]?.[0]?.message ?? null;
      case 'batchCommit': return command.payload.targets.map((target) => ({ repoId: target.repoId, commitAttempted: true, committed: true, revision: activeHistories[target.repoId]?.[0]?.hash ?? 'browser-demo-commit', pushAttempted: command.payload.push, pushed: command.payload.push, failedStage: null, recoveryHint: null, error: null }));
      case 'branchCompare': return { base: command.payload.base, target: command.payload.target, baseCommits: [], targetCommits: [], files: activeDetailFiles[command.payload.repo_id] ?? [] };
      case 'conflictVersions': return { path: command.payload.relative_path, base: 'base', ours: 'ours', theirs: 'theirs', working: '<<<<<<< OURS\nours\n||||||| BASE\nbase\n=======\ntheirs\n>>>>>>> THEIRS', markerContent: '<<<<<<< OURS\nours\n||||||| BASE\nbase\n=======\ntheirs\n>>>>>>> THEIRS', conflicts: [{ index: 0, oursLabel: 'OURS', theirsLabel: 'THEIRS', oursLines: ['ours'], baseLines: ['base'], theirsLines: ['theirs'], startLine: 0, endLine: 6 }], oursLabel: 'OURS', theirsLabel: 'THEIRS', language: 'text', fingerprint: 'browser-demo', binary: false };
      case 'sync': return { output: '', update: command.payload.action === 'pull' || command.payload.action === 'pullRebase' || command.payload.action === 'update' ? { repoId: command.payload.repo_id, beforeRevision: 'before', afterRevision: 'after', beforeStatus: 'before-status', afterStatus: 'after-status', summary: { kind: 'fastForward', commitCount: 1, fileCount: 1, containsMerge: false, detail: { commits: (activeHistories[command.payload.repo_id] ?? []).slice(0, 1), files: activeDetailFiles[command.payload.repo_id] ?? [] } }, summaryError: null } : null };
      case 'openWorktree': return command.payload.path;
      case 'branchOperation': return { completed: true, conflicted: false };
      case 'tagOperation': case 'stashOperation': case 'shelfOperation':
      case 'changelistOperation': case 'worktreeOperation': case 'remoteOperation': case 'svnOperation': case 'submoduleOperation': case 'historyOperation': case 'systemOpen':
      case 'conflictSave': case 'conflictAccept': case 'abortRepositoryOperation': case 'windowSetSize': return true;
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
