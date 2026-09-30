import type {
  BridgeCommand, DesktopError, OperationDomain,
  OperationEvent, RepositoryEvent, RequestContext, ResponseEnvelope, WindowTabImport,
  WindowTabTransfer, WindowTabTransferCompleted, WorkspaceEvent,
  LogEntry, LogLevel, LogChannel,
} from '../bindings/generated';
import { platform as osPlatform } from '@tauri-apps/plugin-os';

export interface RequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  showProgress?: boolean;
  context?: Partial<Omit<RequestContext, 'generation'>> & { generation?: number };
}

export interface NewWindowPlacement {
  x: number;
  y: number;
  width?: number;
  height?: number;
}

export interface WindowDragGeometry {
  point: { screenX: number; screenY: number };
  sourceBounds: { x: number; y: number; width: number; height: number };
}

export type BridgeEvent = OperationEvent | WorkspaceEvent | RepositoryEvent | { type: 'native-unavailable' };

export interface VersionDockBridge {
  send(command: BridgeCommand): void;
  request<T>(command: BridgeCommand, options?: RequestOptions): Promise<T>;
  cancelOperation(operationId: string): Promise<boolean>;
  subscribe(handler: (event: BridgeEvent) => void): () => void;
  getState<T>(): T | undefined;
  setState<T>(state: T): void;
  platform(): 'macos' | 'windows' | 'linux';
  selectWorkspaceFolders(title: string): Promise<string[]>;
  selectDirectory(title: string): Promise<string | null>;
  selectExecutable(title: string): Promise<string | null>;
  saveFileDialog(options: { title?: string; defaultPath?: string; filters?: Array<{ name: string; extensions: string[] }> }): Promise<string | null>;
  openInNewWindow(paths?: string[], placement?: NewWindowPlacement, transfer?: WindowTabTransfer): Promise<string>;
  transferTab(transfer: WindowTabTransfer, point: { screenX: number; screenY: number }, placement: NewWindowPlacement, attachToExisting?: boolean): Promise<boolean>;
  syncWindowTabs(workspacePaths: string[][], activeWorkspaceId: string | null): Promise<void>;
  syncWindowBounds(bounds: { x: number; y: number; width: number; height: number }): Promise<void>;
  focusWorkspaceAcrossWindows(paths: string[]): Promise<boolean>;
  onFocusTab(handler: (paths: string[]) => void): Promise<() => void>;
  windowTabDrop(transfer: WindowTabTransfer, point: { screenX: number; screenY: number }): Promise<boolean>;
  onImportTab(handler: (payload: WindowTabImport) => void): Promise<() => void>;
  completeTabTransfer(transfer: WindowTabTransfer, targetWindowLabel: string, accepted: boolean): Promise<void>;
  onTabTransferCompleted(handler: (payload: WindowTabTransferCompleted) => void): Promise<() => void>;
  getWindowLabel(): Promise<string>;
  broadcastTabDragState(state: TabDragPayload | null): Promise<void>;
  onTabDragState(handler: (state: TabDragPayload | null) => void): Promise<() => void>;
  onLogEntry(handler: (entry: LogEntry) => void): Promise<() => void>;
  getLogs(channel?: LogChannel, level?: LogLevel, limit?: number): Promise<LogEntry[]>;
  clearLogs(): Promise<void>;
  openLogFolder(): Promise<void>;
  exportLogs(targetPath: string): Promise<boolean>;
  pushClientLog(level: LogLevel, channel: LogChannel, message: string, details?: string): Promise<void>;
  window: {
    startDragging(): Promise<void>;
    toggleMaximize(): Promise<void>;
    minimize(): Promise<void>;
    close(): Promise<void>;
    isMaximized(): Promise<boolean>;
    dragGeometry(): Promise<WindowDragGeometry | null>;
    setCursorIcon(icon: 'default' | 'grab' | 'grabbing' | 'copy'): Promise<void>;
    setSize(width: number, height: number, center?: boolean): Promise<void>;
    onDragDrop(handler: (paths: string[]) => void): Promise<() => void>;
  };
}

export interface TabDragPayload {
  sourceWindowLabel: string;
  tabId: string;
  tabName: string;
  tabWidth: number;
  paths: string[];
  screenX: number;
  screenY: number;
  targetWindowLabel?: string | null;
  targetClientX?: number | null;
}

