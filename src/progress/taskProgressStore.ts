import { create } from 'zustand';
import type { OperationEvent, OperationStatus, RepositoryOperationResult } from '../bindings/generated';
import type { OperationRequestEvent, OperationSettledEvent } from '../platform/bridge';

export type TaskStatus = OperationStatus | 'cancelling' | 'skipped';
export interface TaskChild {
  repoId: string;
  repoName: string;
  status: TaskStatus;
  message: string;
  error?: string;
}
export interface ProgressTask {
  id: string;
  title: string;
  workspaceId: string | null;
  workspaceName: string;
  repoName?: string;
  status: TaskStatus;
  message: string;
  startedAt: number;
  finishedAt?: number;
  detailsDismissed?: boolean;
  completed: number | null;
  total: number | null;
  cancellable: boolean;
  immediate?: boolean;
  error?: string;
  cancelError?: string;
  children: TaskChild[];
}
export interface TaskMetadata { workspaceName: string; repoName?: string; repositories?: Array<{ id: string; name: string }> }
interface Binding { groupId: string; repoId: string }
interface RequestRecord { command: string; groupId?: string; nativeSeen: boolean; terminalSeen: boolean; cancelPending: boolean; cancelSent: boolean; latestStatus: TaskStatus }
interface GroupRecord { stopped: boolean; pending: Set<string>; outcomes: Map<string, { status: TaskStatus; error?: string }>; finishRequested: boolean }

export const isTaskActive = (task: Pick<ProgressTask, 'status'>) => ['queued', 'running', 'cancelling'].includes(task.status);
const isTerminal = (status: TaskStatus) => !['queued', 'running', 'cancelling'].includes(status);
const errorText = (error: unknown) => typeof error === 'object' && error && 'message' in error ? String(error.message) : String(error ?? '');
const errorStatus = (error: unknown): TaskStatus => {
  const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : '';
  const text = errorText(error);
  return /CANCELLED|AbortError/i.test(`${code} ${text}`) ? 'cancelled' : /TIMEOUT|timed out/i.test(`${code} ${text}`) ? 'timedOut' : 'failed';
};

const taskTitles: Record<string, string> = {
  workspaceOpen: 'Open Project', initializeRepository: 'Initialize Repository', cloneRepository: 'Clone Repository', checkoutSvnRepository: 'Checkout SVN Repository',
  stage: 'Stage changes', unstage: 'Unstage changes', discard: 'Discard Changes', deletePaths: 'Delete Files', addIgnore: 'Ignore files', updateIgnoreRules: 'Update ignore rules',
  commit: 'Commit', batchCommit: 'Batch Commit', branchOperation: 'Branch operation', branchRecovery: 'Branch operation', gitUnlockIndex: 'Unlock', tagOperation: 'Tag operation',
  conflictSave: 'Resolve Conflicts', conflictAccept: 'Resolve Conflicts', restoreConflicts: 'Resolve Conflicts', abortRepositoryOperation: 'Abort', continueRepositoryOperation: 'Continue',
  stashOperation: 'Stash', shelfOperation: 'Shelf', changelistOperation: 'Changelist', worktreeOperation: 'Worktree', subtreeOperation: 'Subtree', submoduleOperation: 'Submodule',
  unpushedOperation: 'Outgoing commits', historyOperation: 'Commit operation', svnOperation: 'SVN operation', remoteOperation: 'Remote operation', gitProfileOperation: 'Git identity', svnAccountOperation: 'SVN account', publishRepository: 'Publish Repository',
};
export function taskTitle(event: OperationRequestEvent): string {
  if (event.command.type === 'branchOperation') return ({ create: 'Create Branch', checkout: 'Checkout', merge: 'Merge', rebase: 'Rebase', rename: 'Rename', delete: 'Delete' })[event.command.payload.operation.type];
  if (event.command.type === 'historyOperation') return ({ checkout: 'Checkout', cherryPick: 'Cherry-pick', revert: 'Revert', reset: 'Reset', checkoutFile: 'Checkout', revertFile: 'Revert', applyPaths: 'Apply', revertPaths: 'Revert', svnUpdateTo: 'Update' })[event.command.payload.operation.type];
  if (event.command.type === 'batchCommit' && event.command.payload.push) return 'Commit and push';
  if (event.command.type === 'sync') return ({ fetch: 'Fetch', pull: 'Pull', pullRebase: 'Pull (Rebase)', pullFfOnly: 'Pull', push: 'Push', pushTags: 'Push Tags', update: 'Update Project' })[event.command.payload.action];
  return taskTitles[event.command.type] ?? 'Repository operation';
}
export const tracksTaskCommand = (type: string) => type === 'sync' || type in taskTitles;

