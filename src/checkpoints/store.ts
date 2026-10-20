import { create } from 'zustand';
import type { CheckpointAction, CheckpointActivity, CheckpointListing, CheckpointCleanupPreview, CheckpointCleanupReport, RestoreFile, RestorePreview, RestoreReport } from '../bindings/generated';
import { useAppStore } from '../store/appStore';
import { isAbortError } from '../platform/bridge';

interface CheckpointState {
  workspaceId: string | null;
  listing: CheckpointListing | null;
  activity: CheckpointActivity | null;
  selectedTaskId: string | null;
  preview: RestorePreview | null;
  details: RestoreFile[] | null;
  detailsCheckpointId: string | null;
  cleanupPreview: CheckpointCleanupPreview | null;
  cleanupReport: CheckpointCleanupReport | null;
  busy: boolean;
  loadingDetailsId: string | null;
  error: string | null;
  listingError: string | null;
}
const initial: CheckpointState = { workspaceId: null, listing: null, activity: null, selectedTaskId: null, preview: null, details: null, detailsCheckpointId: null, cleanupPreview: null, cleanupReport: null, busy: false, loadingDetailsId: null, error: null, listingError: null };
export const useCheckpointStore = create<CheckpointState>(() => initial);
let generation = 0;
let independentScope = false;
let operation = 0;
let refreshing = false;
let refreshingActivity = false;
let activityRevision = 0;
let controller: AbortController | undefined;

export function checkpointWorkspaceChanged(workspaceId: string | null, independent = false) {
  if (workspaceId === useCheckpointStore.getState().workspaceId && independentScope === independent) return;
  independentScope = independent;
  generation += 1;
  activityRevision += 1;
  controller?.abort(); controller = undefined;
  refreshing = false;
  refreshingActivity = false;
  useCheckpointStore.setState({ ...initial, workspaceId });
}
function current(id: string, ticket: number) {
  return useCheckpointStore.getState().workspaceId === id && ticket === generation && (independentScope || useAppStore.getState().snapshot?.workspace.id === id);
}
async function request<T>(action: CheckpointAction, signal?: AbortSignal): Promise<T> {
  const { bridge } = useAppStore.getState();
  const { workspaceId } = useCheckpointStore.getState();
  if (!bridge || !workspaceId) throw new Error('Workspace is unavailable');
  return bridge.request<T>({ type: 'checkpoint', payload: { workspace_id: workspaceId, action } }, { signal, timeoutMs: ['activity', 'overview'].includes(action.type) ? 15_000 : 600_000, showProgress: false, context: { workspaceId } });
}
export async function refreshCheckpointActivity() {
  const { workspaceId, busy } = useCheckpointStore.getState();
  if (!workspaceId || refreshingActivity || refreshing || busy) return;
  const ticket = generation; const revision = activityRevision; refreshingActivity = true;
  try {
    const activity = await request<CheckpointActivity>({ type: 'activity' });
    if (!activity || !Array.isArray(activity.tasks) || !Array.isArray(activity.recovery)) throw new Error('Tasks and checkpoints require the native VersionDock application.');
    if (current(workspaceId, ticket) && revision === activityRevision) useCheckpointStore.setState({ activity, listingError: null });
  } catch (error) {
    if (current(workspaceId, ticket) && revision === activityRevision && !isAbortError(error)) useCheckpointStore.setState({ listingError: error instanceof Error ? error.message : String(error) });
  } finally { if (ticket === generation) refreshingActivity = false; }
}
export async function refreshCheckpoints() {
  const { workspaceId, busy } = useCheckpointStore.getState();
  if (!workspaceId || refreshing || busy) return;
  const ticket = generation; const revision = ++activityRevision; refreshing = true;
  try {
    const listing = await request<CheckpointListing>({ type: 'overview' });
    if (!listing || !Array.isArray(listing.tasks) || !Array.isArray(listing.recovery)) throw new Error('Tasks and checkpoints require the native VersionDock application.');
    if (current(workspaceId, ticket) && revision === activityRevision) {
      const selected = useCheckpointStore.getState().selectedTaskId;
      useCheckpointStore.setState({ listing, activity: { tasks: listing.tasks, recovery: listing.recovery, connections: listing.connections }, listingError: null, selectedTaskId: listing.tasks.some(task => task.id === selected) ? selected : listing.tasks[0]?.id ?? null });
    }
  } catch (error) {
    if (current(workspaceId, ticket) && revision === activityRevision && !isAbortError(error)) useCheckpointStore.setState({ listingError: error instanceof Error ? error.message : String(error) });
  } finally { if (ticket === generation) refreshing = false; }
}
export async function runCheckpointAction<T>(action: CheckpointAction): Promise<T | undefined> {
  const { workspaceId, busy } = useCheckpointStore.getState();
  if (!workspaceId || busy) return;
  const ticket = generation; const requestId = ++operation;
  activityRevision += 1;
  controller = new AbortController();
  useCheckpointStore.setState({ busy: true, loadingDetailsId: action.type === 'detail' ? action.checkpoint_id : null, error: null, ...(action.type === 'detail' ? { preview: null } : {}), ...(['preview', 'previewRedo'].includes(action.type) ? { preview: null } : {}), ...(action.type === 'previewCleanup' ? { cleanupPreview: null, cleanupReport: null } : {}) });
  try {
    const result = await request<T>(action, controller.signal);
    if (!current(workspaceId, ticket)) return;
    if (action.type === 'previewCleanup') useCheckpointStore.setState({ cleanupPreview: result as CheckpointCleanupPreview });
    else if (action.type === 'cleanup') useCheckpointStore.setState({ cleanupPreview: null, cleanupReport: result as CheckpointCleanupReport, preview: null, details: null, detailsCheckpointId: null });
    else if (action.type === 'preview' || action.type === 'previewRedo') useCheckpointStore.setState({ preview: result as RestorePreview, details: null, detailsCheckpointId: action.type === 'previewRedo' || action.bring_back ? null : action.checkpoint_id ?? useCheckpointStore.getState().listing?.tasks.find(task => task.id === action.task_id)?.checkpoints.filter(point => point.status === 'completed').at(-1)?.id ?? null });
    else if (action.type === 'detail') useCheckpointStore.setState({ details: result as RestoreFile[], detailsCheckpointId: action.checkpoint_id });
    else {
      useCheckpointStore.setState({ preview: null, details: null, detailsCheckpointId: null, cleanupPreview: null, cleanupReport: null });
      const report = result as RestoreReport;
      if (report?.status === 'failed') useCheckpointStore.setState({ error: report.error ?? 'Restore failed; recovery is available' });
    }
    return result;
  } catch (error) {
    if (current(workspaceId, ticket)) useCheckpointStore.setState({ ...(action.type === 'cleanup' ? { cleanupPreview: null } : {}), ...(!isAbortError(error) ? { error: error instanceof Error ? error.message : String(error) } : {}) });
  } finally {
    if (current(workspaceId, ticket) && requestId === operation) {
      controller = undefined; useCheckpointStore.setState({ busy: false, loadingDetailsId: null });
      if (action.type !== 'detail') await refreshCheckpoints();
    }
  }
}

export function cancelCheckpointAction() { controller?.abort(); }
export function selectCheckpointTask(id: string) { if (!useCheckpointStore.getState().busy) useCheckpointStore.setState({ selectedTaskId: id, preview: null, details: null, detailsCheckpointId: null, cleanupPreview: null, cleanupReport: null, error: null }); }
