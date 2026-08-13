import type { BridgeCommand, DesktopError, ProgressEvent, ResponseEnvelope, WorkspaceEvent } from '../bindings/generated';
import { platform as osPlatform } from '@tauri-apps/plugin-os';

export interface RequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type BridgeEvent = ProgressEvent | WorkspaceEvent | { type: 'native-unavailable' };

export interface VersionDockBridge {
  send(command: BridgeCommand): void;
  request<T>(command: BridgeCommand, options?: RequestOptions): Promise<T>;
  subscribe(handler: (event: BridgeEvent) => void): () => void;
  getState<T>(): T | undefined;
  setState<T>(state: T): void;
  platform(): 'macos' | 'windows' | 'linux';
  selectWorkspaceFolders(title: string): Promise<string[]>;
  window: {
    startDragging(): Promise<void>;
    toggleMaximize(): Promise<void>;
    minimize(): Promise<void>;
    close(): Promise<void>;
    isMaximized(): Promise<boolean>;
    onDragDrop(handler: (paths: string[]) => void): Promise<() => void>;
  };
}

export class BridgeError extends Error implements DesktopError {
  code: string;
  command: string | null;
  exitCode: number | null;
  stderr: string | null;
  recoverable: boolean;

  constructor(error: DesktopError) {
    super(error.message);
    this.name = 'BridgeError';
    this.code = error.code;
    this.command = error.command;
    this.exitCode = error.exitCode;
    this.stderr = error.stderr;
    this.recoverable = error.recoverable;
  }
}

function requestId(): string {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
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
    this.unlisten = await listen<ProgressEvent | WorkspaceEvent>('versiondock://event', ({ payload }) => {
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
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let aborted = false;

    const cancel = async () => {
      aborted = true;
      try { await invoke('bridge_cancel', { requestId: id }); } catch { /* app may be closing */ }
    };
    const onAbort = () => { void cancel(); };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      if (options.signal?.aborted) throw new DOMException('Operation aborted', 'AbortError');
      const response = await Promise.race([
        invoke<ResponseEnvelope>('bridge_request', { envelope: { requestId: id, command } }),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            void cancel();
            reject(new BridgeError({ code: 'REQUEST_TIMEOUT', message: `Request timed out after ${timeoutMs}ms`, command: null, exitCode: null, stderr: null, recoverable: true }));
          }, timeoutMs);
        }),
      ]);
      if (response.error) throw new BridgeError(response.error);
      if (aborted) throw new DOMException('Operation aborted', 'AbortError');
      return response.result as T;
    } finally {
      if (timeout) clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }

  subscribe(handler: (event: BridgeEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  getState<T>(): T | undefined { return this.state as T | undefined; }
  setState<T>(state: T): void { this.state = state; }
  platform(): 'macos' | 'windows' | 'linux' { return this.currentPlatform; }
  async selectWorkspaceFolders(title: string): Promise<string[]> {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const value = await open({ directory: true, multiple: true, title });
    return !value ? [] : Array.isArray(value) ? value : [value];
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
  readonly window = {
    startDragging: async () => undefined, toggleMaximize: async () => undefined, minimize: async () => undefined, close: async () => undefined,
    isMaximized: async () => false, onDragDrop: async () => () => undefined,
  };
}
