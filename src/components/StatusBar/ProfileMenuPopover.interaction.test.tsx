import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeCommand, GitIdentityState, RepositoryStatus, SvnAccountState, WorkspaceSnapshot } from '../../bindings/generated';
import { MockBridge, type BridgeEvent } from '../../platform/bridge';
import { BridgeContext } from '../../platform/context';
import { useAppStore } from '../../store/appStore';
import { ProfileStatusBarItem } from './ProfileStatusBarItem';
import { GLOBAL_PROFILE_ID, LOCAL_PROFILE_ID, repositoryPlatforms } from './profileStatus';
import { choiceDialog, confirmDialog, promptDialog } from '../dialogService';

vi.mock('../dialogService', () => ({ promptDialog: vi.fn(), choiceDialog: vi.fn(), confirmDialog: vi.fn(), multiChoiceDialog: vi.fn(), currentDialog: () => undefined }));
const original = useAppStore.getState();
const repo = (id: string, kind: 'git' | 'svn' = 'git'): RepositoryStatus => ({ meta: { id, name: id, rootPath: `/test/${id}`, kind, color: '#888', depth: 0, parentRepoId: null, isSubmodule: false, isWorktree: false }, branch: 'main', revision: 'abc', ahead: 0, behind: 0, files: [], conflicts: 0, operation: null });
const snapshot = (repositories: RepositoryStatus[]): WorkspaceSnapshot => ({ workspace: { id: 'ws', name: 'ws', paths: ['/test'], lastOpenedAt: '', available: true }, repositories, tools: { git: true, svn: true, svnadmin: true }, generation: 1 });
const initial = (): GitIdentityState => ({ profiles: [{ id: 'work', label: 'Work', userName: 'Work Dev', email: 'work@example.test' }], selectedProfileId: null, local: { userName: 'Local Dev', email: 'local@example.test', source: 'local', profileId: null, valid: true }, global: { userName: 'Global Dev', email: 'global@example.test', source: 'global', profileId: null, valid: true }, effective: { userName: 'Local Dev', email: 'local@example.test', source: 'local', profileId: null, valid: true } });
const svn = (): SvnAccountState => ({ repositoryUrl: 'https://svn.example.test/trunk', repositoryRoot: 'https://svn.example.test', username: 'alice', passwordStored: false, passwordStdinSupported: true, secureStorageAvailable: false, connectionOk: null, source: 'session', nativeCredentials: [{ id: 'native', realm: '<https://svn.example.test> QA', username: 'alice' }] });
beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); useAppStore.setState({ ...original, snapshot: snapshot([repo('alpha'), repo('beta')]), selectedRepoId: 'alpha', branchesByRepo: {}, operations: {}, notifications: [], bootstrap: undefined }); });
afterEach(() => { cleanup(); useAppStore.setState(original, true); vi.useRealTimers(); });
function setup(handler?: (command: BridgeCommand) => unknown, configure?: (bridge: MockBridge) => void) {
  let identity = initial();
  const commands: BridgeCommand[] = [];
  const bridge = new MockBridge((command) => {
    commands.push(command);
    if (handler) { const value = handler(command); if (value !== undefined) return value; }
    if (command.type === 'gitIdentity') return identity;
    if (command.type === 'svnAccount' || command.type === 'svnAccountOperation') return svn();
    if (command.type === 'remotes' || command.type === 'providerAccounts') return [];
    if (command.type === 'gitProfileOperation') {
      const operation = command.payload.operation;
      if (operation.type === 'select') {
        const selected = operation.profile_id === GLOBAL_PROFILE_ID ? identity.global! : operation.profile_id === LOCAL_PROFILE_ID ? identity.local! : { userName: 'Work Dev', email: 'work@example.test', source: 'custom' as const, profileId: 'work', valid: true };
        identity = { ...identity, selectedProfileId: operation.profile_id, effective: selected };
      }
      if (operation.type === 'save') identity = { ...identity, profiles: [...identity.profiles.filter((p) => p.id !== operation.profile.id), operation.profile] };
      if (operation.type === 'delete') identity = { ...identity, profiles: identity.profiles.filter((p) => p.id !== operation.profile_id) };
      return identity;
    }
    return true;
  });
  configure?.(bridge);
  render(<BridgeContext.Provider value={bridge}><ProfileStatusBarItem /></BridgeContext.Provider>);
  return commands;
}
async function open() { fireEvent.click(await screen.findByRole('button', { name: /Git: Local Dev/ })); return screen.findByRole('dialog', { name: 'VersionDock — Accounts & Identities: alpha (1/2)' }); }

