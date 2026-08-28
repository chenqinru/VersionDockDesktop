import type { ScreenPoint } from './tabDrag';
import type { TabDragPayload } from '../platform/bridge';

interface NativePreviewWindow {
  close(): Promise<void>;
  setIgnoreCursorEvents(ignore: boolean): Promise<void>;
  show(): Promise<void>;
}

export class TabDragPreviewWindow {
  private token = 0;
  private preview: NativePreviewWindow | null = null;
  private active = false;

  async prepare(
    drag: Omit<TabDragPayload, 'screenX' | 'screenY'>,
    point: ScreenPoint,
    theme: 'light' | 'dark',
  ): Promise<void> {
    this.active = false;
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return;
    const token = ++this.token;
    const previous = this.preview;
    this.preview = null;
    if (previous) await previous.close().catch(() => undefined);

    try {
      const [{ WebviewWindow }, { invoke }] = await Promise.all([
        import('@tauri-apps/api/webviewWindow'),
        import('@tauri-apps/api/core'),
      ]);
      if (token !== this.token) return;
      const label = `tab-drag-preview-${Date.now()}-${token}`;
      const width = Math.max(110, Math.min(drag.tabWidth, 220));
      const query = new URLSearchParams({ name: drag.tabName, theme });
      const preview = new WebviewWindow(label, {
        url: `tab-drag-preview.html?${query}`,
        x: point.screenX - width / 2,
        y: point.screenY - 14,
        width,
        height: 28,
        decorations: false,
        resizable: false,
        focus: false,
        focusable: false,
        visible: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        shadow: false,
      });
      await new Promise<void>((resolve, reject) => {
        void preview.once('tauri://created', () => resolve());
        void preview.once('tauri://error', ({ payload }) => reject(new Error(String(payload))));
      });
      if (token !== this.token) {
        await preview.close().catch(() => undefined);
        return;
      }
      this.preview = preview;
      await preview.setIgnoreCursorEvents(true);
      await invoke('follow_tab_drag_preview', {
        label,
        tabId: drag.tabId,
        tabName: drag.tabName,
        tabWidth: width,
        paths: drag.paths,
      });
      if (this.active) await preview.show();
    } catch (error) {
      console.warn('Unable to create tab drag preview window', error);
    }
  }

  activate(): void {
    this.active = true;
    if (this.preview) void this.preview.show().catch(() => undefined);
  }

  hide(): void {
    this.token += 1;
    this.active = false;
    const preview = this.preview;
    this.preview = null;
    if (preview) void preview.close().catch(() => undefined);
  }
}
