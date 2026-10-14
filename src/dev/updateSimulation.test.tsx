import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { check } from '@tauri-apps/plugin-updater';
import { invoke } from '@tauri-apps/api/core';
import { DEFAULT_SETTINGS } from '../settings/defaults';
import type { BootstrapData } from '../bindings/generated';

vi.mock('@tauri-apps/plugin-updater', () => ({ check: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }));

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubEnv('VITE_UPDATE_SIMULATION', '1');
  vi.stubGlobal('fetch', vi.fn());
  vi.mocked(check).mockClear();
  vi.mocked(invoke).mockClear();
  document.documentElement.lang = 'en';
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

async function session() {
  const service = await import('../services/updater');
  const simulation = await import('./updateSimulation');
  const { useAppUpdateStore } = await import('../store/appUpdateStore');
  const { useAppStore } = await import('../store/appStore');
  return { service, simulation, updates: useAppUpdateStore, app: useAppStore };
}
async function settle<T>(promise: Promise<T>) {
  const outcome = promise.then(value => ({ value }), (error: unknown) => ({ error }));
  await vi.runAllTimersAsync();
  return outcome;
}

it('runs check, download progress, and simulated restart without native updater or network calls', async () => {
  const { service, simulation, updates, app } = await session();
  const result = await settle(service.checkAppUpdate());
  expect(result).toMatchObject({ value: { available: true, canInstall: true, simulated: true, latestVersion: simulation.SIMULATED_VERSION } });
  if ('value' in result) app.getState().setUpdateAvailableInfo(result.value);
  const progress: number[] = [];
  const unsubscribe = updates.subscribe(state => { if (state.progress) progress.push(state.progress.percent); });
  await settle(updates.getState().install(simulation.SIMULATED_VERSION));
  unsubscribe();
  expect(progress[0]).toBe(0);
  expect(progress.at(-1)).toBe(100);
  expect(updates.getState().phase).toBe('ready');
  const pending = updates.getState().restart();
  expect(updates.getState().phase).toBe('restarting');
  await settle(pending);
  expect(updates.getState().phase).toBe('idle');
  expect(simulation.useUpdateSimulation.getState().completed).toBe(true);
  expect(app.getState().updateAvailableInfo?.available).toBe(false);
  expect(check).not.toHaveBeenCalled(); expect(invoke).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});

it.each(['download-error', 'restart-error'] as const)('fails once and recovers through retry for %s', async scenario => {
  const { simulation, updates } = await session();
  simulation.configureSimulation(scenario);
  if (scenario === 'download-error') {
    expect(await settle(updates.getState().install(simulation.SIMULATED_VERSION))).toHaveProperty('error');
    expect(updates.getState()).toMatchObject({ phase: 'idle', error: expect.stringContaining('45%') });
  }
  await settle(updates.getState().install(simulation.SIMULATED_VERSION));
  expect(updates.getState().phase).toBe('ready');
  if (scenario === 'restart-error') {
    expect(await settle(updates.getState().restart())).toHaveProperty('error');
    expect(updates.getState()).toMatchObject({ phase: 'ready', error: expect.stringContaining('restart failure') });
  }
  await settle(updates.getState().restart());
  expect(updates.getState()).toMatchObject({ phase: 'idle', error: null });
});

it('distinguishes up to date from check failure and rejects installation in both cases', async () => {
  const { simulation, service } = await session();
  for (const scenario of ['current', 'check-error'] as const) {
    simulation.configureSimulation(scenario);
    expect(await settle(service.checkAppUpdate())).toMatchObject({ value: { available: false, canInstall: false } });
    expect(await settle(service.downloadAndInstallAppUpdate(undefined, simulation.SIMULATED_VERSION))).toHaveProperty('error');
  }
  expect(check).not.toHaveBeenCalled(); expect(invoke).not.toHaveBeenCalled();
});

