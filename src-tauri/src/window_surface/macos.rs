//! Fit the WKWebView through public AppKit APIs. Wry's set_bounds is a no-op
//! for a macOS main webview; it only resizes child webviews on that platform.
use super::{error, DesktopError};
use objc2_app_kit::{NSAutoresizingMaskOptions, NSView, NSViewLayerContentsRedrawPolicy};

/// Called only inside with_webview, on the main thread. No Tauri dispatches
/// from this callback: re-entering the runtime can deadlock its webview locks.
pub(super) fn fit(platform: &tauri::webview::PlatformWebview) -> Result<bool, DesktopError> {
    // WKWebView inherits NSView. The runtime owns it throughout this callback;
    // neither the pointer nor a reference to it escapes the callback.
    let view = unsafe { &*platform.inner().cast::<NSView>() };
    let parent = unsafe { view.superview() }
        .ok_or_else(|| error("WKWebView is detached from its content view"))?;
    let target = parent.bounds();
    if target.size.width <= 0.0 || target.size.height <= 0.0 {
        return Ok(false);
    }
    let mask =
        NSAutoresizingMaskOptions::ViewWidthSizable | NSAutoresizingMaskOptions::ViewHeightSizable;
    if !parent.autoresizesSubviews() {
        parent.setAutoresizesSubviews(true);
    }
    if view.autoresizingMask() != mask {
        view.setAutoresizingMask(mask);
    }
    // Keep AppKit drawing during a live resize rather than retaining the
    // original backing content until the drag finishes. WebKit still owns
    // layout and presentation of the page in its separate content process.
    if view.layerContentsRedrawPolicy() != NSViewLayerContentsRedrawPolicy::DuringViewResize {
        view.setLayerContentsRedrawPolicy(NSViewLayerContentsRedrawPolicy::DuringViewResize);
    }
    if view.frame() != target {
        view.setFrame(target);
        view.setNeedsDisplay(true);
    }
    Ok(view.frame() == parent.bounds())
}
