import { create } from 'zustand';

export const useCheckpointCenter = create<{ open: boolean; projectId?: string; taskId?: string }>(() => ({ open: false }));
export function openCheckpointCenter(projectId?: string, taskId?: string) { useCheckpointCenter.setState({ open: true, projectId, taskId }); }
export function closeCheckpointCenter() { useCheckpointCenter.setState({ open: false }); }
