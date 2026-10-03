import { useAppStore } from './store/appStore';
import type { LayoutDensity } from './bindings/generated';

export function useLayoutDensity(): LayoutDensity {
  return useAppStore(state => state.bootstrap?.state.settings?.layoutDensity ?? 'comfortable');
}

// Keep virtual graph rows contiguous; only the outer edges get breathing room.
export function historyDensityMetrics(density: LayoutDensity) {
  const comfortable = density === 'comfortable';
  return { padding: comfortable ? 4 : 0, stripWidth: comfortable ? 4 : 6, stripInset: comfortable ? 4 : 0, labelGap: comfortable ? 4 : 2, blockTrailingGap: comfortable ? 2 : 0 };
}
