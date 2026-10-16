//! Fit the WKWebView through public AppKit APIs. Wry's set_bounds is a no-op
//! for a macOS main webview; it only resizes child webviews on that platform.
use super::{error, DesktopError};
use block2::RcBlock;
use objc2::{
    rc::{Retained, Weak},
    runtime::ProtocolObject,
};
use objc2_app_kit::{NSAutoresizingMaskOptions, NSView, NSViewLayerContentsRedrawPolicy};
use objc2_foundation::{NSNotificationCenter, NSObjectProtocol, NSString};
use objc2_web_kit::WKWebView;
use std::{cell::RefCell, collections::HashMap};
use tauri::{Emitter, Manager, WebviewWindow};

struct FullscreenObservers {
    center: Retained<NSNotificationCenter>,
    tokens: Vec<Retained<ProtocolObject<dyn NSObjectProtocol>>>,
}

impl Drop for FullscreenObservers {
    fn drop(&mut self) {
        for token in &self.tokens {
            // These are the exact tokens registered below. The thread-local
            // registry is installed and removed only on AppKit's main thread.
            unsafe { self.center.removeObserver((**token).as_ref()) };
        }
    }
}

thread_local! {
    static FULLSCREEN_OBSERVERS: RefCell<HashMap<String, FullscreenObservers>> = RefCell::default();
}

pub(super) fn forget(label: &str) {
    FULLSCREEN_OBSERVERS.with(|entries| {
        entries.borrow_mut().remove(label);
    });
}

/// Restore the traffic-light inset before the exit animation starts. Waiting
/// for Tao's final resize/isFullscreen query leaves tabs underneath the buttons.
pub(super) fn observe_fullscreen(
    platform: &tauri::webview::PlatformWebview,
    window: &WebviewWindow,
) {
    use objc2_app_kit::{
        NSWindow, NSWindowDidEnterFullScreenNotification, NSWindowDidExitFullScreenNotification,
        NSWindowWillEnterFullScreenNotification, NSWindowWillExitFullScreenNotification,
    };
    FULLSCREEN_OBSERVERS.with(|entries| {
        let mut entries = entries.borrow_mut();
        if entries.contains_key(window.label()) {
            return;
        }
        let native = unsafe { &*platform.ns_window().cast::<NSWindow>() };
        let webview = unsafe { &*platform.inner().cast::<WKWebView>() };
        let center = NSNotificationCenter::defaultCenter();
        let mut tokens = Vec::new();
        // Keep the inset during entry; remove it only after entry completes.
        // This also keeps rapid enter/exit transitions in native event order.
        for (name, fullscreen) in unsafe {
            [
                (NSWindowWillEnterFullScreenNotification, false),
                (NSWindowDidEnterFullScreenNotification, true),
                (NSWindowWillExitFullScreenNotification, false),
                (NSWindowDidExitFullScreenNotification, false),
            ]
        } {
            let app = window.app_handle().clone();
            let label = window.label().to_owned();
            let view = Weak::from(webview);
            let block = RcBlock::new(move |_| {
                // Tao's user-event queue can pause during AppKit's fullscreen
                // animation. Submit this visual update directly to WebKit,
                // then reconcile React's state through the normal event path.
                if let Some(view) = view.load() {
                    let script = NSString::from_str(if fullscreen {
                        "document.documentElement.setAttribute('data-versiondock-native-fullscreen','true')"
                    } else {
                        "document.documentElement.setAttribute('data-versiondock-native-fullscreen','false')"
                    });
                    unsafe { view.evaluateJavaScript_completionHandler(&script, None) };
                }
                let _ = app.emit_to(&label, "versiondock://window-fullscreen", fullscreen);
            });
            tokens.push(unsafe {
                center.addObserverForName_object_queue_usingBlock(
                    Some(name),
                    Some(native),
                    None,
                    &block,
                )
            });
        }
        entries.insert(
            window.label().to_owned(),
            FullscreenObservers { center, tokens },
        );
    });
}

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
