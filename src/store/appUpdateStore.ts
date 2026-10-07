import { create } from 'zustand';
import { downloadAndInstallAppUpdate, restartApp, type UpdateDownloadProgress } from '../services/updater';

interface AppUpdateState {
  phase: 'idle' | 'downloading' | 'ready' | 'restarting';
  targetVersion: string | null;
  progress: UpdateDownloadProgress | null;
  error: string | null;
  install: (version: string) => Promise<void>;
  restart: () => Promise<void>;
}

// Share installation state across update entry points and workspace changes.
export const useAppUpdateStore = create<AppUpdateState>((set, get) => ({
  phase: 'idle',
  targetVersion: null,
  progress: null,
  error: null,
  install: async (version) => {
    if (get().phase !== 'idle') return;
    set({ phase: 'downloading', targetVersion: version, progress: null, error: null });
    try {
      await downloadAndInstallAppUpdate((progress) => set({ progress }), version);
      set({ phase: 'ready', progress: null });
    } catch (error) {
      set({ phase: 'idle', progress: null, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  },
  restart: async () => {
    if (get().phase !== 'ready') return;
    set({ phase: 'restarting', error: null });
    try {
      await restartApp();
    } catch (error) {
      set({ phase: 'ready', error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  },
}));