interface TaskProgressState {
  tasks: Record<string, ProgressTask>;
  open: boolean;
  setOpen: (open: boolean) => void;
  trackForegroundRequest: (id: string, immediate?: boolean) => void;
  requested: (event: OperationRequestEvent, metadata: TaskMetadata) => void;
  operation: (event: OperationEvent) => void;
  settled: (event: OperationSettledEvent) => void;
  beginGroup: (title: string, workspaceId: string, workspaceName: string, repos: Array<{ id: string; name: string }>) => string;
  bindChild: (groupId: string, repoId: string, operationId: string) => void;
  completeChild: (groupId: string, repoId: string, status: TaskStatus, error?: string) => void;
  finishGroup: (groupId: string) => void;
  isStopped: (groupId: string) => boolean;
  cancel: (id: string) => Promise<void>;
}
const requests = new Map<string, RequestRecord>();
const foregroundRequests = new Map<string, boolean>();
const bindings = new Map<string, Binding>();
const groups = new Map<string, GroupRecord>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
let cancelNative: (id: string) => Promise<boolean> = async () => false;

export function taskStatusKey(status: TaskStatus): string {
  return ({ queued: 'Queued', running: 'Running', cancelling: 'Cancelling…', succeeded: 'Completed', partial: 'Partially completed', failed: 'Failed', cancelled: 'Cancelled', timedOut: 'Timed out', skipped: 'Not started' })[status];
}

function schedulePrune(id: string) {
  const previous = timers.get(id); if (previous) clearTimeout(previous);
  timers.set(id, setTimeout(() => {
    timers.delete(id);
    const state = useTaskProgressStore.getState();
    if (state.open || !state.tasks[id] || isTaskActive(state.tasks[id])) return;
    useTaskProgressStore.setState({ tasks: Object.fromEntries(Object.entries(state.tasks).filter(([key]) => key !== id)) });
    groups.delete(id);
  }, Math.max(0, (useTaskProgressStore.getState().tasks[id]?.finishedAt ?? Date.now()) + 2000 - Date.now())));
}

