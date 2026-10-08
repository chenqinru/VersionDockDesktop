import type { ScreenPoint } from './tabDrag';
import type { TabDragPayload } from '../platform/bridge';
import { getProjectInitials, getProjectColor } from '../components/projectIconUtils';
import type { BackgroundThrottlingPolicy } from '@tauri-apps/api/window';

interface NativePreviewWindow {
  close(): Promise<void>;
  show(): Promise<void>;
  hide(): Promise<void>;
}

export class TabDragPreviewWindow {
  private token = 0;
  private preview: NativePreviewWindow | null = null;
  private active = false;
  private ready = false;

  get tracking(): boolean {
    return this.active && this.ready;
  }

  async prepare(
    drag: Omit<TabDragPayload, 'screenX' | 'screenY'>,
    point: ScreenPoint,
    theme: 'light' | 'dark',
  ): Promise<void> {
    this.active = false;
    this.ready = false;
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return;
    const token = ++this.token;
    const previous = this.preview;
    this.preview = null;
    if (previous) await previous.close().catch(() => undefined);

    let candidate: NativePreviewWindow | null = null;
    let unlistenReady: (() => void) | undefined;
    let readyTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const [{ WebviewWindow }, { invoke }, { listen }] = await Promise.all([
        import('@tauri-apps/api/webviewWindow'),
        import('@tauri-apps/api/core'),
        import('@tauri-apps/api/event'),
      ]);
      if (token !== this.token) return;
      const label = `tab-drag-preview-${Date.now()}-${token}`;
      const width = Math.max(110, Math.min(drag.tabWidth, 220));
      const seed = drag.paths[0] || drag.tabName;
      const initials = getProjectInitials(drag.tabName);
      const color = getProjectColor(seed);
      const readyEvent = `versiondock://tab-preview-ready-${Date.now()}-${token}`;
      let markReady: () => void = () => undefined;
      const pageReady = new Promise<void>((resolve, reject) => {
        markReady = resolve;
        readyTimeout = setTimeout(() => reject(new Error('Tab preview did not become ready')), 5_000);
      });
      void pageReady.catch(() => undefined);
      unlistenReady = await listen(readyEvent, markReady);
      if (token !== this.token) return;
      const query = new URLSearchParams({
        name: drag.tabName,
        theme,
        initials,
        color,
        readyEvent,
        source: drag.sourceWindowLabel,
      });
      const preview = new WebviewWindow(label, {
        url: `tab-drag-preview.html?${query}`,
        x: point.screenX - width / 2,
        y: point.screenY - 14,
        width,
        height: 28,
        transparent: false,
        decorations: false,
        resizable: false,
        focus: false,
        focusable: false,
        visible: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        shadow: false,
        backgroundColor: theme === 'light' ? [243, 243, 243, 255] : [37, 37, 38, 255],
        backgroundThrottling: 'disabled' as BackgroundThrottlingPolicy,
      });
      candidate = preview;
      await new Promise<void>((resolve, reject) => {
        void preview.once('tauri://created', () => resolve());
        void preview.once('tauri://error', ({ payload }) => reject(new Error(String(payload))));
      });
      if (token !== this.token) {
        await preview.close().catch(() => undefined);
        return;
      }
      this.preview = preview;
      await pageReady;
      if (token !== this.token) {
        await preview.close().catch(() => undefined);
        return;
      }
      // The backend prepares cursor passthrough before tracking; Linux must
      // first realize the hidden GTK surface to avoid Tao's native panic.
      await invoke('follow_tab_drag_preview', {
        label,
        tabId: drag.tabId,
        tabName: drag.tabName,
        tabWidth: width,
        paths: drag.paths,
      });
      if (token !== this.token) {
        await preview.close().catch(() => undefined);
        return;
      }
      this.ready = true;
      if (this.active) await preview.show();
    } catch (error) {
      if (candidate) await candidate.close().catch(() => undefined);
      if (this.preview === candidate) this.preview = null;
      if (token === this.token) console.warn('Unable to create tab drag preview window', error);
    } finally {
      if (readyTimeout) clearTimeout(readyTimeout);
      unlistenReady?.();
    }
  }

  activate(): void {
    this.active = true;
    if (this.preview && this.ready) void this.preview.show().catch(() => undefined);
  }

  async deactivate(): Promise<void> {
    this.active = false;
    if (this.preview) await this.preview.hide().catch(() => undefined);
  }

  hide(): void {
    this.token += 1;
    this.active = false;
    this.ready = false;
    const preview = this.preview;
    this.preview = null;
    if (preview) void preview.close().catch(() => undefined);
  }
}
