import type { BridgeCommand, InteractionEvent, PushProtectionTarget } from '../bindings/generated';
import type { RequestOptions } from '../platform/bridge';
import { choiceDialog, currentDialog, dialogListeners, promptDialog, publishDialog } from '../components/dialogService';
import { approveProtectedPush } from './pushProtection';
import { t } from '../ai/i18n';

type RequestEvent = Extract<InteractionEvent, { type: 'nativeInteractionRequest' }>;
type Response = { choice: string; username?: string; password?: string; pushApprovals?: PushProtectionTarget[] };
type Request = <T>(command: BridgeCommand, options?: RequestOptions) => Promise<T>;

export function createNativeInteractionHandler(respond: (id: string, response: Response) => Promise<unknown>, request: Request) {
  let queue = Promise.resolve();
  const pending = new Map<string, AbortController>();
  function close(id: string) { pending.get(id)?.abort(); pending.delete(id); }
  function idle(signal: AbortSignal): Promise<void> {
    if (!currentDialog() || signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => { dialogListeners.delete(check); signal.removeEventListener('abort', finish); resolve(); };
      const check = () => { if (!currentDialog()) finish(); };
      dialogListeners.add(check); signal.addEventListener('abort', finish, { once: true });
    });
  }
  async function show(event: RequestEvent, controller: AbortController): Promise<Response> {
    const { signal } = controller;
    await idle(signal);
    if (signal.aborted) return { choice: 'cancel' };
    let owned = currentDialog();
    const cancel = () => { if (owned && currentDialog() === owned) { owned.resolve(null); publishDialog(undefined); } };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      if (event.kind === 'svnAuthentication') {
        const usernamePrompt = promptDialog({ title: t('SVN Authentication Required: {0}', event.repoName), message: event.detail, inputLabel: t('Username') });
        owned = currentDialog();
        const username = await usernamePrompt;
        if (username === null || signal.aborted) return { choice: 'cancel' };
        const passwordPrompt = promptDialog({ title: t('SVN Authentication Required: {0}', event.repoName), message: event.detail, inputLabel: t('Password'), inputType: 'password', allowEmpty: true });
        owned = currentDialog();
        const password = await passwordPrompt;
        return password === null || signal.aborted ? { choice: 'cancel' } : { choice: 'authenticate', username, password };
      }
      const choicePrompt = choiceDialog({ title: t('Push rejected'), message: t('The remote contains commits you do not have locally. Choose how to continue.'), choices: [
        { id: event.preferMerge ? 'merge' : 'rebase', label: t(event.preferMerge ? 'Merge & Push' : 'Rebase & Push'), icon: 'git-merge' },
        { id: 'force', label: t('Force Push'), icon: 'cloud-upload', danger: true },
      ] });
      owned = currentDialog();
      const choice = await choicePrompt;
      if (!choice || signal.aborted) return { choice: 'cancel' };
      if (choice !== 'force') return { choice };
      const pushApprovals = await approveProtectedPush({ type: 'sync', payload: { workspace_id: event.context.workspaceId!, repo_id: event.repoId, action: 'push', remote: event.remote, branch: event.branch, force: true } }, request, { signal });
      return { choice, pushApprovals };
    } finally { signal.removeEventListener('abort', cancel); }
  }
  return {
    handle(event: InteractionEvent) {
      if (event.type === 'nativeInteractionClosed') { close(event.id); return; }
      const controller = new AbortController(); pending.set(event.id, controller);
      queue = queue.then(async () => {
        try { const response = await show(event, controller); if (!controller.signal.aborted) await respond(event.id, response); }
        catch { if (!controller.signal.aborted) await respond(event.id, { choice: 'cancel' }).catch(() => undefined); }
        finally { pending.delete(event.id); }
      });
    },
    dispose() { for (const id of pending.keys()) { void respond(id, { choice: 'cancel' }).catch(() => undefined); close(id); } },
  };
}
