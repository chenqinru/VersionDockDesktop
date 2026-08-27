import type { BridgeCommand, DesktopError, ProgressEvent, RepositoryEvent, ResponseEnvelope, WorkspaceEvent } from '../bindings/generated';
import { platform as osPlatform } from '@tauri-apps/plugin-os';

export interface RequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type BridgeEvent = ProgressEvent | WorkspaceEvent | RepositoryEvent | { type: 'native-unavailable' };

export interface VersionDockBridge {
  send(command: BridgeCommand): void;
  request<T>(command: BridgeCommand, options?: RequestOptions): Promise<T>;
  subscribe(handler: (event: BridgeEvent) => void): () => void;
  getState<T>(): T | undefined;
  setState<T>(state: T): void;
  platform(): 'macos' | 'windows' | 'linux';
  selectWorkspaceFolders(title: string): Promise<string[]>;
  notify(title: string, body: string): Promise<boolean>;
  openInNewWindow(paths?: string[], position?: { x: number; y: number }): Promise<void>;
  syncWindowTabs(workspacePaths: string[][]): Promise<void>;
  focusWorkspaceAcrossWindows(paths: string[]): Promise<boolean>;
  onFocusTab(handler: (paths: string[]) => void): Promise<() => void>;
  window: {
    startDragging(): Promise<void>;
    toggleMaximize(): Promise<void>;
    minimize(): Promise<void>;
    close(): Promise<void>;
    isMaximized(): Promise<boolean>;
    onDragDrop(handler: (paths: string[]) => void): Promise<() => void>;
  };
}

export function isAbortError(error: unknown): boolean {
  if (!error) return false;
  if (error instanceof DOMException && error.name === 'AbortError') return true;
  if (typeof error === 'object') {
    const candidate = error as { name?: string; code?: string | number; message?: string };
    if (candidate.name === 'AbortError') return true;
    if (candidate.code === 'ABORT_ERR' || candidate.code === 20) return true;
    if (typeof candidate.message === 'string' && (
      candidate.message.includes('Operation aborted') ||
      candidate.message.includes('The user aborted a request') ||
      candidate.message.includes('AbortError') ||
      candidate.message.includes('BodyStreamBuffer was aborted')
    )) {
      return true;
    }
  }
  if (typeof error === 'string') {
    return error.includes('Operation aborted') || error.includes('AbortError');
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
  return `req-${Date.now()}-${requestSequence}`;
}

export class TauriBridge implements VersionDockBridge {
  private state: unknown;
  private handlers = new Set<(event: BridgeEvent) => void>();
  private unlisten?: () => void;
  private currentPlatform: 'macos' | 'windows' | 'linux' = (() => { const value = osPlatform(); return value === 'macos' || value === 'windows' ? value : 'linux'; })();

  readonly window = {
    startDragging: async () => (await import('@tauri-apps/api/window')).getCurrentWindow().startDragging(),
    toggleMaximize: async () => (await import('@tauri-apps/api/window')).getCurrentWindow().toggleMaximize(),
    minimize: async () => (await import('@tauri-apps/api/window')).getCurrentWindow().minimize(),
    close: async () => (await import('@tauri-apps/api/window')).getCurrentWindow().close(),
    isMaximized: async () => (await import('@tauri-apps/api/window')).getCurrentWindow().isMaximized(),
    onDragDrop: async (handler: (paths: string[]) => void) => (await import('@tauri-apps/api/window')).getCurrentWindow().onDragDropEvent(({ payload }) => {
      if (payload.type === 'drop') handler(payload.paths);
    }),
  };

  async initialize(): Promise<void> {
    const { listen } = await import('@tauri-apps/api/event');
    this.unlisten = await listen<ProgressEvent | WorkspaceEvent | RepositoryEvent>('versiondock://event', ({ payload }) => {
      this.handlers.forEach((handler) => handler(payload));
    });
  }

  dispose(): void {
    this.unlisten?.();
    this.handlers.clear();
  }

  send(command: BridgeCommand): void {
    void this.request(command).catch(() => undefined);
  }

  async request<T>(command: BridgeCommand, options: RequestOptions = {}): Promise<T> {
    const id = requestId();
    const timeoutMs = options.timeoutMs ?? 120_000;
    const { invoke } = await import('@tauri-apps/api/core');

    const timeoutPromise = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => {
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
      options.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        void invoke('bridge_cancel', { requestId: id }).catch(() => undefined);
        reject(new DOMException('Operation aborted', 'AbortError'));
      }, { once: true });
    });

    try {
      const response = await Promise.race([
        invoke<ResponseEnvelope>('bridge_request', {
          envelope: {
            requestId: id,
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
  async notify(title: string, body: string): Promise<boolean> {
    try {
      const notifications = await import('@tauri-apps/plugin-notification');
      let allowed = await notifications.isPermissionGranted();
      if (!allowed) allowed = (await notifications.requestPermission()) === 'granted';
      if (!allowed) return false;
      notifications.sendNotification({ title, body });
      return true;
    } catch { return false; }
  }
  async openInNewWindow(paths?: string[], position?: { x: number; y: number }): Promise<void> {
    await this.request({
      type: 'windowOpenNew',
      payload: {
        paths: paths ?? null,
        x: position?.x ?? null,
        y: position?.y ?? null,
        width: null,
        height: null,
      },
    });
  }
  async syncWindowTabs(workspacePaths: string[][]): Promise<void> {
    const win = (await import('@tauri-apps/api/window')).getCurrentWindow();
    await this.request({
      type: 'windowSyncTabs',
      payload: {
        window_label: win.label,
        workspace_paths: workspacePaths,
      },
    });
  }
  async focusWorkspaceAcrossWindows(paths: string[]): Promise<boolean> {
    const win = (await import('@tauri-apps/api/window')).getCurrentWindow();
    return this.request<boolean>({
      type: 'windowFocusWorkspace',
      payload: {
        current_window_label: win.label,
        paths,
      },
    });
  }
  async onFocusTab(handler: (paths: string[]) => void): Promise<() => void> {
    const { listen } = await import('@tauri-apps/api/event');
    return listen<string[]>('versiondock://focus-tab', ({ payload }) => {
      handler(payload);
    });
  }
}

export class MockBridge implements VersionDockBridge {
  private state: unknown;
  constructor(private readonly responder: (command: BridgeCommand) => unknown | Promise<unknown>) {}
  send(command: BridgeCommand): void { void this.responder(command); }
  async request<T>(command: BridgeCommand): Promise<T> { return this.responder(command) as Promise<T>; }
  subscribe(): () => void { return () => undefined; }
  getState<T>(): T | undefined { return this.state as T | undefined; }
  setState<T>(state: T): void { this.state = state; }
  platform(): 'macos' | 'windows' | 'linux' { return 'linux'; }
  async selectWorkspaceFolders(): Promise<string[]> { return []; }
  async notify(): Promise<boolean> { return false; }
  async openInNewWindow(): Promise<void> {
    return Promise.resolve();
  }
  async syncWindowTabs(): Promise<void> {
    return Promise.resolve();
  }
  async focusWorkspaceAcrossWindows(): Promise<boolean> {
    return Promise.resolve(false);
  }
  async onFocusTab(): Promise<() => void> {
    return Promise.resolve(() => undefined);
  }
  readonly window = {
    startDragging: async () => undefined, toggleMaximize: async () => undefined, minimize: async () => undefined, close: async () => undefined,
    isMaximized: async () => false, onDragDrop: async () => () => undefined,
  };
}