export function isAbortError(error: unknown): boolean {
  if (!error) return false;
  if (error instanceof DOMException && error.name === 'AbortError') return true;
  if (typeof error === 'object') {
    const candidate = error as { name?: string; code?: string | number; message?: string };
    if (candidate.name === 'AbortError') return true;
    if (candidate.code === 'ABORT_ERR' || candidate.code === 20) return true;
    if (candidate.code === 'REQUEST_CANCELLED') return true;
    if (typeof candidate.message === 'string' && (
      candidate.message.includes('Operation aborted') ||
      candidate.message.includes('Operation cancelled') ||
      candidate.message.includes('The user aborted a request') ||
      candidate.message.includes('AbortError') ||
      candidate.message.includes('BodyStreamBuffer was aborted')
    )) {
      return true;
    }
  }
  if (typeof error === 'string') {
    return error.includes('Operation aborted') || error.includes('Operation cancelled') || error.includes('AbortError');
  }
  return false;
}

export class BridgeError extends Error implements DesktopError {
  code: string;
  command: string | null;
  exitCode: number | null;
  stderr: string | null;
  recoverable: boolean;
  operation?: string | null;
  workspaceId?: string | null;
  repositoryId?: string | null;
  subject?: string | null;
  hint?: string | null;

  constructor(error: DesktopError) {
    super(error.message);
    this.name = 'BridgeError';
    this.code = error.code;
    this.command = error.command;
    this.exitCode = error.exitCode;
    this.stderr = error.stderr;
    this.recoverable = error.recoverable;
    this.operation = error.operation;
    this.workspaceId = error.workspaceId;
    this.repositoryId = error.repositoryId;
    this.subject = error.subject;
    this.hint = error.hint;
  }
}

let requestSequence = 0;
function requestId(): string {
  requestSequence += 1;
  const entropy = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `req-${entropy}-${requestSequence}`;
}

const commandDomain = (command: BridgeCommand): OperationDomain => {
  switch (command.type) {
    case 'bootstrap': case 'runtimeCapabilities': case 'saveAppState': case 'saveCommitSelections': case 'updateSettings': case 'updateLayout': return 'application';
    case 'workspaceOpen': case 'workspaceRefresh': case 'workspaceRemoveRecent': case 'initializeRepository': case 'cloneRepository': case 'checkoutSvnRepository': return 'workspace';
    case 'repositoryStatus': return 'status';
    case 'fileDiff': case 'stashFileDiff': case 'shelfFileDiff': case 'worktreeDiff':
    case 'worktreeFileDiff': case 'branchWorkingDiff': case 'branchWorkingFileDiff': return 'diff';
    case 'history': case 'historyTopology': case 'commitDetail': case 'commitMergeCommits':
    case 'commitMergeParentFiles': case 'unpushedCommits': case 'unpushedOperation':
    case 'historyOperation': case 'createPatch': case 'savePatch': case 'branchCompare': case 'branchCompareCommits': return 'history';
    case 'branches': case 'branchOperation': case 'branchRecovery': case 'gitUnlockIndex': return 'branch';
    case 'tags': case 'tagOperation': return 'tag';
    case 'commit': case 'batchCommit': case 'recentCommitMessages': case 'lastCommitMessage': return 'commit';
    case 'sync': return 'sync';
    case 'conflicts': case 'conflictVersions': case 'conflictSave': case 'conflictAccept':
    case 'abortRepositoryOperation': case 'continueRepositoryOperation': case 'restoreConflicts': return 'conflict';
    case 'stashes': case 'stashOperation': return 'stash';
    case 'shelves': case 'shelfOperation': return 'shelf';
    case 'changelists': case 'changelistOperation': return 'changelist';
    case 'worktrees': case 'worktreeOperation': case 'openWorktree': return 'worktree';
    case 'subtrees': case 'subtreeOperation': return 'subtree';
    case 'submodules': case 'submoduleOperation': return 'submodule';
    case 'remotes': case 'remoteOperation': return 'remote';
    case 'providerAccounts': case 'providerGithubBegin': case 'providerGithubComplete': case 'providerGithubSave': case 'providerGitlabSave': case 'providerGiteeSave': case 'providerRemove': case 'providerRepositories': case 'providerNamespaces': case 'publishRepository': return 'remote';
    case 'gitIdentity': case 'gitProfileOperation': return 'identity';
    case 'svnAccount': case 'svnAccountOperation': case 'svnOperation': return 'svnAccount';
    case 'fileHistory': case 'fileRevisionContent': return 'fileHistory';
    default: return 'system';
  }
};

