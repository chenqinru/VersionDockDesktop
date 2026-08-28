import type {
  BridgeCommand, DesktopError, ProgressEvent, RepositoryEvent, ResponseEnvelope,
  WindowTabImport, WindowTabTransfer, WindowTabTransferCompleted, WorkspaceEvent,
} from '../bindings/generated';
import { platform as osPlatform } from '@tauri-apps/plugin-os';

export interface RequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
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
  window: {
    startDragging(): Promise<void>;
    toggleMaximize(): Promise<void>;
    minimize(): Promise<void>;
    close(): Promise<void>;
    isMaximized(): Promise<boolean>;
    dragGeometry(): Promise<WindowDragGeometry | null>;
    onDragDrop(handler: (paths: string[]) => void): Promise<() => void>;
  };
}

export interface TabDragPayload {
  sourceWindowLabel: string;
  tabId: string;
  tabName: string;
  paths: string[];
  screenX: number;
  screenY: number;
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
  const entropy = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `req-${entropy}-${requestSequence}`;
}

export class TauriBridge implements VersionDockBridge {
  private state: unknown;
  private handlers = new Set<(event: BridgeEvent) => void>();
  private unlisten?: () => void;
  private windowSyncQueue: Promise<void> = Promise.resolve();
  private currentPlatform: 'macos' | 'windows' | 'linux' = (() => { const value = osPlatform(); return value === 'macos' || value === 'windows' ? value : 'linux'; })();

  readonly window = {
    startDragging: async () => (await import('@tauri-apps/api/window')).getCurrentWindow().startDragging(),
    toggleMaximize: async () => (await import('@tauri-apps/api/window')).getCurrentWindow().toggleMaximize(),
    minimize: async () => (await import('@tauri-apps/api/window')).getCurrentWindow().minimize(),
    close: async () => (await import('@tauri-apps/api/window')).getCurrentWindow().close(),
    isMaximized: async () => (await import('@tauri-apps/api/window')).getCurrentWindow().isMaximized(),
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
    });
  }
  async syncWindowTabs(workspacePaths: string[][], activeWorkspaceId: string | null): Promise<void> {
    this.windowSyncQueue = this.windowSyncQueue.catch(() => undefined).then(async () => {
      await this.request({
        type: 'windowSyncTabs',
        payload: {
          workspace_paths: workspacePaths,
          active_workspace_id: activeWorkspaceId,
        },
      });
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
    });
  }
  async focusWorkspaceAcrossWindows(paths: string[]): Promise<boolean> {
    return this.request<boolean>({
      type: 'windowFocusWorkspace',
      payload: {
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
  async windowTabDrop(transfer: WindowTabTransfer, point: { screenX: number; screenY: number }): Promise<boolean> {
    return this.request<boolean>({
      type: 'windowTabDrop',
      payload: {
        transfer,
        screen_x: point.screenX,
        screen_y: point.screenY,
      },
    });
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
    });
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
  readonly window = {
    startDragging: async () => undefined, toggleMaximize: async () => undefined, minimize: async () => undefined, close: async () => undefined,
    isMaximized: async () => false, dragGeometry: async () => null, onDragDrop: async () => () => undefined,
  };
}
