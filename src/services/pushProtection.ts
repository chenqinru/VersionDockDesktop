import type { BridgeCommand, PushProtectionTarget } from '../bindings/generated';
import type { RequestOptions } from '../platform/bridge';
import { confirmDialog, currentDialog, publishDialog } from '../components/dialogService';
import { t } from '../ai/i18n';

export function needsProtectedPushApproval(command: BridgeCommand): boolean {
  return (command.type === 'sync' && (command.payload.action === 'push' || command.payload.action === 'pushTags'))
    || (command.type === 'batchCommit' && command.payload.push)
    || (command.type === 'publishRepository' && command.payload.push);
}

/** All native push paths share preflight, including batch commit, retry and publishing. */
export async function approveProtectedPush(
  command: BridgeCommand,
  request: <T>(command: BridgeCommand, options?: RequestOptions) => Promise<T>,
  options: RequestOptions,
): Promise<PushProtectionTarget[]> {
  let workspaceId: string | undefined;
  let repoIds: string[] = [];
  let branch: string | null = null;
  let force = false;
  if (command.type === 'sync' && (command.payload.action === 'push' || command.payload.action === 'pushTags')) {
    workspaceId = command.payload.workspace_id; repoIds = [command.payload.repo_id];
    branch = command.payload.branch; force = Boolean(command.payload.force);
  } else if (command.type === 'batchCommit' && command.payload.push) {
    workspaceId = command.payload.workspace_id; repoIds = command.payload.targets.map(target => target.repoId);
  } else if (command.type === 'publishRepository' && command.payload.push) {
    workspaceId = command.payload.workspace_id; repoIds = [command.payload.repo_id];
  }
  if (!workspaceId || !repoIds.length) return [];
  const targets = await request<PushProtectionTarget[]>({ type: 'pushProtectionCheck', payload: {
    workspace_id: workspaceId, repo_ids: [...new Set(repoIds)], branch, force,
  } }, { signal: options.signal, showProgress: false });
  // Mock responders that do not model native protection leave their existing behavior intact.
  if (!Array.isArray(targets)) return [];
  for (const target of targets) {
    if (!target.requiresConfirmation) continue;
    if (options.signal?.aborted) throw new DOMException('Operation cancelled', 'AbortError');
    const confirmation = confirmDialog({
      title: t(force ? 'Force Push Protected Branch' : 'Push Protected Branch'),
      message: t(force ? 'Force pushing "{0}" in {1} can overwrite remote history. Continue?' : 'Push to protected branch "{0}" in {1}?', target.branch, target.repoName),
      confirmLabel: t(force ? 'Force Push Anyway' : 'Push'), danger: force,
    });
    const dialog = currentDialog();
    const cancelConfirmation = () => {
      if (dialog && currentDialog() === dialog) { dialog.resolve(false); publishDialog(undefined); }
    };
    options.signal?.addEventListener('abort', cancelConfirmation, { once: true });
    if (options.signal?.aborted) cancelConfirmation();
    let accepted: boolean;
    try { accepted = await confirmation; }
    finally { options.signal?.removeEventListener('abort', cancelConfirmation); }
    if (!accepted || options.signal?.aborted) throw new DOMException('Operation cancelled', 'AbortError');
  }
  return targets;
}
