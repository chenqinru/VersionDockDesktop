import { describe, expect, it } from 'vitest';
import { MockBridge } from './bridge';

describe('VersionDockBridge', () => {
  it('keeps components independent from native command names', async () => {
    const bridge = new MockBridge((command) => command.type === 'bootstrap' ? { ok: true } : null);
    await expect(bridge.request({ type: 'bootstrap' })).resolves.toEqual({ ok: true });
    bridge.setState({ panel: 360 });
    expect(bridge.getState()).toEqual({ panel: 360 });
  });
});