describe('identity status menu', () => {
  it('ignores passive remote reads and refreshes after a real remote mutation', async () => {
    let listener: ((event: BridgeEvent) => void) | undefined;
    const commands = setup(undefined, (bridge) => { bridge.subscribe = (handler) => { listener = handler; return () => { listener = undefined; }; }; });
    await screen.findByRole('button', { name: /Git: Local Dev/ });
    const event = { operationId: 'remote', context: { workspaceId: 'ws', repositoryId: 'alpha', domain: 'remote' as const, visibility: 'background' as const, target: null, generation: 1 }, status: 'succeeded' as const, phase: 'remote', message: '', startedAt: '', cancellable: false, completed: null, total: null, error: null };
    const before = commands.filter((command) => command.type === 'gitIdentity').length;
    await act(async () => { listener?.(event); });
    expect(commands.filter((command) => command.type === 'gitIdentity')).toHaveLength(before);
    await act(async () => { listener?.({ ...event, context: { ...event.context, visibility: 'foreground' } }); });
    await waitFor(() => expect(commands.filter((command) => command.type === 'gitIdentity')).toHaveLength(before + 2));
  });

  it('keeps the bottom anchor, searches credentials and opens profile actions with keyboard', async () => {
    setup(); const menu = await open();
    expect(menu.style.bottom).toBe('28px');
    fireEvent.change(within(menu).getByRole('combobox'), { target: { value: 'work@example.test' } });
    expect(within(menu).queryByText('Local')).not.toBeInTheDocument();
    expect(within(menu).getByText('Work')).toBeInTheDocument();
    fireEvent.keyDown(within(menu).getByRole('combobox'), { key: 'ArrowDown' });
    fireEvent.keyDown(within(menu).getByRole('combobox'), { key: 'Enter' });
    const actions = screen.getByRole('dialog', { name: 'Profile: Work' });
    expect(within(actions).getByText('Edit…')).toBeInTheDocument();
    expect(within(actions).getByText('Delete')).toBeInTheDocument();
    fireEvent.keyDown(within(actions).getByRole('combobox'), { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Profile: Work' })).not.toBeInTheDocument();
    expect(within(menu).getByRole('combobox')).toHaveFocus();
  });
  it.each([['Local', LOCAL_PROFILE_ID], ['Global', GLOBAL_PROFILE_ID]])('selects %s explicitly rather than auto mode and refreshes the status', async (label, id) => {
    const commands = setup(); const menu = await open();
    fireEvent.click(within(menu).getByRole('option', { name: new RegExp(`^${label} `) }));
    fireEvent.click(screen.getByText('Use for this workspace'));
    await waitFor(() => expect(commands).toContainEqual({ type: 'gitProfileOperation', payload: { workspace_id: 'ws', repo_id: 'alpha', operation: { type: 'select', profile_id: id } } }));
    expect(await screen.findByRole('button', { name: new RegExp(`Git: ${label} Dev`) })).toBeInTheDocument();
  });
  it('creates then optionally activates a profile, and edits the existing id', async () => {
    const commands = setup(); const menu = await open();
    vi.mocked(promptDialog).mockResolvedValueOnce('Personal').mockResolvedValueOnce('Ada').mockResolvedValueOnce('ada@example.test');
    vi.mocked(choiceDialog).mockResolvedValue('yes');
    fireEvent.click(within(menu).getByText('New Profile…'));
    await waitFor(() => expect(commands.some((command) => command.type === 'gitProfileOperation' && command.payload.operation.type === 'save' && command.payload.operation.profile.label === 'Personal')).toBe(true));
    await waitFor(() => expect(commands.filter((command) => command.type === 'gitProfileOperation').length).toBe(2));
    await screen.findByText('Personal');
    fireEvent.click(screen.getByText('Work'));
    vi.mocked(promptDialog).mockResolvedValueOnce('Office').mockResolvedValueOnce('Updated').mockResolvedValueOnce('updated@example.test');
    fireEvent.click(screen.getByText('Edit…'));
    await waitFor(() => expect(commands).toContainEqual({ type: 'gitProfileOperation', payload: { workspace_id: 'ws', repo_id: 'alpha', operation: { type: 'save', profile: { id: 'work', label: 'Office', userName: 'Updated', email: 'updated@example.test' } } } }));
  });
  it('requires deletion confirmation and retains the profile on cancel', async () => {
    const commands = setup(); await open(); fireEvent.click(screen.getByText('Work'));
    vi.mocked(confirmDialog).mockResolvedValue(false); fireEvent.click(screen.getByText('Delete'));
    await waitFor(() => expect(confirmDialog).toHaveBeenCalledOnce());
    expect(commands.some((command) => command.type === 'gitProfileOperation')).toBe(false);
    vi.mocked(confirmDialog).mockResolvedValue(true); fireEvent.click(screen.getByText('Delete'));
    await waitFor(() => expect(commands.some((command) => command.type === 'gitProfileOperation' && command.payload.operation.type === 'delete')).toBe(true));
    await waitFor(() => expect(screen.queryByText('Work')).not.toBeInTheDocument());
  });
  it('switches identity context without changing repository selection or exposing worktrees', async () => {
    useAppStore.setState({ snapshot: snapshot([repo('alpha'), repo('beta'), { ...repo('worktree'), meta: { ...repo('worktree').meta, isWorktree: true } }]) });
    setup(); await open(); fireEvent.click(screen.getByText('Switch to another repository…'));
    const menu = screen.getByRole('dialog', { name: 'VersionDock — Version Control Accounts' });
    expect(within(menu).queryByText('worktree')).not.toBeInTheDocument();
    fireEvent.change(within(menu).getByRole('combobox'), { target: { value: '/test/beta' } });
    fireEvent.click(within(menu).getByText('beta'));
    expect(screen.getByRole('dialog', { name: 'VersionDock — Accounts & Identities: beta (2/2)' })).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'VersionDock — Accounts & Identities: beta (2/2)' }).parentElement).toBe(document.body);
    expect(useAppStore.getState().selectedRepoId).toBe('alpha');
  });
  it('toggles from the anchor and closes on external click and blur', async () => {
    setup(); await open(); const anchor = screen.getByRole('button', { name: /Git: Local Dev/ });
    fireEvent.pointerDown(anchor); fireEvent.click(anchor);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(anchor); fireEvent.pointerDown(document.body); expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(anchor); fireEvent(window, new Event('blur')); expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('shows failures, permits retry, and does not apply a cancelled dialog to another workspace', async () => {
    let fail = true;
    const commands = setup((command) => { if (command.type === 'gitIdentity' && fail) throw new Error('Identity read failed'); });
    fireEvent.click(screen.getByRole('button', { name: /Git:/ })); await screen.findByRole('alert');
    fail = false; fireEvent.click(screen.getByText('Retry')); await screen.findByText('Work');
    let resolve: (value: string) => void = () => undefined;
    vi.mocked(promptDialog).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    fireEvent.click(screen.getByText('New Profile…'));
    act(() => useAppStore.setState({ snapshot: { ...snapshot([repo('alpha')]), workspace: { ...snapshot([]).workspace, id: 'other' } } }));
    await act(async () => { resolve('Stale'); });
    expect(commands.some((command) => command.type === 'gitProfileOperation')).toBe(false);
  });
  it('shows all SVN actions, masks passwords, and offers session-only authentication without requiring keychain', async () => {
    useAppStore.setState({ snapshot: snapshot([repo('assets', 'svn')]), selectedRepoId: 'assets' });
    const commands = setup(); fireEvent.click(await screen.findByRole('button', { name: /SVN: alice/ }));
    for (const label of ['Repository URL', 'Re-authenticate…', 'Forget Session Credentials', 'Clear Cached SVN Credentials…', 'Test SVN Connection']) expect(await screen.findByText(label)).toBeInTheDocument();
    vi.mocked(promptDialog).mockResolvedValueOnce('bob').mockResolvedValueOnce('password'); vi.mocked(choiceDialog).mockResolvedValue('session');
    fireEvent.click(screen.getByText('Switch SVN Account…'));
    await waitFor(() => expect(commands).toContainEqual({ type: 'svnAccountOperation', payload: { workspace_id: 'ws', repo_id: 'assets', operation: { type: 'switch', username: 'bob', password: 'password', remember: false } } }));
    expect(vi.mocked(promptDialog).mock.calls[1][0].inputType).toBe('password');
  });
  it('retains cached credentials when clear confirmation is cancelled', async () => {
    useAppStore.setState({ snapshot: snapshot([repo('assets', 'svn')]), selectedRepoId: 'assets' });
    const commands = setup(); fireEvent.click(await screen.findByRole('button', { name: /SVN: alice/ }));
    vi.mocked(confirmDialog).mockResolvedValue(false); fireEvent.click(await screen.findByText('Clear Cached SVN Credentials…'));
    await waitFor(() => expect(confirmDialog).toHaveBeenCalledOnce()); expect(commands.some((command) => command.type === 'svnAccountOperation')).toBe(false);
  });
  it('shows remote account status on hover and clears the real avatar cache', async () => {
    const clear = vi.fn(); window.addEventListener('versiondock-avatar-cache-clear', clear);
    setup(); const anchor = await screen.findByRole('button', { name: /Git: Local Dev/ });
    fireEvent.mouseEnter(anchor); const tooltip = await screen.findByRole('tooltip');
    expect(within(tooltip).getByText('local@example.test')).toBeInTheDocument(); expect(within(tooltip).getAllByText('Not connected')).toHaveLength(3);
    fireEvent.click(anchor); fireEvent.click(await screen.findByText('Clear Avatar Cache')); expect(clear).toHaveBeenCalledOnce();
    window.removeEventListener('versiondock-avatar-cache-clear', clear);
  });
  it('keeps the identity tooltip available when focusing its manage action', async () => {
    setup();
    const anchor = await screen.findByRole('button', { name: /Git: Local Dev/ });
    fireEvent.mouseEnter(anchor);
    const tooltip = await screen.findByRole('tooltip');
    const manage = within(tooltip).getByRole('button', { name: 'Click to manage accounts and identities' });
    fireEvent.blur(anchor, { relatedTarget: manage });
    expect(tooltip).toBeInTheDocument();
    fireEvent.click(manage);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it.each([100, 500])('dismisses identity help after %s ms and does not flash on focus return', async (elapsed) => {
    setup();
    const anchor = await screen.findByRole('button', { name: /Git: Local Dev/ });
    vi.useFakeTimers();
    try {
      fireEvent.mouseEnter(anchor);
      act(() => vi.advanceTimersByTime(elapsed));
      expect(Boolean(screen.queryByRole('tooltip'))).toBe(elapsed === 500);
      fireEvent.pointerDown(anchor);
      fireEvent.focus(anchor);
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
      act(() => vi.advanceTimersByTime(600));
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
      fireEvent.click(anchor);
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(anchor).toHaveFocus();
      act(() => vi.advanceTimersByTime(600));
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
      fireEvent.mouseLeave(anchor);
      fireEvent.mouseEnter(anchor);
      act(() => vi.advanceTimersByTime(500));
      expect(screen.getByRole('tooltip')).toBeInTheDocument();
    } finally { vi.useRealTimers(); }
  });

  it('supports profile management before repository discovery', async () => {
    useAppStore.setState({ snapshot: snapshot([]), selectedRepoId: undefined });
    const commands = setup(); fireEvent.click(await screen.findByRole('button', { name: /Git: Local Dev/ }));
    expect(await screen.findByText('New Profile…')).toBeInTheDocument();
    expect(commands).toContainEqual({ type: 'gitIdentity', payload: { workspace_id: 'ws', repo_id: '' } });
  });
});

describe('repository platform matching', () => {
  it('prioritizes upstream over origin and matches configured enterprise hosts without substring collisions', () => {
    const remotes = [{ name: 'origin', fetchUrl: 'git@github.com:org/repo.git', pushUrl: '' }, { name: 'work', fetchUrl: 'ssh://git@code.example.test:2222/org/repo.git', pushUrl: '' }, { name: 'wrong', fetchUrl: 'https://code.example.test.attacker.test/repo', pushUrl: '' }];
    const branches = [{ name: 'main', current: true, remote: false, upstream: 'work/main', ahead: 0, behind: 0, lastCommitMessage: null, lastCommitDate: null }];
    const platforms = repositoryPlatforms(remotes, branches, [{ id: 'account', provider: 'gitlab', host: 'https://code.example.test', login: 'ada', displayName: null, secureStorageRef: 'ref' }]);
    expect(platforms.find((item) => item.primary)?.provider).toBe('gitlab'); expect(platforms.find((item) => item.remote.name === 'origin')?.provider).toBe('github'); expect(platforms.find((item) => item.remote.name === 'wrong')?.provider).toBeUndefined();
  });
});
