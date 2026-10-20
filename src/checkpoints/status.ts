import type { CheckpointActivity } from '../bindings/generated';
import { taskConnection } from './connection';

export interface CheckpointStatus {
  state: string;
  label: string;
  icon: string;
  taskId?: string;
  count?: number;
}

/** Project-wide warnings and active recordings take precedence over the selected task. */
export function checkpointStatus(listing: CheckpointActivity | null, busy: boolean, error: string | null): CheckpointStatus {
  if (error) return { state: 'error', label: 'Checkpoint problem', icon: 'error' };
  if (!listing) return { state: 'loading', label: 'Checking…', icon: 'loading codicon-modifier-spin' };
  const recovery = listing.recovery.find(report => ['pending', 'failed'].includes(report.status));
  if (recovery) return { state: 'recovery', label: 'Restore needs recovery', icon: 'warning', taskId: recovery.taskId };
  const failed = listing.tasks.find(task => task.error || (task.mode === 'automatic' && ['error', 'invalid'].includes(taskConnection(task, listing.connections).status)) || task.checkpoints.some(point => point.status === 'incomplete'));
  if (failed) return { state: 'error', label: 'Checkpoint problem', icon: 'error', taskId: failed.id };
  const interrupted = listing.tasks.find(task => task.checkpoints.some(point => point.status === 'interrupted'));
  if (interrupted) return { state: 'interrupted', label: 'Needs finishing', icon: 'debug-pause', taskId: interrupted.id };
  if (busy) return { state: 'processing', label: 'Processing…', icon: 'loading codicon-modifier-spin' };
  const recording = listing.tasks.filter(task => task.checkpoints.some(point => point.status === 'recording'));
  if (recording.length) return { state: 'recording', label: 'Checkpoint status: recording', icon: 'record', taskId: recording[0].id, count: recording.length };
  const unverified = listing.tasks.find(task => task.mode === 'automatic' && taskConnection(task, listing.connections).status !== 'verified');
  if (unverified) return { state: 'unverified', label: 'Waiting for hooks', icon: 'plug', taskId: unverified.id };
  const latest = listing.tasks.flatMap(task => task.checkpoints.map(point => ({ task, point })))
    .sort((a, b) => b.point.createdAt.localeCompare(a.point.createdAt))[0];
  if (latest) {
    const { point, task } = latest;
    if (point.error) return { state: 'error', label: 'Checkpoint problem', icon: 'error', taskId: task.id };
    if (point.status === 'completed' || point.status === 'applied') return { state: 'completed', label: 'Completed', icon: 'check', taskId: task.id };
    if (point.status === 'undone') return { state: 'undone', label: 'Checkpoint status: undone', icon: 'discard', taskId: task.id };
    if (point.status === 'abandoned') return { state: 'abandoned', label: 'Checkpoint status: abandoned', icon: 'circle-slash', taskId: task.id };
  }
  if (!listing.tasks.length) return { state: 'empty', label: 'Not configured', icon: 'layers' };
  return { state: 'ready', label: 'Ready to record', icon: 'layers', taskId: listing.tasks[0].id };
}
