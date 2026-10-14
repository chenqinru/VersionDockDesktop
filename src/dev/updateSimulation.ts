import { create } from 'zustand';
import { APP_CURRENT_VERSION } from '../version';
import { createTranslator } from '../i18n';
import type { AppUpdateCheckResult, UpdateDownloadProgress } from '../services/updater';

export type UpdateScenario = 'available' | 'current' | 'check-error' | 'download-error' | 'restart-error';
export const SIMULATED_VERSION = APP_CURRENT_VERSION.replace(/(\d+)$/, patch => String(Number(patch) + 1));
export const useUpdateSimulation = create<{ scenario: UpdateScenario; completed: boolean }>(() => ({ scenario: 'available', completed: false }));

const t = (key: string) => createTranslator(document.documentElement.lang.startsWith('zh') ? 'zh-CN' : 'en')(key);

let generation = 0;
let skippedVersion: string | undefined;
let downloadFailed = false;
let restartFailed = false;

export function configureSimulation(scenario: UpdateScenario) {
  generation += 1;
  skippedVersion = undefined;
  downloadFailed = false;
  restartFailed = false;
  useUpdateSimulation.setState({ scenario, completed: false });
}

async function delay(milliseconds: number, owner: number) {
  await new Promise<void>(resolve => setTimeout(resolve, milliseconds));
  if (owner !== generation) throw new DOMException('Update simulation reset', 'AbortError');
}

export async function checkUpdate(): Promise<AppUpdateCheckResult> {
  const owner = generation;
  await delay(700, owner);
  const { scenario, completed } = useUpdateSimulation.getState();
  const base = { currentVersion: APP_CURRENT_VERSION, simulated: true, canInstall: false };
  if (scenario === 'check-error') return { ...base, available: false, error: t('Simulated update check failure') };
  if (scenario === 'current' || completed || skippedVersion === SIMULATED_VERSION) return { ...base, available: false };
  const chinese = document.documentElement.lang.startsWith('zh');
  return {
    ...base, available: true, canInstall: true, latestVersion: SIMULATED_VERSION,
    releaseDate: new Date().toISOString(),
    releaseNotes: chinese
      ? '## 模拟更新\n\n- 查看 **下载进度**和待重启状态\n- 在欢迎页和项目页之间切换，更新状态保持同步\n\n此更新仅用于界面调试，不会安装应用。'
      : '## Simulated update\n\n- Preview **download progress** and the pending restart state\n- Keep update state across welcome and workspace screens\n\nThis update is for UI debugging and will not install the app.',
  };
}

export function skipUpdate(version: string) { skippedVersion = version; }

export async function downloadUpdate(onProgress?: (progress: UpdateDownloadProgress) => void, selectedVersion?: string) {
  const owner = generation;
  const { scenario, completed } = useUpdateSimulation.getState();
  if (scenario === 'current' || scenario === 'check-error' || completed || skippedVersion === SIMULATED_VERSION) throw new Error('No simulated update available');
  if (selectedVersion && selectedVersion !== SIMULATED_VERSION) throw new Error('The selected simulated version has changed');
  const totalBytes = 48 * 1024 * 1024;
  for (let percent = 0; percent <= 100; percent += 5) {
    if (percent) await delay(250, owner);
    if (scenario === 'download-error' && percent === 45 && !downloadFailed) {
      downloadFailed = true;
      throw new Error(t('Simulated download failure at 45%; retry to continue'));
    }
    onProgress?.({ percent, downloadedBytes: totalBytes * percent / 100, totalBytes, contentLength: totalBytes, chunkLength: percent ? totalBytes / 20 : 0 });
  }
  await delay(400, owner);
}

export async function restartUpdate() {
  const owner = generation;
  await delay(900, owner);
  if (useUpdateSimulation.getState().scenario === 'restart-error' && !restartFailed) {
    restartFailed = true;
    throw new Error(t('Simulated restart failure; retry to complete'));
  }
  useUpdateSimulation.setState({ completed: true });
}
