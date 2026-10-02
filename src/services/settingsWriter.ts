import type { DesktopSettings, SettingsUpdateResult } from '../bindings/generated';

type PendingSave = { patch: Partial<DesktopSettings>; resolve: () => void };

/** Serializes saves while keeping later optimistic choices over older responses. */
export class SettingsWriter {
  private pending: PendingSave[] = [];
  private saving = false;
  constructor(
    private confirmed: DesktopSettings,
    private save: (settings: DesktopSettings, fields: Array<keyof DesktopSettings>) => Promise<SettingsUpdateResult>,
    private changed: (settings: DesktopSettings) => void,
    private saved: (result: SettingsUpdateResult) => Promise<void>,
    private failed: (error: unknown) => void,
  ) {}

  update(patch: Partial<DesktopSettings>): Promise<void> {
    const promise = new Promise<void>((resolve) => this.pending.push({ patch, resolve }));
    this.publish();
    void this.flush();
    return promise;
  }

  private publish() {
    this.changed(Object.assign({}, this.confirmed, ...this.pending.map((entry) => entry.patch)));
  }

  private async flush() {
    if (this.saving) return;
    this.saving = true;
    while (this.pending.length) {
      const batch = this.pending.slice();
      const patch: Partial<DesktopSettings> = Object.assign({}, ...batch.map((entry) => entry.patch));
      let result: SettingsUpdateResult | undefined;
      try {
        result = await this.save({ ...this.confirmed, ...patch }, Object.keys(patch) as Array<keyof DesktopSettings>);
        this.confirmed = result.settings;
      } catch (error) {
        this.failed(error);
      }
      this.pending.splice(0, batch.length);
      this.publish();
      if (result) {
        try { await this.saved(result); } catch (error) { this.failed(error); }
      }
      batch.forEach((entry) => entry.resolve());
    }
    this.saving = false;
  }
}
