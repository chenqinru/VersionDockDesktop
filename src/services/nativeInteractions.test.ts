import { afterEach, expect, it, vi } from 'vitest';
import { createNativeInteractionHandler } from './nativeInteractions';
import { currentDialog, publishDialog } from '../components/dialogService';
import type { InteractionEvent } from '../bindings/generated';
const event = (id: string, kind: 'svnAuthentication' | 'pushRecovery' = 'svnAuthentication'): InteractionEvent => ({ type:'nativeInteractionRequest', id, operationId:'op', kind, repoId:'repo', repoName:'Repo', detail:'svn://test/repo', remote:'secondary', branch:'main', preferMerge:true, context:{ generation:1, domain:'sync', workspaceId:'ws-test', repositoryId:'repo', target:null, visibility:'foreground' } });
afterEach(() => { currentDialog()?.resolve(null); publishDialog(undefined); });
it('masks passwords, preserves whitespace and answers the original operation', async () => {
  const respond = vi.fn(async () => true);
  const handler = createNativeInteractionHandler(respond, vi.fn(async () => []) as unknown as Parameters<typeof createNativeInteractionHandler>[1]);
  handler.handle(event('first'));
  await vi.waitFor(() => expect(currentDialog()?.inputLabel).toBe('Username'));
  currentDialog()!.resolve('alice'); publishDialog(undefined);
  await vi.waitFor(() => expect(currentDialog()?.inputType).toBe('password'));
  currentDialog()!.resolve('  secret  '); publishDialog(undefined);
  await vi.waitFor(() => expect(respond).toHaveBeenCalledWith('first', { choice:'authenticate', username:'alice', password:'  secret  ' }));
  handler.dispose();
});
it('closes an active authentication prompt when its native operation is cancelled', async () => {
  const respond = vi.fn(async () => true);
  const handler = createNativeInteractionHandler(respond, vi.fn(async () => []) as unknown as Parameters<typeof createNativeInteractionHandler>[1]);
  handler.handle(event('cancelled'));
  await vi.waitFor(() => expect(currentDialog()).toBeDefined());
  handler.handle({ type:'nativeInteractionClosed', id:'cancelled' });
  await vi.waitFor(() => expect(currentDialog()).toBeUndefined());
  expect(respond).not.toHaveBeenCalled(); handler.dispose();
});
it('uses merge preference and preserves the selected remote for force-push approval', async () => {
  const respond = vi.fn(async () => true);
  const request = vi.fn(async () => []);
  const handler = createNativeInteractionHandler(respond, request as unknown as Parameters<typeof createNativeInteractionHandler>[1]);
  handler.handle(event('push', 'pushRecovery'));
  await vi.waitFor(() => expect(currentDialog()?.choices?.[0].id).toBe('merge'));
  currentDialog()!.resolve('force'); publishDialog(undefined);
  await vi.waitFor(() => expect(respond).toHaveBeenCalledWith('push', { choice:'force', pushApprovals:[] }));
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ type:'pushProtectionCheck', payload:expect.objectContaining({ repo_ids:['repo'], branch:'main', force:true }) }), expect.anything());
  handler.dispose();
});
it('does not overwrite another dialog and skips a cancelled queued prompt', async () => {
  const respond = vi.fn(async () => true);
  const handler = createNativeInteractionHandler(respond, vi.fn(async () => []) as unknown as Parameters<typeof createNativeInteractionHandler>[1]);
  const existing = { kind:'confirm' as const, title:'Existing', message:'', resolve:vi.fn() };
  publishDialog(existing); handler.handle(event('queued'));
  await Promise.resolve();
  expect(currentDialog()).toBe(existing);
  handler.handle({ type:'nativeInteractionClosed', id:'queued' }); publishDialog(undefined);
  await Promise.resolve(); expect(respond).not.toHaveBeenCalled(); expect(currentDialog()).toBeUndefined(); handler.dispose();
});
