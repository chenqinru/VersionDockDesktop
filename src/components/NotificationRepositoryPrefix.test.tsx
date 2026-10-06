import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { RepositoryStatus, WorkspaceSnapshot } from '../bindings/generated';
import { createTranslator, I18nContext } from '../i18n';
import { resolveNotificationText, useAppStore } from '../store/appStore';
import { NotificationToast } from './NotificationToast';
import { NotificationCenterPopover } from './StatusBar/NotificationCenterPopover';

const initial = useAppStore.getState();
const repo = (id: string): RepositoryStatus => ({ meta: { id, name: id, rootPath: `/tmp/${id}`, kind: 'git', color: '#888', parentRepoId: null, depth: 0, isWorktree: false, isSubmodule: false }, branch: 'main', revision: 'abc', ahead: 1, behind: 0, files: [], conflicts: 0, operation: null });
const workspace = (id: string, repositories: RepositoryStatus[]): WorkspaceSnapshot => ({ workspace: { id, name: id, paths: ['/tmp/test'], available: true, lastOpenedAt: '' }, repositories, generation: 1, tools: { git: true, svn: true, svnadmin: true } });
afterEach(() => { cleanup(); useAppStore.setState(initial, true); });
function setup(repositories: RepositoryStatus[], id = 'project') {
  const snapshot = workspace(id, repositories);
  useAppStore.setState({ ...initial, snapshot, allRepositories: repositories, activeTabId: id, tabs: [snapshot.workspace], notifications: [], toastNotificationIds: [], notificationCenterOpen: false }, true);
  return snapshot;
}
const message = { key: 'VersionDock [{0}]: {1} unpushed commit ready to push.', args: ['Repository', 1] };
function add() { return useAppStore.getState().addNotification({ type: 'info', title: 'Unpushed Commits', message, actions: [{ type: 'openPush', label: 'Go to Push' }, { type: 'dismiss', label: 'Dismiss' }] }); }

describe('notification repository prefix parity', () => {
  it.each([
    { language: 'zh-CN' as const, expected: 'VersionDock：有 1 个未推送提交，已可推送。' },
    { language: 'en' as const, expected: 'VersionDock: 1 unpushed commit ready to push.' },
  ])('uses the same single-repo message in toast and center in $language', ({ language, expected }) => {
    setup([repo('Repository')]);
    add();
    const t = createTranslator(language);
    const preference = language === 'zh-CN' ? 'zhCn' : 'en';
    const view = render(<I18nContext.Provider value={{ language, preference, t }}><NotificationToast /></I18nContext.Provider>);
    expect(screen.getByText(expected)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t('Go to Push') })).toBeInTheDocument();
    view.unmount();
    render(<I18nContext.Provider value={{ language, preference, t }}><NotificationCenterPopover anchorRect={null} anchorRef={{ current: null }} onClose={() => {}} /></I18nContext.Provider>);
    expect(screen.getByText(expected)).toBeInTheDocument();
  });

  it('retains the name when only one repository in a multi-repo project has outgoing commits', () => {
    setup([repo('Repository'), { ...repo('Other'), ahead: 0 }]);
    add();
    const item = useAppStore.getState().notifications[0];
    expect(item.repositoryCount).toBe(2);
    expect(resolveNotificationText(item.message, createTranslator('en'), item.repositoryCount)).toBe('VersionDock [Repository]: 1 unpushed commit ready to push.');
  });

  it('keeps the source-project formatting after switching to a multi-repo project', () => {
    const original = setup([repo('Repository')]);
    add();
    const next = workspace('other', [repo('One'), repo('Two')]);
    useAppStore.setState({ snapshot: next, allRepositories: next.repositories, activeTabId: 'other', tabs: [original.workspace, next.workspace] });
    render(<I18nContext.Provider value={{ language: 'en', preference: 'en', t: createTranslator('en') }}><NotificationCenterPopover anchorRect={null} anchorRef={{ current: null }} onClose={() => {}} /></I18nContext.Provider>);
    fireEvent.click(screen.getByRole('tab', { name: /All Projects/ }));
    expect(screen.getByText('VersionDock: 1 unpushed commit ready to push.')).toBeInTheDocument();
  });

  it('counts hidden repositories and excludes linked worktrees', () => {
    const visible = repo('Repository'), hidden = repo('Hidden');
    const linked = { ...repo('Worktree'), meta: { ...repo('Worktree').meta, isWorktree: true } };
    const current = setup([visible, linked]);
    add();
    expect(useAppStore.getState().notifications[0].repositoryCount).toBe(1);
    useAppStore.setState({ allRepositories: [visible, hidden, linked], snapshot: { ...current, repositories: [visible] } });
    add();
    expect(useAppStore.getState().notifications[0].repositoryCount).toBe(2);
  });

  it.each([
    ['VersionDock [Repository] Warning: caution', 'VersionDock Warning: caution'],
    ['VersionDock [Repository] 警告：注意', 'VersionDock 警告：注意'],
    ['VersionDock [Repository]: [rejected] push failed', 'VersionDock: [rejected] push failed'],
    ['Git [rejected] push failed', 'Git [rejected] push failed'],
  ])('strips only a redundant branded prefix in %s', (raw, expected) => {
    expect(resolveNotificationText({ raw }, createTranslator('en'), 1)).toBe(expected);
    expect(resolveNotificationText({ raw }, createTranslator('en'), 2)).toBe(raw);
    expect(resolveNotificationText({ raw }, createTranslator('en'))).toBe(raw);
  });
});
