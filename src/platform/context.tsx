import { createContext, useContext } from 'react';
import type { VersionDockBridge } from './bridge';

export const BridgeContext = createContext<VersionDockBridge | null>(null);

export function useBridge(): VersionDockBridge {
  const bridge = useContext(BridgeContext);
  if (!bridge) throw new Error('VersionDockBridge is not available');
  return bridge;
}