const commandIdentifiers = (command: BridgeCommand) => {
  const payload = 'payload' in command ? command.payload as unknown as Record<string, unknown> : {};
  const text = (key: string) => typeof payload[key] === 'string' ? payload[key] as string : null;
  return {
    workspaceId: text('workspace_id'),
    repositoryId: text('repo_id'),
    target: text('relative_path') ?? text('path') ?? text('revision') ?? text('target'),
  };
};

export const commandShowsProgressByDefault = (command: BridgeCommand): boolean => {
  switch (command.type) {
    case 'workspaceOpen': case 'workspaceRefresh': case 'workspaceRemoveRecent':
    case 'initializeRepository': case 'cloneRepository': case 'checkoutSvnRepository':
    case 'stage': case 'unstage': case 'discard': case 'deletePaths': case 'addIgnore': case 'updateIgnoreRules':
    case 'commit': case 'batchCommit': case 'sync': case 'branchOperation': case 'branchRecovery': case 'gitUnlockIndex': case 'tagOperation':
    case 'conflictSave': case 'conflictAccept': case 'abortRepositoryOperation': case 'continueRepositoryOperation': case 'restoreConflicts':
    case 'stashOperation': case 'shelfOperation': case 'changelistOperation': case 'worktreeOperation':
    case 'subtreeOperation': case 'submoduleOperation': case 'unpushedOperation': case 'historyOperation':
    case 'svnOperation': case 'remoteOperation': case 'gitProfileOperation': case 'svnAccountOperation':
    case 'providerGithubBegin': case 'providerGithubComplete': case 'providerGithubSave': case 'providerGitlabSave': case 'providerGiteeSave': case 'providerRemove': case 'publishRepository':
      return true;
    default:
      return false;
  }
};

export function commandProgressVisibility(command: BridgeCommand, options: RequestOptions = {}): RequestContext['visibility'] {
  // Passive queries render loading state in their own view, even if a caller opts in.
  if (!commandShowsProgressByDefault(command) || options.showProgress === false) return 'background';
  return options.context?.visibility ?? 'foreground';
}

export class TauriBridge implements VersionDockBridge {
  private state: unknown;
  private handlers = new Set<(event: BridgeEvent) => void>();
  private unlisten?: () => void;
  private windowSyncQueue: Promise<void> = Promise.resolve();
  private contextGenerations = new Map<string, number>();
  private currentPlatform: 'macos' | 'windows' | 'linux' = (() => { const value = osPlatform(); return value === 'macos' || value === 'windows' ? value : 'linux'; })();

  readonly window = {
    startDragging: async () => (await import('@tauri-apps/api/window')).getCurrentWindow().startDragging(),
    toggleMaximize: async () => (await import('@tauri-apps/api/window')).getCurrentWindow().toggleMaximize(),
    minimize: async () => (await import('@tauri-apps/api/window')).getCurrentWindow().minimize(),
    close: async () => (await import('@tauri-apps/api/window')).getCurrentWindow().close(),
    isMaximized: async () => (await import('@tauri-apps/api/window')).getCurrentWindow().isMaximized(),
    setCursorIcon: async (icon: 'default' | 'grab' | 'grabbing' | 'copy') => (await import('@tauri-apps/api/window')).getCurrentWindow().setCursorIcon(icon),
    setSize: async (width: number, height: number, center = false) => {
      try {
        await this.request({ type: 'windowSetSize', payload: { width, height, center } }, { showProgress: false });
      } catch {
        const { LogicalSize } = await import('@tauri-apps/api/dpi');
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const currentWindow = getCurrentWindow();
        await currentWindow.setSize(new LogicalSize(width, height));
        if (center) {
          await currentWindow.center();
        }
      }
    },
    dragGeometry: async () => {
      const { cursorPosition, getCurrentWindow } = await import('@tauri-apps/api/window');
      const currentWindow = getCurrentWindow();
      const [cursor, position, size, rawScaleFactor] = await Promise.all([
        cursorPosition(),
        currentWindow.outerPosition(),
        currentWindow.outerSize(),
        currentWindow.scaleFactor(),
      ]);
      const scaleFactor = rawScaleFactor > 0 ? rawScaleFactor : 1;
      return {
        point: {
          screenX: position.x / scaleFactor + (cursor.x - position.x) / scaleFactor,
          screenY: position.y / scaleFactor + (cursor.y - position.y) / scaleFactor,
        },
        sourceBounds: {
          x: position.x / scaleFactor,
          y: position.y / scaleFactor,
          width: size.width / scaleFactor,
          height: size.height / scaleFactor,
        },
      };
    },
    onDragDrop: async (handler: (paths: string[]) => void) => (await import('@tauri-apps/api/window')).getCurrentWindow().onDragDropEvent(({ payload }) => {
      if (payload.type === 'drop') handler(payload.paths);
    }),
  };

