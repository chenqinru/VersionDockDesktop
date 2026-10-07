import type { RepositoryStatus, TagOperation } from '../bindings/generated';
import type { VersionDockBridge } from '../platform/bridge';
import { choiceDialog, confirmDialog, multiChoiceDialog, promptDialog } from '../components/dialogService';

export type TagOutcome = 'success' | 'cancelled' | 'noop' | 'failed' | 'partial';
export interface TagWorkflowRequest {
  action: 'create' | 'push' | 'delete' | 'checkout' | 'merge';
  repoId?: string;
  repoIds?: string[];
  preferredRepoId?: string;
  tagName?: string;
  hash?: string;
  remote?: string;
}
export interface TagTargetResult {
  repoId: string;
  remote?: string;
  outcome: TagOutcome;
  local?: 'success' | 'failed';
  remoteResult?: 'success' | 'failed';
  error?: string;
}
export interface TagWorkflowResult { outcome: TagOutcome; targets: TagTargetResult[] }
export interface TagWorkflowContext {
  bridge: VersionDockBridge;
  workspaceId: string;
  repositories: RepositoryStatus[];
  t: (key: string, ...args: Array<string | number>) => string;
  isAvailable: (repo: RepositoryStatus) => boolean;
  manageRemotes: (repoId: string) => void;
  created: (repoId: string, name: string) => void;
  notify: (outcome: TagOutcome, detail: string) => void;
  refresh: (repoIds: string[]) => Promise<void>;
}
const errorText = (error: unknown) => error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error);