export const useTaskProgressStore = create<TaskProgressState>((set, get) => {
  const patch = (id: string, values: Partial<ProgressTask>) => set((state) => state.tasks[id] ? { tasks: { ...state.tasks, [id]: { ...state.tasks[id], ...values } } } : {});
  const terminal = (id: string, status: TaskStatus, error?: string) => {
    const task = get().tasks[id];
    patch(id, { status, error: status === 'cancelled' ? undefined : error, cancelError: undefined, cancellable: false, finishedAt: Date.now(), message: taskStatusKey(status), completed: status === 'succeeded' && task?.total ? task.total : task?.completed ?? null });
    schedulePrune(id);
  };
  const applyGroupOutcomes = (groupId: string) => {
    const group = groups.get(groupId), task = get().tasks[groupId];
    if (!group || !task || !isTaskActive(task)) return;
    const pendingRepos = new Set([...group.pending].map((id) => bindings.get(id)?.repoId));
    const children = task.children.map((child) => group.outcomes.has(child.repoId) && !pendingRepos.has(child.repoId) ? { ...child, ...group.outcomes.get(child.repoId)!, message: taskStatusKey(group.outcomes.get(child.repoId)!.status) } : child);
    patch(groupId, { children, cancellable: children.some((child) => isTaskActive(child)), completed: children.filter((child) => isTerminal(child.status) && child.status !== 'skipped').length });
    if (!group.finishRequested || group.pending.size) return;
    const failed = children.filter((child) => ['failed', 'timedOut', 'partial'].includes(child.status)).length;
    const succeeded = children.filter((child) => child.status === 'succeeded').length;
    const cancelled = children.some((child) => child.status === 'cancelled');
    const status = failed ? succeeded ? 'partial' : 'failed' : group.stopped || cancelled ? 'cancelled' : 'succeeded';
    terminal(groupId, status, children.find((child) => child.error)?.error);
  };
  const requestCancellation = async (id: string) => {
    const record = requests.get(id); if (!record || record.terminalSeen || record.cancelSent) return;
    record.cancelPending = true;
    if (!record.nativeSeen) return;
    record.cancelSent = true;
    const taskId = record.groupId ?? id;
    try {
      const accepted = await cancelNative(id);
      const task = get().tasks[taskId];
      if (!accepted && task && isTaskActive(task) && requests.has(id) && !record.terminalSeen) {
        record.cancelSent = false; record.cancelPending = false;
        // Cancellation did not reach the backend; allow another attempt.
        patch(taskId, { status: record.latestStatus, cancelError: 'Could not cancel the task. Please try again.' });
      }
    } catch (error) {
      record.cancelSent = false; record.cancelPending = false;
      const task = get().tasks[taskId];
      if (task && isTaskActive(task) && requests.has(id) && !record.terminalSeen) patch(taskId, { status: record.latestStatus, cancelError: errorText(error) });
    }
  };
  return {
    tasks: {}, open: false,
    trackForegroundRequest: (id, immediate = false) => { foregroundRequests.set(id, immediate); },
    setOpen: (open) => {
      set((state) => ({ open, tasks: open ? state.tasks : Object.fromEntries(Object.entries(state.tasks)
        .filter(([, task]) => isTaskActive(task) || Date.now() - (task.finishedAt ?? 0) < 2000)
        .map(([id, task]) => [id, isTaskActive(task) ? task : { ...task, detailsDismissed: true }])) }));
      if (!open) { for (const id of groups.keys()) if (!get().tasks[id]) groups.delete(id); }
      if (!open) Object.values(get().tasks).filter((task) => !isTaskActive(task)).forEach((task) => schedulePrune(task.id));
    },
    requested: (event, metadata) => {
      const binding = bindings.get(event.requestId);
      const immediate = foregroundRequests.get(event.requestId);
      const explicitForeground = foregroundRequests.delete(event.requestId);
      if (!binding && ((!explicitForeground && event.context.visibility === 'background') || !tracksTaskCommand(event.command.type))) return;
      requests.set(event.requestId, { command: event.command.type, groupId: binding?.groupId, nativeSeen: false, terminalSeen: false, cancelPending: false, cancelSent: false, latestStatus: 'queued' });
      if (binding) {
        const group = groups.get(binding.groupId), task = get().tasks[binding.groupId];
        if (!group || !task) return;
        group.pending.add(event.requestId);
        patch(task.id, { repoName: task.children.find((child) => child.repoId === binding.repoId)?.repoName, message: 'Waiting to start operation', children: task.children.map((child) => child.repoId === binding.repoId ? { ...child, status: group.stopped ? 'cancelling' : 'running', message: 'Waiting to start operation' } : child) });
        if (group.stopped) requests.get(event.requestId)!.cancelPending = true;
        return;
      }
      set((state) => ({ tasks: { ...state.tasks, [event.requestId]: {
        id: event.requestId, title: taskTitle(event), workspaceId: event.context.workspaceId, workspaceName: metadata.workspaceName, repoName: metadata.repoName,
        status: 'queued', immediate, message: 'Waiting to start operation', startedAt: Date.now(), completed: event.command.type === 'batchCommit' ? 0 : null, total: event.command.type === 'batchCommit' ? event.command.payload.targets.length : null, cancellable: true, children: metadata.repositories?.map((repo) => ({ repoId: repo.id, repoName: repo.name, status: 'queued', message: 'Waiting to start operation' })) ?? [],
      } } }));
    },
    operation: (event) => {
      const record = requests.get(event.operationId); if (!record) return;
      record.nativeSeen = true; record.latestStatus = event.status;
      const binding = bindings.get(event.operationId), taskId = binding?.groupId ?? event.operationId, task = get().tasks[taskId];
      if (!task) return;
      if (isTerminal(event.status)) record.terminalSeen = true;
      if (binding) {
        patch(taskId, { ...(isTerminal(event.status) ? {} : { repoName: task.children.find((child) => child.repoId === binding.repoId)?.repoName, message: event.message || taskStatusKey(event.status) }), children: task.children.map((child) => child.repoId === binding.repoId ? { ...child,
          status: isTerminal(event.status) ? child.status : record.cancelPending || task.status === 'cancelling' ? 'cancelling' : event.status,
          message: event.message || taskStatusKey(event.status) } : child) });
      } else {
        if (record.command === 'batchCommit' && event.status === 'running' && event.completed !== null) {
          const index = event.completed;
          patch(taskId, {
            repoName: task.children[index]?.repoName,
            children: task.children.map((child, childIndex) => childIndex <= index ? {
              ...child, status: record.cancelPending ? 'cancelling' : 'running',
              message: childIndex === index ? event.message || taskStatusKey(event.status) : 'Waiting for operation results',
            } : child),
          });
        }
        // The original request promise must settle after native recovery before a task disappears.
        patch(taskId, { status: record.cancelPending || task.status === 'cancelling' ? 'cancelling' : isTerminal(event.status) ? task.status : event.status,
          message: event.message || taskStatusKey(event.status), completed: record.command === 'batchCommit' && isTerminal(event.status) ? task.completed : event.completed, total: record.command === 'batchCommit' ? task.total : event.total, cancellable: event.cancellable, error: event.error?.message });
      }
      if (record.cancelPending && !record.terminalSeen) void requestCancellation(event.operationId);
    },
    settled: (event) => {
      const binding = bindings.get(event.requestId), record = requests.get(event.requestId);
      if (!record) { bindings.delete(event.requestId); return; }
      requests.delete(event.requestId);
      if (binding) {
        groups.get(binding.groupId)?.pending.delete(event.requestId);
        applyGroupOutcomes(binding.groupId);
        bindings.delete(event.requestId);
      } else {
        // Native events and invoke responses travel independently. Classify results
        // even if the terminal event has not arrived yet.
        let status = event.error ? errorStatus(event.error) : record.terminalSeen ? record.latestStatus : 'succeeded';
        let error = event.error ? errorText(event.error) : get().tasks[event.requestId]?.error;
        if (record.command === 'batchCommit' && Array.isArray(event.result)) {
          const results = event.result as RepositoryOperationResult[];
          const failed = results.filter((item) => item.error && errorStatus(item.error) !== 'cancelled');
          const cancelled = results.some((item) => item.error && errorStatus(item.error) === 'cancelled');
          const succeeded = results.some((item) => !item.error);
          status = failed.length ? succeeded ? 'partial' : 'failed' : cancelled ? 'cancelled' : status;
          error = failed.map((item) => `${get().tasks[event.requestId]?.children.find((child) => child.repoId === item.repoId)?.repoName ?? item.repoId}: ${item.error!.message}`).join('\n') || error;
          const task = get().tasks[event.requestId];
          patch(event.requestId, { completed: results.length, children: task.children.map((child) => {
            const result = results.find((item) => item.repoId === child.repoId);
            const childStatus = result ? result.error ? errorStatus(result.error) : 'succeeded' : 'skipped';
            return { ...child, status: childStatus, message: taskStatusKey(childStatus), error: result?.error?.message };
          }) });
        } else if (event.result && typeof event.result === 'object') {
          const result = event.result as { status?: string; failures?: Array<{ message?: string }>; error?: { message?: string } };
          if (result.status === 'partialFailure' || result.failures?.length) {
            status = 'partial'; error = result.error?.message || result.failures?.map((failure) => failure.message).filter(Boolean).join('\n') || error;
          }
        }
        terminal(event.requestId, status, error);
      }
    },
    beginGroup: (title, workspaceId, workspaceName, repos) => {
      const id = `task-group-${crypto.randomUUID()}`;
      groups.set(id, { stopped: false, pending: new Set(), outcomes: new Map(), finishRequested: false });
      set((state) => ({ tasks: { ...state.tasks, [id]: { id, title, workspaceId, workspaceName, status: 'running', message: 'Preparing operation', startedAt: Date.now(), completed: 0, total: repos.length, cancellable: true, children: repos.map((repo) => ({ repoId: repo.id, repoName: repo.name, status: 'queued', message: 'Waiting to start operation' })) } } }));
      return id;
    },
    bindChild: (groupId, repoId, operationId) => { bindings.set(operationId, { groupId, repoId }); },
    completeChild: (groupId, repoId, status, error) => { groups.get(groupId)?.outcomes.set(repoId, { status, error }); applyGroupOutcomes(groupId); },
    finishGroup: (groupId) => {
      const group = groups.get(groupId), task = get().tasks[groupId]; if (!group || !task) return;
      group.finishRequested = true;
      if (group.stopped) patch(groupId, { children: task.children.map((child) => child.status === 'queued' ? { ...child, status: 'skipped', message: 'Not started' } : child) });
      applyGroupOutcomes(groupId);
    },
    isStopped: (groupId) => groups.get(groupId)?.stopped ?? false,
    cancel: async (id) => {
      const task = get().tasks[id]; if (!task || !isTaskActive(task) || task.status === 'cancelling' || !task.cancellable) return;
      patch(id, { status: 'cancelling', cancelError: undefined });
      const group = groups.get(id);
      if (group) { group.stopped = true; await Promise.all([...group.pending].map(requestCancellation)); }
      else await requestCancellation(id);
    },
  };
});

export function configureTaskProgress(cancel: (id: string) => Promise<boolean>) {
  resetTaskProgress();
  cancelNative = cancel;
}
export function resetTaskProgress() {
  timers.forEach(clearTimeout); timers.clear(); requests.clear(); foregroundRequests.clear(); bindings.clear(); groups.clear();
  useTaskProgressStore.setState({ tasks: {}, open: false });
}

export function taskRank(task: ProgressTask, currentWorkspaceId?: string | null): number {
  const current = !task.workspaceId || task.workspaceId === currentWorkspaceId;
  return (current ? 0 : 10) + (task.status === 'queued' ? 1 : 0);
}
export function sortedTasks(tasks: ProgressTask[], currentWorkspaceId?: string | null) {
  return [...tasks].sort((a, b) => taskRank(a, currentWorkspaceId) - taskRank(b, currentWorkspaceId) || a.startedAt - b.startedAt || a.id.localeCompare(b.id));
}