  async initialize(): Promise<void> {
    const { listen } = await import('@tauri-apps/api/event');
    this.unlisten = await listen<OperationEvent | WorkspaceEvent | RepositoryEvent>('versiondock://event', ({ payload }) => {
      if ('operationId' in payload && payload.context.visibility === 'background') return;
      this.handlers.forEach((handler) => handler(payload));
    });
  }

  dispose(): void {
    this.unlisten?.();
    this.handlers.clear();
  }

  send(command: BridgeCommand): void {
    void this.request(command, { showProgress: false }).catch(() => undefined);
  }

  async cancelOperation(operationId: string): Promise<boolean> {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<boolean>('bridge_cancel', { requestId: operationId });
  }

  async request<T>(command: BridgeCommand, options: RequestOptions = {}): Promise<T> {
    const id = requestId();
    const inferred = commandIdentifiers(command);
    const contextBase = {
      domain: options.context?.domain ?? commandDomain(command),
      workspaceId: options.context?.workspaceId ?? inferred.workspaceId,
      repositoryId: options.context?.repositoryId ?? inferred.repositoryId,
      target: options.context?.target ?? inferred.target,
    };
    const contextKey = [contextBase.domain, contextBase.workspaceId, contextBase.repositoryId, contextBase.target].join(':');
    const context: RequestContext = {
      ...contextBase,
      generation: options.context?.generation ?? (this.contextGenerations.get(contextKey) ?? 0) + 1,
      visibility: commandProgressVisibility(command, options),
    };
    this.contextGenerations.set(contextKey, context.generation);
    const timeoutMs = options.timeoutMs ?? 120_000;
    const { invoke } = await import('@tauri-apps/api/core');
    if (options.signal?.aborted) throw new DOMException('Operation aborted', 'AbortError');

    let timeout: ReturnType<typeof setTimeout> | undefined;
    let abortHandler: (() => void) | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        void invoke('bridge_cancel', { requestId: id }).catch(() => undefined);
        reject(new BridgeError({
          code: 'REQUEST_TIMEOUT',
          message: `Request timed out after ${timeoutMs}ms`,
          command: null,
          exitCode: null,
          stderr: null,
          recoverable: true,
        }));
      }, timeoutMs);
      abortHandler = () => {
        void invoke('bridge_cancel', { requestId: id }).catch(() => undefined);
        reject(new DOMException('Operation aborted', 'AbortError'));
      };
      options.signal?.addEventListener('abort', abortHandler, { once: true });
    });

    try {
      const response = await Promise.race([
        invoke<ResponseEnvelope>('bridge_request', {
          envelope: {
            requestId: id,
            context,
            command,
          },
        }),
        timeoutPromise,
      ]);

      if (response.error) {
        throw new BridgeError(response.error);
      }

      return response.result as T;
    } catch (error) {
      if (isAbortError(error) || error instanceof BridgeError) throw error;
      throw new BridgeError({
        code: 'BRIDGE_INVOKE_FAILED',
        message: error instanceof Error ? error.message : String(error),
        command: null,
        exitCode: null,
        stderr: null,
        recoverable: false,
      });
    } finally {
      if (timeout) clearTimeout(timeout);
      if (abortHandler) options.signal?.removeEventListener('abort', abortHandler);
    }
  }

  subscribe(handler: (event: BridgeEvent) => void): () => void {
    this.handlers.add(handler);
    return () => { this.handlers.delete(handler); };
  }

  getState<T>(): T | undefined { return this.state as T | undefined; }
  setState<T>(state: T): void { this.state = state; }
  platform(): 'macos' | 'windows' | 'linux' { return this.currentPlatform; }
  async selectWorkspaceFolders(title: string): Promise<string[]> {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const value = await open({ directory: true, multiple: true, title });
    return !value ? [] : Array.isArray(value) ? value : [value];
  }
  async selectDirectory(title: string): Promise<string | null> {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const value = await open({ directory: true, multiple: false, title });
    return typeof value === 'string' ? value : null;
  }
  async selectExecutable(title: string): Promise<string | null> {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const value = await open({
      directory: false,
      multiple: false,
      title,
    });
    return typeof value === 'string' ? value : null;
  }
  async saveFileDialog(options: { title?: string; defaultPath?: string; filters?: Array<{ name: string; extensions: string[] }> }): Promise<string | null> {
    try {
      const { save } = await import('@tauri-apps/plugin-dialog');
      const value = await save(options);
      return typeof value === 'string' ? value : null;
    } catch {
      return null;
    }
  }
  async openInNewWindow(paths?: string[], placement?: NewWindowPlacement, transfer?: WindowTabTransfer): Promise<string> {
    return this.request<string>({
      type: 'windowOpenNew',
      payload: {
        paths: paths ?? null,
        x: placement?.x ?? null,
        y: placement?.y ?? null,
        width: placement?.width ?? null,
        height: placement?.height ?? null,
        transfer: transfer ?? null,
      },
    }, { showProgress: false });
  }
  async syncWindowTabs(workspacePaths: string[][], activeWorkspaceId: string | null): Promise<void> {
    this.windowSyncQueue = this.windowSyncQueue.catch(() => undefined).then(async () => {
      await this.request({
        type: 'windowSyncTabs',
        payload: {
          workspace_paths: workspacePaths,
          active_workspace_id: activeWorkspaceId,
        },
      }, { showProgress: false });
    });
    await this.windowSyncQueue;
  }
  async syncWindowBounds(bounds: { x: number; y: number; width: number; height: number }): Promise<void> {
    await this.request({
      type: 'windowSyncBounds',
      payload: {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
      },
    }, { showProgress: false });
  }
  async focusWorkspaceAcrossWindows(paths: string[]): Promise<boolean> {
    return this.request<boolean>({
      type: 'windowFocusWorkspace',
      payload: {
        paths,
      },
    }, { showProgress: false });
  }
  async onFocusTab(handler: (paths: string[]) => void): Promise<() => void> {
    const { listen } = await import('@tauri-apps/api/event');
    return listen<string[]>('versiondock://focus-tab', ({ payload }) => {
      handler(payload);
    });
  }
  async windowTabDrop(transfer: WindowTabTransfer, point: { screenX: number; screenY: number }): Promise<boolean> {
    return this.request<boolean>({
      type: 'windowTabDrop',
      payload: {
        transfer,
        screen_x: point.screenX,
        screen_y: point.screenY,
      },
    }, { showProgress: false });
  }
  async transferTab(transfer: WindowTabTransfer, point: { screenX: number; screenY: number }, placement: NewWindowPlacement, attachToExisting = true): Promise<boolean> {
    let dispose: (() => void) | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let resolveCompletion: (accepted: boolean) => void = () => undefined;
    const completed = new Promise<boolean>((resolve) => {
      resolveCompletion = resolve;
    });
    try {
      // The source tab remains intact until the destination has loaded the workspace
      // and acknowledged the transfer, so a failed scan cannot lose the user's tab.
      dispose = await this.onTabTransferCompleted((payload) => {
        if (payload.transferId === transfer.transferId) resolveCompletion(payload.accepted);
      });
      timeout = setTimeout(() => resolveCompletion(false), 120_000);
      const attached = attachToExisting && await this.windowTabDrop(transfer, point);
      if (!attached) await this.openInNewWindow(transfer.paths, placement, transfer);
      return await completed;
    } finally {
      if (timeout) clearTimeout(timeout);
      dispose?.();
    }
  }
  async onImportTab(handler: (payload: WindowTabImport) => void): Promise<() => void> {
    const { listen } = await import('@tauri-apps/api/event');
    return listen<WindowTabImport>('versiondock://import-tab', ({ payload }) => {
      handler(payload);
    });
  }
  async completeTabTransfer(transfer: WindowTabTransfer, targetWindowLabel: string, accepted: boolean): Promise<void> {
    await this.request({
      type: 'windowCompleteTabTransfer',
      payload: {
        transfer_id: transfer.transferId,
        source_window_label: transfer.sourceWindowLabel,
        tab_id: transfer.tabId,
        target_window_label: targetWindowLabel,
        accepted,
      },
    }, { showProgress: false });
  }
  async onTabTransferCompleted(handler: (payload: WindowTabTransferCompleted) => void): Promise<() => void> {
    const { listen } = await import('@tauri-apps/api/event');
    return listen<WindowTabTransferCompleted>('versiondock://tab-transfer-completed', ({ payload }) => {
      handler(payload);
    });
  }
  async getWindowLabel(): Promise<string> {
    const win = (await import('@tauri-apps/api/window')).getCurrentWindow();
    return win.label;
  }
  async broadcastTabDragState(state: TabDragPayload | null): Promise<void> {
    const { emit } = await import('@tauri-apps/api/event');
    await emit('versiondock://tab-drag-state', state);
  }
  async onTabDragState(handler: (state: TabDragPayload | null) => void): Promise<() => void> {
    const { listen } = await import('@tauri-apps/api/event');
    return listen<TabDragPayload | null>('versiondock://tab-drag-state', ({ payload }) => {
      handler(payload);
    });
  }
  async onLogEntry(handler: (entry: LogEntry) => void): Promise<() => void> {
    const { listen } = await import('@tauri-apps/api/event');
    return listen<LogEntry>('versiondock://log-entry', ({ payload }) => {
      handler(payload);
    });
  }
  async getLogs(channel?: LogChannel, level?: LogLevel, limit?: number): Promise<LogEntry[]> {
    return this.request<LogEntry[]>({
      type: 'logGet',
      payload: {
        channel: channel ?? null,
        level: level ?? null,
        limit: limit ?? null,
      },
    }, { showProgress: false });
  }
  async clearLogs(): Promise<void> {
    await this.request({ type: 'logClear' }, { showProgress: false });
  }
  async openLogFolder(): Promise<void> {
    await this.request({ type: 'logOpenFolder' }, { showProgress: false });
  }
  async exportLogs(targetPath: string): Promise<boolean> {
    return this.request<boolean>({
      type: 'logExport',
      payload: {
        target_path: targetPath,
      },
    }, { showProgress: false });
  }
  async pushClientLog(level: LogLevel, channel: LogChannel, message: string, details?: string): Promise<void> {
    await this.request({
      type: 'logClientPush',
      payload: {
        level,
        channel,
        message,
        details: details ?? null,
      },
    }, { showProgress: false });
  }
}

