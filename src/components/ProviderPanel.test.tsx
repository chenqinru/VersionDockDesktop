import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderPanel } from './ProviderPanel';
import { BridgeContext } from '../platform/context';
import { MockBridge } from '../platform/bridge';

afterEach(cleanup);
describe('ProviderPanel', () => {
  it('returns a paged private repository to the unified clone flow', async () => {
    const selected = vi.fn();
    const bridge = new MockBridge((command) => {
      if (command.type === 'providerAccounts') return [{ id: 'account', provider: 'gitlab', host: 'https://gitlab.com', login: 'ada', displayName: 'Ada', secureStorageRef: 'ref' }];
      if (command.type === 'providerRepositories') return { items: [{ id: '1', provider: 'gitlab', host: 'https://gitlab.com', name: 'secret', fullName: 'ada/secret', cloneUrl: 'https://gitlab.com/ada/secret.git', webUrl: null, defaultBranch: 'main', namespace: null, private: true }], page: 1, hasMore: false };
      return [];
    });
    render(<BridgeContext.Provider value={bridge}><ProviderPanel mode="browse" close={vi.fn()} onClone={selected} /></BridgeContext.Provider>);
    await screen.findByText('ada/secret');
    fireEvent.click(screen.getByText('ada/secret'));
    await waitFor(() => expect(selected).toHaveBeenCalledWith(expect.objectContaining({ cloneUrl: 'https://gitlab.com/ada/secret.git', private: true }), 'account'));
  });
});
