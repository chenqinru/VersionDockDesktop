import type { LayoutState, LayoutUpdateResult } from '../bindings/generated';

export type LayoutPatch = Partial<Omit<LayoutState, 'panelSizes'>> & { panelSizes?: Partial<LayoutState['panelSizes']> };
export function mergeLayout(layout: LayoutState, patch: LayoutPatch): LayoutState {
  return { ...layout, ...patch, panelSizes: { ...layout.panelSizes, ...patch.panelSizes } };
}
export function layoutPatch(previous: LayoutState, next: LayoutState): LayoutPatch {
  const patch: LayoutPatch = {};
  for (const key of Object.keys(next) as Array<keyof LayoutState>) {
    if (key === 'panelSizes') {
      for (const size of ['commit', 'branches', 'detail'] as const) {
        if (previous.panelSizes[size] !== next.panelSizes[size]) patch.panelSizes = { ...patch.panelSizes, [size]: next.panelSizes[size] };
      }
    } else if (JSON.stringify(previous[key]) !== JSON.stringify(next[key])) Object.assign(patch, { [key]: next[key] });
  }
  return patch;
}
export function layoutFields(patch: LayoutPatch): string[] {
  return Object.keys(patch).flatMap(key => key === 'panelSizes' ? Object.keys(patch.panelSizes ?? {}).map(size => `panelSizes.${size}`) : [key]);
}

/** Debounces drag updates, serializes writes, and overlays unsaved local choices on broadcasts. */
export class LayoutWriter {
  private pending: LayoutPatch[] = [];
  private inflight: LayoutPatch[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private saving?: Promise<void>;
  private revision = -1;
  private resetGeneration = 0;
  private disposed = false;
  constructor(
    private confirmed: LayoutState,
    private save: (layout: LayoutState, fields: string[]) => Promise<unknown>,
    private changed: (layout: LayoutState) => void,
    private failed: (error: unknown) => void,
  ) {}
  update(patch: LayoutPatch, debounce = true) {
    if (this.disposed || !layoutFields(patch).length) return;
    this.pending.push(patch);
    this.publish();
    clearTimeout(this.timer);
    if (!debounce) { void this.flush(); return; }
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, 180);
  }
  receive(update: LayoutUpdateResult) {
    if (this.disposed || update.revision <= this.revision) return;
    this.revision = update.revision;
    this.confirmed = update.layout;
    if (update.reset) { this.resetGeneration++; this.pending = []; this.inflight = []; clearTimeout(this.timer); this.timer = undefined; }
    this.publish();
  }
  private publish() {
    if (!this.disposed) this.changed([...this.inflight, ...this.pending].reduce(mergeLayout, this.confirmed));
  }
  async flush(): Promise<void> {
    clearTimeout(this.timer); this.timer = undefined;
    if (this.saving) { await this.saving; if (this.pending.length) await this.flush(); return; }
    if (this.disposed || !this.pending.length) return;
    const run = async () => {
      while (!this.disposed && this.pending.length) {
        const batch = this.pending.splice(0); this.inflight = batch;
        const next = batch.reduce(mergeLayout, this.confirmed);
        const fields = [...new Set(batch.flatMap(layoutFields))];
        const beforeReset = this.resetGeneration;
        const beforeRevision = this.revision;
        try {
          await this.save(next, fields);
          if (beforeReset === this.resetGeneration && beforeRevision === this.revision) this.confirmed = batch.reduce(mergeLayout, this.confirmed);
        }
        catch (error) { if (!this.disposed) this.failed(error); }
        finally { this.inflight = []; this.publish(); }
      }
    };
    this.saving = run();
    await this.saving; this.saving = undefined;
  }
  dispose() { this.disposed = true; clearTimeout(this.timer); this.pending = []; }
}
