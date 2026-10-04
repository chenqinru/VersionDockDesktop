import { afterEach, expect, it, vi } from 'vitest';
import type { BridgeCommand, PushProtectionTarget } from '../bindings/generated';
import { approveProtectedPush, needsProtectedPushApproval } from './pushProtection';
const confirm = vi.hoisted(() => vi.fn());
vi.mock('../components/dialogService', () => ({ confirmDialog: confirm, currentDialog: () => undefined, publishDialog: vi.fn() }));
const command: BridgeCommand = { type: 'sync', payload: { workspace_id: 'workspace', repo_id: 'repo', action: 'push', remote: null, branch: null, force: false } };
const target: PushProtectionTarget = { repoId: 'repo', repoName: 'Repository', branch: 'main', force: false, requiresConfirmation: true, proof: 'proof' };
afterEach(() => vi.clearAllMocks());
it('stops protected push when confirmation is cancelled', async () => {
  confirm.mockResolvedValue(false);
  await expect(approveProtectedPush(command, async <T>() => [target] as T, {})).rejects.toMatchObject({ name: 'AbortError' });
  expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ danger: false }));
});
it('carries native approvals and confirms protected force push as dangerous', async () => {
  confirm.mockResolvedValue(true);
  const force: BridgeCommand = { type: 'sync', payload: { ...command.payload, force: true } };
  const request = vi.fn(async () => [{ ...target, force: true }]);
  const approved = await approveProtectedPush(force, request as never, {});
  expect(approved[0].proof).toBe('proof'); expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ danger: true }));
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ type: 'pushProtectionCheck' }), expect.objectContaining({ showProgress: false }));
});
it('covers tags, batch commits and publish while leaving passive calls synchronous', () => {
  expect(needsProtectedPushApproval({ type: 'sync', payload: { ...command.payload, action: 'pushTags' } })).toBe(true);
  expect(needsProtectedPushApproval({ type: 'batchCommit', payload: { workspace_id: 'workspace', targets: [], push: true } })).toBe(true);
  expect(needsProtectedPushApproval({ type: 'bootstrap' })).toBe(false);
});
it('does not confirm unprotected branches and respects abort after confirmation', async () => {
  expect(await approveProtectedPush(command, async <T>() => [{ ...target, requiresConfirmation: false }] as T, {})).toHaveLength(1);
  expect(confirm).not.toHaveBeenCalled();
  const controller = new AbortController(); confirm.mockImplementation(async () => { controller.abort(); return true; });
  await expect(approveProtectedPush(command, async <T>() => [target] as T, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
});