it('reset discards pending checks and download results without overwriting a new scenario', async () => {
  const { simulation, updates, service } = await session();
  const oldCheck = service.checkAppUpdate();
  await vi.advanceTimersByTimeAsync(100);
  const oldCheckOutcome = oldCheck.catch(error => error);
  const oldDownload = updates.getState().install(simulation.SIMULATED_VERSION);
  await vi.advanceTimersByTimeAsync(300);
  simulation.configureSimulation('current');
  updates.getState().resetSimulation();
  await settle(oldDownload);
  expect(await oldCheckOutcome).toMatchObject({ name: 'AbortError' });
  expect(updates.getState()).toMatchObject({ phase: 'idle', progress: null, error: null, targetVersion: null });
  expect(await settle(service.checkAppUpdate())).toMatchObject({ value: { available: false } });
});

it('skipped simulation versions stay in memory and reset makes the update available again', async () => {
  const { simulation, service } = await session();
  await service.skipSimulatedUpdate(simulation.SIMULATED_VERSION);
  expect(await settle(service.checkAppUpdate())).toMatchObject({ value: { available: false } });
  simulation.configureSimulation('available');
  expect(await settle(service.checkAppUpdate())).toMatchObject({ value: { available: true } });
});

it('reset during simulated restart cannot complete or clear the new scenario', async () => {
  const { simulation, updates, app } = await session();
  await settle(updates.getState().install(simulation.SIMULATED_VERSION));
  const oldRestart = updates.getState().restart();
  await vi.advanceTimersByTimeAsync(200);
  simulation.configureSimulation('check-error');
  updates.getState().resetSimulation();
  const next = { available: false, currentVersion: '0.1.12', simulated: true, error: 'new check failure' };
  app.getState().setUpdateAvailableInfo(next);
  await settle(oldRestart);
  expect(simulation.useUpdateSimulation.getState()).toMatchObject({ scenario: 'check-error', completed: false });
  expect(app.getState().updateAvailableInfo).toEqual(next);
  expect(updates.getState().phase).toBe('idle');
});

it('rejects a version mismatch before showing simulated download progress', async () => {
  const { service } = await session();
  const progress = vi.fn();
  expect(await settle(service.downloadAndInstallAppUpdate(progress, '99.0.0'))).toHaveProperty('error');
  expect(progress).not.toHaveBeenCalled();
  expect(check).not.toHaveBeenCalled(); expect(invoke).not.toHaveBeenCalled();
});

it('ignores saved real skipped versions for simulated checks', async () => {
  const { simulation, app } = await session();
  app.setState({ bootstrap: { state: { settings: { ...DEFAULT_SETTINGS, skippedUpdateVersion: simulation.SIMULATED_VERSION } } } as BootstrapData });
  await settle(app.getState().checkUpdateSilently(true));
  expect(app.getState().updateAvailableInfo?.available).toBe(true);
  expect(app.getState().bootstrap?.state.settings?.skippedUpdateVersion).toBe(simulation.SIMULATED_VERSION);
});

it.each(['en', 'zh-CN'] as const)('exposes scenario controls and skips without saving settings in %s', async language => {
  const { app } = await session();
  const save = vi.fn();
  app.setState({ updateAvailableInfo: null, updateSettings: save });
  const { AboutDialog } = await import('../components/AboutDialog');
  const { createTranslator, I18nContext } = await import('../i18n');
  const t = createTranslator(language);
  render(<I18nContext.Provider value={{ language, preference: 'system', t }}><AboutDialog onClose={vi.fn()} /></I18nContext.Provider>);
  await act(async () => { await vi.dynamicImportSettled(); });
  expect(screen.getByText(t('Update simulation'))).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: t('Reset simulation') }));
  await act(async () => { await vi.runAllTimersAsync(); });
  expect(screen.getByRole('button', { name: t('Download and Install Update') })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: t('Skip this version') }));
  await act(async () => { await vi.dynamicImportSettled(); });
  expect(save).not.toHaveBeenCalled();
  expect(app.getState().updateAvailableInfo).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: t('Check for Updates') }));
  await act(async () => { await vi.runAllTimersAsync(); });
  expect(app.getState().updateAvailableInfo?.available).toBe(false);
});

it('does not enable simulation outside development builds even with the startup variable set', async () => {
  vi.stubEnv('DEV', false);
  const service = await import('../services/updater');
  expect(service.UPDATE_SIMULATION_ENABLED).toBe(false);
});
