import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RepositoryCheckoutDialog } from './RepositoryCheckoutDialog';
import { BridgeContext } from '../platform/context';
import { MockBridge } from '../platform/bridge';
import { useAppStore } from '../store/appStore';

const originalClone = useAppStore.getState().cloneRepository;
afterEach(() => { cleanup(); useAppStore.setState({ cloneRepository: originalClone, operations: {} }); });
const account = { id: 'account', provider: 'gitlab', host: 'https://gitlab.com', login: 'ada', displayName: null, secureStorageRef: 'test' };
const repository = { id: '1', provider: 'gitlab', host: 'https://gitlab.com', name: 'secret', fullName: 'ada/secret', cloneUrl: 'https://gitlab.com/ada/secret.git', private: true, defaultBranch: 'main', namespace: null, webUrl: null };

function mount(handler: ConstructorParameters<typeof MockBridge>[0]) {
  const close = vi.fn();
  render(<BridgeContext.Provider value={new MockBridge(handler)}><RepositoryCheckoutDialog kind="git" defaultParent="/tmp/repos" close={close} /></BridgeContext.Provider>);
  return close;
}

describe('RepositoryCheckoutDialog', () => {
  it('clones a selected private repository with its account in the same dialog', async () => {
    const clone = vi.fn(async () => true);
    useAppStore.setState({ cloneRepository: clone, operations: {} });
    const close = mount(command => command.type === 'providerAccounts' ? [account] : command.type === 'providerRepositories' ? { items: [repository], page: 1, hasMore: false } : []);
    fireEvent.click(screen.getByRole('tab', { name: 'Remote Accounts' }));
    fireEvent.click(await screen.findByText('ada/secret'));
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByLabelText('Folder name')).toHaveValue('secret');
    fireEvent.click(screen.getByLabelText('Open in New Window'));
    fireEvent.click(screen.getByRole('button', { name: 'Clone' }));
    await waitFor(() => expect(clone).toHaveBeenCalledWith(repository.cloneUrl, '/tmp/repos', 'secret', true, 'account', expect.any(Function)));
    expect(close).toHaveBeenCalledOnce();
  });

  it('connects an account inline and resumes browsing without losing destination fields', async () => {
    let connected = false;
    const requests = vi.fn(command => {
      if (command.type === 'providerAccounts') return connected ? [account] : [];
      if (command.type === 'providerGitlabSave') { connected = true; return account; }
      if (command.type === 'providerRepositories') return { items: [repository], page: 1, hasMore: false };
      return [];
    });
    mount(requests);
    fireEvent.change(screen.getByLabelText('Parent folder'), { target: { value: '/tmp/custom' } });
    fireEvent.click(screen.getByRole('tab', { name: 'Remote Accounts' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add GitLab Account' }));
    fireEvent.change(screen.getByPlaceholderText('glpat-...'), { target: { value: 'test-only-token' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    fireEvent.click(await screen.findByText('ada/secret'));
    expect(screen.getByLabelText('Parent folder')).toHaveValue('/tmp/custom');
    expect(screen.queryByPlaceholderText('glpat-...')).toBeNull();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
  });

  it('clears the selected account on URL edits and retains the form on clone failure', async () => {
    const clone = vi.fn(async () => false);
    useAppStore.setState({ cloneRepository: clone, operations: {} });
    const close = mount(command => command.type === 'providerAccounts' ? [account] : command.type === 'providerRepositories' ? { items: [repository], page: 1, hasMore: false } : []);
    fireEvent.click(screen.getByRole('tab', { name: 'Remote Accounts' }));
    fireEvent.click(await screen.findByText('ada/secret'));
    fireEvent.change(screen.getByLabelText('Git URL'), { target: { value: 'git@example.test:other.git' } });
    expect(screen.getByRole('button', { name: 'Clone' })).toBeDisabled();
    fireEvent.click(screen.getByRole('tab', { name: 'Repository URL' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clone' }));
    await waitFor(() => expect(clone).toHaveBeenCalledWith('git@example.test:other.git', '/tmp/repos', 'other', false, undefined, expect.any(Function)));
    expect(close).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Git URL')).toHaveValue('git@example.test:other.git');
  });

  it('locks fields and avoids duplicate clones while the request is running', async () => {
    let finish!: (value: boolean) => void;
    const clone = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; }));
    useAppStore.setState({ cloneRepository: clone, operations: {} });
    mount(() => []);
    fireEvent.change(screen.getByLabelText('Git URL'), { target: { value: repository.cloneUrl } });
    fireEvent.click(screen.getByRole('button', { name: 'Clone' }));
    expect(screen.getByLabelText('Parent folder')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Clone' }));
    expect(clone).toHaveBeenCalledOnce();
    finish(false);
    await waitFor(() => expect(screen.getByLabelText('Parent folder')).not.toBeDisabled());
  });

  it('cancels inline authorization and preserves the destination', async () => {
    mount(() => []);
    fireEvent.click(screen.getByRole('tab', { name: 'Remote Accounts' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add Gitee Account' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Cancel' })[0]);
    expect(screen.queryByText('Gitee Personal Access Token requires the projects and user_info scopes.')).toBeNull();
    expect(screen.getByLabelText('Parent folder')).toHaveValue('/tmp/repos');
  });
});
