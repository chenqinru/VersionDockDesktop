import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { BridgeCommand } from '../bindings/generated';
import { useAppStore } from '../store/appStore';
import { isAbortError } from '../platform/bridge';

/** Cancel reads on navigation and keep management errors inside the checkpoint center. */
export function useCheckpointManagement(onBusyChange: (busy: boolean) => void) {
  const bridge = useAppStore(state => state.bridge);
  const controller = useRef<AbortController>();
  const ticket = useRef(0);
  const mounted = useRef(true);
  const busyCallback = useRef(onBusyChange);
  useLayoutEffect(() => { busyCallback.current = onBusyChange; }, [onBusyChange]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; ticket.current += 1; controller.current?.abort(); busyCallback.current(false); }; }, []);
  const request = useCallback(async <T,>(command: BridgeCommand, write = false): Promise<T | undefined> => {
    if (!bridge || !mounted.current) return;
    const version = ++ticket.current;
    controller.current?.abort();
    const current = new AbortController(); controller.current = current;
    setBusy(true); setError(undefined); busyCallback.current(write);
    try {
      const result = await bridge.request<T>(command, { signal: current.signal, showProgress: false, timeoutMs: 600_000 });
      return version === ticket.current ? result : undefined;
    } catch (error) {
      if (version === ticket.current && !isAbortError(error)) setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (version === ticket.current) { controller.current = undefined; setBusy(false); busyCallback.current(false); }
    }
  }, [bridge]);
  return { request, busy, error };
}
