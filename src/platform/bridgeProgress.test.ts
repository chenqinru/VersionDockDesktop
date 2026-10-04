import { currentDialog, publishDialog } from '../components/dialogService';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeCommand, OperationEvent, ResponseEnvelope } from '../bindings/generated';
import type { BridgeEvent } from './bridge';
import { MockBridge, TauriBridge } from './bridge';

const { invoke, listen } = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen }));
vi.mock('@tauri-apps/plugin-os', () => ({ platform: () => 'macos' }));
const command = { type: 'sync' as const, payload: { workspace_id: 'workspace', repo_id: 'repo', action: 'pullRebase' as const, remote: null, branch: null } };
let emit: (event: { payload: BridgeEvent }) => void;

beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  listen.mockImplementation(async (_name, handler) => { emit = handler; return () => undefined; });
});
afterEach(() => vi.useRealTimers());
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

describe('native progress bridge contract', () => {
  it('registers the child ID before invoking and only emits one completion after native response', async () => {
    let resolve!: (value: ResponseEnvelope) => void;
    invoke.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const bridge = new TauriBridge(); await bridge.initialize();
    const events: BridgeEvent[] = []; bridge.subscribe((event) => events.push(event));
    let id = '';
    const pending = bridge.request(command, { onOperationId: (value) => { id = value; expect(invoke).not.toHaveBeenCalled(); } });
    await vi.waitFor(() => expect(id).not.toBe('')); expect(events[0]).toMatchObject({ type: 'operation-request', requestId: id });
    expect(invoke.mock.calls[0][1].envelope.requestId).toBe(id);
    resolve({ requestId: id, result: { output: '', update: null }, error: null }); await pending; await tick();
    expect(events.filter((event) => 'progressEvent' in event && event.type === 'operation-settled')).toHaveLength(1);
    bridge.dispose();
  });

  it('keeps mock callback order and context overrides consistent with native requests', async () => {
    let id = ''; const events: BridgeEvent[] = [];
    const bridge = new MockBridge(() => { expect(id).not.toBe(''); expect(events[0]).toMatchObject({ context: { workspaceId: 'other', generation: 7 } }); return []; });
    bridge.subscribe((event) => events.push(event));
    await bridge.request(command, { onOperationId: (value) => { id = value; expect(events).toHaveLength(0); }, context: { workspaceId: 'other', generation: 7 } });
    expect(events[1]).toMatchObject({ type: 'operation-settled', result: [] });
  });
  it('does not report native completion early when a frontend timeout requests cancellation', async () => {
    let resolve!: (value: ResponseEnvelope) => void;
    invoke.mockImplementation((name) => name === 'bridge_cancel' ? Promise.resolve(true) : new Promise((done) => { resolve = done; }));
    const bridge = new TauriBridge(); await bridge.initialize(); const events: BridgeEvent[] = []; bridge.subscribe((event) => events.push(event));
    let id = '';
    const pending = bridge.request(command, { timeoutMs: 100, onOperationId: (value) => { id = value; } });
    const failure = expect(pending).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });
    await vi.waitFor(() => expect(id).not.toBe('')); await vi.advanceTimersByTimeAsync(100); await failure;
    expect(invoke).toHaveBeenCalledWith('bridge_cancel', { requestId: id });
    expect(events.some((event) => 'progressEvent' in event && event.type === 'operation-settled')).toBe(false);
    resolve({ requestId: id, result: null, error: { code: 'REQUEST_CANCELLED', message: 'Operation cancelled', command: null, exitCode: null, stderr: null, recoverable: true } }); await tick();
    expect(events.filter((event) => 'progressEvent' in event && event.type === 'operation-settled')).toHaveLength(1); bridge.dispose();
  });

  it('forwards silent group children for task tracking without enabling unrelated background progress', async () => {
    invoke.mockImplementation(() => new Promise(() => undefined));
    const bridge = new TauriBridge(); await bridge.initialize(); const events: BridgeEvent[] = []; bridge.subscribe((event) => events.push(event));
    let id = ''; void bridge.request(command, { showProgress: false, onOperationId: (value) => { id = value; } }); await vi.waitFor(() => expect(id).not.toBe(''));
    const operation: OperationEvent = { operationId: id, context: { domain: 'sync', generation: 1, visibility: 'background', workspaceId: 'workspace', repositoryId: 'repo', target: null }, status: 'running', phase: 'pulling', message: 'Pulling repository changes', startedAt: '', cancellable: true, completed: null, total: null, error: null };
    emit({ payload: operation }); emit({ payload: { ...operation, operationId: 'untracked' } });
    expect(events.filter((event) => 'operationId' in event)).toEqual([operation]); bridge.dispose();
  });
});

it('cancels a protected push confirmation before starting the native push', async () => {
  invoke.mockImplementation((_name, args) => Promise.resolve({ requestId: args.envelope.requestId, result: [{ repoId: 'repo', repoName: 'Repository', branch: 'main', force: false, requiresConfirmation: true, proof: 'proof' }], error: null }));
  const bridge = new TauriBridge(); await bridge.initialize(); const controller = new AbortController();
  const push: BridgeCommand = { type: 'sync', payload: { workspace_id: 'workspace', repo_id: 'repo', action: 'push', branch: null, remote: null, force: false } };
  const pending = bridge.request(push, { signal: controller.signal }); const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(currentDialog()).toBeDefined()); controller.abort(); await rejected;
  expect(currentDialog()).toBeUndefined(); expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke.mock.calls[0][1].envelope.command.type).toBe('pushProtectionCheck');
  bridge.dispose(); publishDialog(undefined);
});

it('pauses silent queries queued behind shared SVN authentication and resumes their remaining timeout', async () => {
  let resolve!: (value: ResponseEnvelope) => void;
  invoke.mockImplementation((name) => name === 'bridge_cancel' ? Promise.resolve(true) : new Promise((done) => { resolve = done; }));
  const bridge = new TauriBridge(); await bridge.initialize();
  let id = '';
  const pending = bridge.request(command, { showProgress: false, timeoutMs: 200, onOperationId: (value) => { id = value; } });
  await vi.waitFor(() => expect(id).not.toBe(''));
  const event: OperationEvent = { operationId: id, context: { domain: 'sync', generation: 1, visibility: 'background', workspaceId: 'workspace', repositoryId: 'repo', target: null }, status: 'running', phase: 'awaitingAuthentication', message: 'Waiting for SVN authentication', startedAt: '', cancellable: true, completed: null, total: null, error: null };
  emit({ payload: event });
  await vi.advanceTimersByTimeAsync(2000);
  expect(invoke).not.toHaveBeenCalledWith('bridge_cancel', expect.anything());
  emit({ payload: { ...event, phase: 'retryingAuthentication' } });
  await vi.advanceTimersByTimeAsync(50);
  resolve({ requestId: id, result: true, error: null });
  await expect(pending).resolves.toBe(true); bridge.dispose();
});
