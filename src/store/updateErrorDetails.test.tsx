import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { BrowserDevBridge } from '../platform/browserDevBridge';
import { BridgeError } from '../platform/bridge';
import { createTranslator, I18nContext, resolveLanguage } from '../i18n';
import { resolveNotificationText, useAppStore } from './appStore';
import { NotificationToast } from '../components/NotificationToast';
import { NotificationCenterPopover } from '../components/StatusBar/NotificationCenterPopover';

const initial = useAppStore.getState();
afterEach(() => {
  cleanup();
  useAppStore.getState().dispose();
  useAppStore.setState(initial, true);
  localStorage.clear();
  vi.restoreAllMocks();
});

const failUpdate = async (error: BridgeError, language: 'zhCn' | 'en' = 'zhCn') => {
  const bridge = new BrowserDevBridge();
  const original = bridge.request.bind(bridge);
  vi.spyOn(bridge, 'request').mockImplementation((command, options) => command.type === 'sync'
    ? Promise.reject(error) : original(command, options));
  await useAppStore.getState().initialize(bridge);
  await useAppStore.getState().openWorkspace(['/browser-demo']);
  await useAppStore.getState().updateSettings({ language });
  const repo = useAppStore.getState().allRepositories.find((repo) => repo.meta.id === 'api')!;
  useAppStore.setState({ allRepositories: [repo], notifications: [] });
  await useAppStore.getState().updateProject('merge');
  return useAppStore.getState().notifications.find((item) => item.type === 'error')!;
};

describe('update failure details parity', () => {
  it.each(['zhCn', 'en'] as const)('shows complete multiline Git SSL output in %s', async (language) => {
    const stderr = "fatal: unable to access 'https://github.com/example/repo.git/':\nLibreSSL SSL_connect: SSL_ERROR_SYSCALL in connection to github.com:443";
    const notice = await failUpdate(new BridgeError({ code: 'COMMAND_FAILED', message: stderr.split('\n')[0], command: 'git', exitCode: 128, stderr, recoverable: true }), language);
    expect(resolveNotificationText(notice.message, createTranslator(resolveLanguage(language)))).toContain(stderr);
    expect(notice.details).toContain(stderr);
    expect(notice.details).toContain('COMMAND_FAILED\ngit\n128');
    const context = { language: resolveLanguage(language), preference: language, t: createTranslator(resolveLanguage(language)) };
    const toast = render(<I18nContext.Provider value={context}><NotificationToast /></I18nContext.Provider>);
    expect(toast.container.querySelector('.toast-message')?.textContent).toContain(stderr);
    expect(toast.container.querySelector('.toast-details pre')?.textContent).toContain(stderr);
    toast.unmount();
    const center = render(<I18nContext.Provider value={context}><NotificationCenterPopover anchorRect={null} anchorRef={{ current: null }} onClose={() => undefined} /></I18nContext.Provider>);
    expect(center.baseElement.querySelector('.notification-item-msg')?.textContent).toContain(stderr);
    expect(center.baseElement.querySelector('.toast-details pre')?.textContent).toContain(stderr);
  });

  it('keeps captured stderr beside the localized timeout message', async () => {
    const stderr = 'fatal: connection to github.com:443 failed';
    const notice = await failUpdate(new BridgeError({ code: 'REQUEST_TIMEOUT', message: 'Request timed out after 45000ms', command: 'git', exitCode: null, stderr, recoverable: true }));
    expect(resolveNotificationText(notice.message, createTranslator('zh-CN'))).toContain(`操作已超时（45 秒）。\n${stderr}`);
    expect(notice.details).toContain('REQUEST_TIMEOUT\ngit');
  });

  it('reports a pure timeout when no native output exists', async () => {
    const notice = await failUpdate(new BridgeError({ code: 'REQUEST_TIMEOUT', message: 'Request timed out after 45000ms', command: null, exitCode: null, stderr: null, recoverable: true }));
    expect(resolveNotificationText(notice.message, createTranslator('zh-CN'))).toContain('操作已超时（45 秒）。');
    expect(notice.details).not.toContain('SSL');
  });

  it('preserves recovery guidance instead of replacing it with stderr', async () => {
    const message = 'Update failed, and local changes remain in auto-stash abc123.';
    const notice = await failUpdate(new BridgeError({ code: 'GIT_PULL_FAILED_RESTORE_FAILED', message, command: 'git', exitCode: 1, stderr: 'patch does not apply', subject: 'abc123', recoverable: true }));
    expect(resolveNotificationText(notice.message, createTranslator('zh-CN'))).toContain(message);
    expect(notice.details).toContain('patch does not apply');
    expect(notice.details).toContain('abc123');
  });
});
