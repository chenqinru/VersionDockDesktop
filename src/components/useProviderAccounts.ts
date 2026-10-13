import { useEffect, useState } from 'react';
import type { RemoteProviderAccount } from '../bindings/generated';
import { useBridge } from '../platform/context';
import { PROVIDER_ACCOUNTS_CHANGED } from './StatusBar/profileStatus';

export function useProviderAccounts() {
  const bridge = useBridge();
  const [accounts, setAccounts] = useState<RemoteProviderAccount[]>([]);
  useEffect(() => {
    let controller: AbortController | undefined;
    const load = () => {
      controller?.abort();
      const request = new AbortController();
      controller = request;
      void bridge.request<RemoteProviderAccount[]>({ type: 'providerAccounts' }, { signal: request.signal, showProgress: false })
        .then(values => { if (!request.signal.aborted && Array.isArray(values)) setAccounts(values); })
        .catch(() => undefined);
    };
    load();
    window.addEventListener(PROVIDER_ACCOUNTS_CHANGED, load);
    window.addEventListener('focus', load);
    return () => {
      controller?.abort();
      window.removeEventListener(PROVIDER_ACCOUNTS_CHANGED, load);
      window.removeEventListener('focus', load);
    };
  }, [bridge]);
  return accounts;
}