/** The store owns the busy guard. Finish all prompts and preflight before the first write. */
export async function runGitTagWorkflow(request: TagWorkflowRequest, ctx: TagWorkflowContext): Promise<TagWorkflowResult> {
  const { t } = ctx;
  const explainError = (error: unknown) => {
    const message = errorText(error);
    const match = /^(Invalid Git (?:tag name|ref): |Tag "|Remote not found: |Local tag not found: )(.+?)(" already exists\.)?$/.exec(message);
    if (match?.[1] === 'Tag "') return t('Tag "{0}" already exists.', match[2]);
    if (match?.[1] === 'Local tag not found: ') return t('Local tag not found: {0}', match[2]);
    if (match?.[1] === 'Remote not found: ') return t('Remote not found: {0}', match[2]);
    if (match) return t('Invalid Git tag name: {0}', match[2]);
    return t(message);
  };
  const cancelled = (): TagWorkflowResult => ({ outcome: 'cancelled', targets: [] });
  const touched = new Set<string>();
  const results: TagTargetResult[] = [];
  let targets: RepositoryStatus[] = [];
  const payload = (repoId: string, operation: TagOperation) => ({ workspace_id: ctx.workspaceId, repo_id: repoId, operation });
  const resolveCommit = (repoId: string, revision: string) => ctx.bridge.request<string>({ type: 'tagResolveCommit', payload: { workspace_id: ctx.workspaceId, repo_id: repoId, revision } }, { showProgress: false });
  const preflight = (repoId: string, operation: TagOperation) => ctx.bridge.request<string>({ type: 'tagPreflight', payload: payload(repoId, operation) }, { showProgress: false });
  try {
    targets = ctx.repositories.filter(({ meta }) => meta.kind === 'git' && (request.repoId ? meta.id === request.repoId : !request.repoIds || request.repoIds.includes(meta.id)));
    if (!['create', 'push', 'delete', 'checkout', 'merge'].includes(request.action)) throw new Error(t('Unsupported tag operation: {0}', request.action));
    if (!targets.length) throw new Error(t('No Git repositories available.'));
    if (!request.repoId && targets.length > 1) {
      const choices = targets.map(({ meta }) => ({ id: meta.id, label: meta.name, description: meta.rootPath, icon: 'repo' }));
      if (request.action === 'create') {
        choices.sort((a, b) => Number(b.id === request.preferredRepoId) - Number(a.id === request.preferredRepoId));
        const id = await choiceDialog({ title: t('Select repository for tag operation'), message: '', choices });
        if (!id) return cancelled();
        targets = targets.filter(({ meta }) => meta.id === id);
      } else {
        const ids = await multiChoiceDialog({ title: t('Select repositories for tag operation'), message: request.tagName ?? '', choices, initialSelected: request.preferredRepoId ? [request.preferredRepoId] : [] });
        if (!ids?.length) return cancelled();
        targets = targets.filter(({ meta }) => ids.includes(meta.id));
      }
    }
    if (!targets.length) return cancelled();
    let name = request.tagName;
    let revision = request.hash;
    let message: string | null = null;
    if (request.action === 'create') {
      if (!revision) {
        try { await resolveCommit(targets[0].meta.id, 'HEAD'); }
        catch { throw new Error(t('Create a commit before creating a tag.')); }
        revision = (await promptDialog({ title: t('Commit for tag in {0}', targets[0].meta.name), message: t('Commit reference (leave empty for HEAD)'), initialValue: 'HEAD', allowEmpty: true, validateInput: async value => {
          try { await resolveCommit(targets[0].meta.id, value.trim() || 'HEAD'); return undefined; }
          catch { return t('Commit reference cannot be resolved to a commit.'); }
        } })) ?? undefined;
        if (revision === undefined) return cancelled();
        revision = revision.trim() || 'HEAD';
      }
      revision = await resolveCommit(targets[0].meta.id, revision);
      name = (await promptDialog({ title: t('New Tag in {0}', targets[0].meta.name), message: revision, inputLabel: t('Tag name'), validateInput: async value => {
        try { await preflight(targets[0].meta.id, { type: 'create', name: value.trim(), revision: revision ?? 'HEAD', message: null }); return undefined; }
        catch (error) { return explainError(error); }
      } }))?.trim();
      if (!name) return cancelled();
      revision = await preflight(targets[0].meta.id, { type: 'create', name, revision: revision ?? 'HEAD', message: null });
      message = await promptDialog({ title: t('Tag description'), message: t('Leave empty for a lightweight tag; enter a message for an annotated tag.'), allowEmpty: true });
      if (message === null) return cancelled();
    }
    if (!name) throw new Error(t('Invalid Git tag name: {0}', ''));
    let deletion: string | null = 'local';
    if (request.action === 'delete') {
      deletion = await choiceDialog({ title: t('Delete tag "{0}"', name), message: '', danger: true, choices: [
        { id: 'local', label: t('Delete Local'), danger: true },
        { id: 'remote', label: t('Delete on Remote'), danger: true },
        { id: 'both', label: t('Delete Local and Remote'), danger: true },
      ] });
      if (!deletion) return cancelled();
    }
    const plans: Array<{ repo: RepositoryStatus; operations: TagOperation[]; remote?: string; error?: string }> = [];
    for (const repo of targets) {
      const plan: typeof plans[number] = { repo, operations: [] };
      plans.push(plan);
      try {
        if (!ctx.isAvailable(repo)) throw new Error(t('Repository no longer available: {0}', repo.meta.name));
        if (request.action === 'push' || (request.action === 'delete' && deletion !== 'local')) {
          const remotes = await ctx.bridge.request<Array<{ name: string }>>({ type: 'remotes', payload: { workspace_id: ctx.workspaceId, repo_id: repo.meta.id } }, { showProgress: false });
          if (!remotes.length) {
            if (await confirmDialog({ title: t('No remotes configured.'), message: repo.meta.name, confirmLabel: t('Manage Remotes…') })) ctx.manageRemotes(repo.meta.id);
            throw new Error(t('No remotes configured.'));
          }
          if (request.remote && !remotes.some(remote => remote.name === request.remote)) throw new Error(t('Remote not found: {0}', request.remote));
          const remote = request.remote ?? (remotes.length === 1 ? remotes[0].name : await choiceDialog({ title: t('Select remote for {0}', repo.meta.name), message: name, choices: remotes.map(({ name }) => ({ id: name, label: name })) }));
          if (!remote) return cancelled();
          plan.remote = remote;
        }
        if (request.action === 'create') plan.operations.push({ type: 'create', name, revision: revision ?? 'HEAD', message: message?.trim() ? message : null });
        else if (request.action === 'delete') {
          if (deletion !== 'local') plan.operations.push({ type: 'delete', name, remote: plan.remote! });
          if (deletion !== 'remote') plan.operations.push({ type: 'delete', name, remote: null });
        } else if (request.action === 'push') plan.operations.push({ type: 'push', name, remote: plan.remote! });
        else plan.operations.push({ type: request.action, name });
        for (const operation of plan.operations) {
          const commit = await preflight(repo.meta.id, operation);
          if (operation.type === 'create') operation.revision = commit;
        }
      } catch (error) { plan.error = explainError(error); }
    }
    const preview = plans.map(({ repo, remote, error }) => `${repo.meta.name}${remote ? ` → ${remote}` : ''}${error ? `: ${error}` : ''}`).join('\n');
    if (plans.some(plan => plan.error)) {
      ctx.notify('failed', t('Tag operation cannot start. Adjust the targets and retry.\n{0}', preview));
      return { outcome: 'failed', targets: plans.map(({ repo, remote, error }) => ({ repoId: repo.meta.id, remote, outcome: error ? 'failed' : 'noop', error })) };
    }
    if (['checkout', 'merge', 'delete'].includes(request.action)) {
      const detail = request.action === 'checkout' ? t('Checkout enters detached HEAD.') : request.action === 'merge'
        ? targets.map(repo => `${repo.meta.name}: ${repo.branch}`).join('\n')
        : t(deletion === 'both' ? 'Delete Local and Remote' : deletion === 'remote' ? 'Delete on Remote' : 'Delete Local');
      if (!await confirmDialog({ title: t('Confirm tag operation: {0}', name), message: `${preview}\n${detail}`, danger: request.action === 'delete' })) return cancelled();
    }
    for (const plan of plans) {
      const result: TagTargetResult = { repoId: plan.repo.meta.id, remote: plan.remote, outcome: 'success' };
      results.push(result);
      try {
        if (!ctx.isAvailable(plan.repo)) throw new Error(t('Repository no longer available: {0}', plan.repo.meta.name));
        for (const operation of plan.operations) {
          touched.add(plan.repo.meta.id);
          try {
            await ctx.bridge.request({ type: 'tagOperation', payload: payload(plan.repo.meta.id, operation) });
            if (operation.type === 'delete' || operation.type === 'create' || operation.type === 'push') {
              if (operation.type === 'push' || (operation.type === 'delete' && operation.remote)) result.remoteResult = 'success';
              else result.local = 'success';
            }
          } catch (error) {
            if (operation.type === 'delete') {
              if (operation.remote) result.remoteResult = 'failed'; else result.local = 'failed';
            }
            throw error;
          }
        }
      } catch (error) {
        result.error = explainError(error);
        result.outcome = result.local === 'success' || result.remoteResult === 'success' ? 'partial' : 'failed';
      }
    }
    const outcome: TagOutcome = results.every(result => result.outcome === 'success') ? 'success'
      : results.some(result => result.outcome === 'success' || result.outcome === 'partial') ? 'partial' : 'failed';
    if (request.action === 'create' && outcome === 'success') ctx.created(targets[0].meta.id, name);
    else ctx.notify(outcome, results.map(result => `${targets.find(repo => repo.meta.id === result.repoId)?.meta.name ?? result.repoId}${result.remote ? ` → ${result.remote}` : ''}: ${t(result.outcome)}${result.remoteResult ? `; ${t('Remote')}: ${t(result.remoteResult)}` : ''}${result.local ? `; ${t('Local')}: ${t(result.local)}` : ''}${result.error ? `; ${result.error}` : ''}`).join('\n'));
    return { outcome, targets: results };
  } catch (error) {
    const detail = explainError(error);
    ctx.notify('failed', detail);
    return { outcome: 'failed', targets: targets.map(repo => ({ repoId: repo.meta.id, outcome: 'failed', error: detail })) };
  } finally {
    if (touched.size) {
      try { await ctx.refresh([...touched]); }
      catch (error) { ctx.notify('failed', t('Failed to refresh tags: {0}', errorText(error))); }
    }
  }
}
