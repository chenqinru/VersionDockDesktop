import { create } from 'zustand';
import { APP_CURRENT_VERSION } from '../version';
import { downloadAndInstallAppUpdate, restartApp, UPDATE_SIMULATION_ENABLED, type UpdateDownloadProgress } from '../services/updater';

interface AppUpdateState {
  phase: 'idle' | 'downloading' | 'ready' | 'restarting';
  targetVersion: string | null;
  progress: UpdateDownloadProgress | null;
  error: string | null;
  install: (version: string) => Promise<void>;
  restart: () => Promise<void>;
  resetSimulation: () => void;
}

let generation = 0;
const idleState = { phase: 'idle' as const, targetVersion: null, progress: null, error: null };

// Share installation state across update entry points and workspace changes.
export const useAppUpdateStore = create<AppUpdateState>((set, get) => ({
  phase: 'idle',
  targetVersion: null,
  progress: null,
  error: null,
  install: async (version) => {
    if (get().phase !== 'idle') return;
    const owner = ++generation;
    set({ phase: 'downloading', targetVersion: version, progress: null, error: null });
    try {
      await downloadAndInstallAppUpdate((progress) => { if (owner === generation) set({ progress }); }, version);
      if (owner !== generation) return;
      set({ phase: 'ready', progress: null });
    } catch (error) {
      if (owner !== generation) return;
      set({ phase: 'idle', progress: null, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  },
  restart: async () => {
    if (get().phase !== 'ready') return;
    const owner = ++generation;
    set({ phase: 'restarting', error: null });
    try {
      await restartApp();
      if (owner === generation && UPDATE_SIMULATION_ENABLED) {
        const { useAppStore } = await import('./appStore');
        if (owner !== generation) return;
        useAppStore.getState().setUpdateAvailableInfo({ available: false, currentVersion: APP_CURRENT_VERSION, canInstall: false, simulated: true });
        set(idleState);
      }
    } catch (error) {
      if (owner !== generation) return;
      set({ phase: 'ready', error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  },
  resetSimulation: () => {
    if (!UPDATE_SIMULATION_ENABLED) return;
    generation += 1;
    set(idleState);
  },
}));
