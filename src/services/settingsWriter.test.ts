import { expect, it, vi } from 'vitest';
import type { DesktopSettings, SettingsUpdateResult } from '../bindings/generated';
import { SettingsWriter } from './settingsWriter';

const initial = { theme: 'dark2026', fileIconTheme: 'material', language: 'en' } as DesktopSettings;
const effects = { rescanWorkspace: false, reloadHistory: false, restartAutoRefresh: false };
function setup() {
  let current = initial;
  const requests: Array<{ settings: DesktopSettings; fields: Array<keyof DesktopSettings>; resolve: (result: SettingsUpdateResult) => void; reject: (error: Error) => void }> = [];
  const error = vi.fn();
  const writer = new SettingsWriter(initial, (settings, fields) => new Promise((resolve, reject) => requests.push({ settings, fields, resolve, reject })), (next) => { current = next; }, async () => {}, error);
  return { writer, requests, error, current: () => current };
}
it('serializes persistence and retains later choices across an older response', async () => {
  const s = setup();
  const a = s.writer.update({ theme: 'dracula' });
  const b = s.writer.update({ fileIconTheme: 'seti' });
  const c = s.writer.update({ theme: 'light2026' });
  expect(s.requests).toHaveLength(1);
  expect(s.current()).toMatchObject({ theme: 'light2026', fileIconTheme: 'seti' });
  s.requests[0].resolve({ settings: s.requests[0].settings, effects }); await a;
  expect(s.current()).toMatchObject({ theme: 'light2026', fileIconTheme: 'seti' });
  expect(s.requests).toHaveLength(2);
  expect(s.requests[1].fields).toEqual(['fileIconTheme', 'theme']);
  expect(s.requests[1].settings).toMatchObject({ theme: 'light2026', fileIconTheme: 'seti' });
  s.requests[1].resolve({ settings: s.requests[1].settings, effects }); await Promise.all([b, c]);
  expect(s.current()).toMatchObject({ theme: 'light2026', fileIconTheme: 'seti' });
});
it('rolls back only failed choices and continues to save newer choices', async () => {
  const s = setup();
  const a = s.writer.update({ theme: 'dracula' });
  const b = s.writer.update({ fileIconTheme: 'seti' });
  s.requests[0].reject(new Error('disk failure')); await a;
  expect(s.current()).toMatchObject({ theme: 'dark2026', fileIconTheme: 'seti' });
  expect(s.requests[1].settings).toMatchObject({ theme: 'dark2026', fileIconTheme: 'seti' });
  s.requests[1].resolve({ settings: s.requests[1].settings, effects }); await b;
  expect(s.error).toHaveBeenCalledOnce();
});
it('keeps the last confirmed settings when the latest save fails', async () => {
  const s = setup(); const a = s.writer.update({ theme: 'dracula' });
  s.requests[0].resolve({ settings: s.requests[0].settings, effects }); await a;
  const b = s.writer.update({ fileIconTheme: 'seti' }); s.requests[1].reject(new Error('failure')); await b;
  expect(s.current()).toMatchObject({ theme: 'dracula', fileIconTheme: 'material' });
});