export class MockBridge implements VersionDockBridge {
  private state: unknown;
  constructor(private readonly responder: (command: BridgeCommand, options?: RequestOptions) => unknown | Promise<unknown>) {}
  send(command: BridgeCommand): void { void this.responder(command); }
  async request<T>(command: BridgeCommand, options?: RequestOptions): Promise<T> { return this.responder(command, options) as Promise<T>; }
  async cancelOperation(): Promise<boolean> { return false; }
  subscribe(handler?: (event: BridgeEvent) => void): () => void {
    void handler;
    return () => undefined;
  }
  getState<T>(): T | undefined { return this.state as T | undefined; }
  setState<T>(state: T): void { this.state = state; }
  platform(): 'macos' | 'windows' | 'linux' { return 'linux'; }
  async selectWorkspaceFolders(): Promise<string[]> { return []; }
  async selectDirectory(): Promise<string | null> { return null; }
  async selectExecutable(): Promise<string | null> { return Promise.resolve('/usr/local/bin/mock-editor'); }
  async saveFileDialog(): Promise<string | null> { return null; }
  async openInNewWindow(): Promise<string> {
    return Promise.resolve('mock-window-new');
  }
  async transferTab(): Promise<boolean> {
    return Promise.resolve(true);
  }
  async syncWindowTabs(...args: Parameters<VersionDockBridge['syncWindowTabs']>): Promise<void> {
    void args;
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
    return 'mock-window';
  }
  async broadcastTabDragState(): Promise<void> {
    return Promise.resolve();
  }
  async onTabDragState(): Promise<() => void> {
    return Promise.resolve(() => undefined);
  }
  async onLogEntry(): Promise<() => void> {
    return Promise.resolve(() => undefined);
  }
  async getLogs(): Promise<LogEntry[]> {
    return Promise.resolve([]);
  }
  async clearLogs(): Promise<void> {
    return Promise.resolve();
  }
  async openLogFolder(): Promise<void> {
    return Promise.resolve();
  }
  async exportLogs(): Promise<boolean> {
    return Promise.resolve(true);
  }
  async pushClientLog(): Promise<void> {
    return Promise.resolve();
  }
  readonly window = {
    startDragging: async () => undefined, toggleMaximize: async () => undefined, minimize: async () => undefined, close: async () => undefined,
    isMaximized: async () => false, dragGeometry: async () => null, setCursorIcon: async () => undefined, setSize: async () => undefined, onDragDrop: async () => () => undefined,
  };
}
