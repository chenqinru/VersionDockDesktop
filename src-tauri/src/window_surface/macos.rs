//! Fit the WKWebView through public AppKit APIs. Wry's set_bounds is a no-op
//! for a macOS main webview; it only resizes child webviews on that platform.
use super::{error, DesktopError};
use block2::RcBlock;
use objc2::{
    rc::{Retained, Weak},
    runtime::ProtocolObject,
    MainThreadOnly,
};
use objc2_app_kit::{NSAutoresizingMaskOptions, NSView, NSViewLayerContentsRedrawPolicy, NSWindow};
use objc2_foundation::{
    NSDate, NSDefaultRunLoopMode, NSNotificationCenter, NSObjectProtocol, NSRunLoop, NSString,
};
use objc2_web_kit::{WKContentWorld, WKWebView};
use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    rc::Rc,
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager, WebviewWindow};

mod live_resize;
use live_resize::LiveResize;

struct WindowObservers {
    native: Weak<NSWindow>,
    center: Retained<NSNotificationCenter>,
    tokens: Vec<Retained<ProtocolObject<dyn NSObjectProtocol>>>,
    resize: Rc<LiveResize>,
}

impl Drop for WindowObservers {
    fn drop(&mut self) {
        self.resize.cancel();
        for token in &self.tokens {
            // These are the exact tokens registered below. The thread-local
            // registry is installed and removed only on AppKit's main thread.
            unsafe { self.center.removeObserver((**token).as_ref()) };
        }
    }
}

thread_local! {
    static WINDOW_OBSERVERS: RefCell<HashMap<String, WindowObservers>> = RefCell::default();
}

pub(super) fn forget(label: &str) {
    WINDOW_OBSERVERS.with(|entries| {
        entries.borrow_mut().remove(label);
    });
}

pub(super) fn is_presenting(label: &str) -> bool {
    WINDOW_OBSERVERS.with(|entries| {
        entries.borrow().get(label).is_some_and(|entry| {
            entry.resize.presenting()
                && entry
                    .native
                    .load()
                    .is_some_and(|window| window.inLiveResize())
        })
    })
}

/// Observe AppKit directly: live-resize presentation and the traffic-light inset
/// must update before Tao's deferred resize/fullscreen events reach the page.
pub(super) fn observe(platform: &tauri::webview::PlatformWebview, window: &WebviewWindow) {
    use objc2_app_kit::{
        NSWindowDidEndLiveResizeNotification, NSWindowDidEnterFullScreenNotification,
        NSWindowDidExitFullScreenNotification, NSWindowDidResizeNotification,
        NSWindowWillEnterFullScreenNotification, NSWindowWillExitFullScreenNotification,
        NSWindowWillStartLiveResizeNotification,
    };
    WINDOW_OBSERVERS.with(|entries| {
        let mut entries = entries.borrow_mut();
        if entries.contains_key(window.label()) {
            return;
        }
        let native = unsafe { &*platform.ns_window().cast::<NSWindow>() };
        let webview = unsafe { &*platform.inner().cast::<WKWebView>() };
        let center = NSNotificationCenter::defaultCenter();
        let mut tokens = Vec::new();
        let resize = Rc::new(LiveResize::default());
        // Both boundaries reset the drawing guard and snapshot stable bounds.
        // Capturing before AppKit changes them also preserves a just-finished
        // drag when the user immediately double-clicks to maximize.
        for name in unsafe {
            [NSWindowWillStartLiveResizeNotification, NSWindowDidEndLiveResizeNotification]
        } {
            let current_resize = resize.clone();
            let layout_window = window.as_ref().window();
            let block = RcBlock::new(move |_| {
                current_resize.start();
                crate::window_layout::native_resize_boundary(&layout_window);
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
        let current_resize = resize.clone();
        let view = Weak::from(webview);
        let block = RcBlock::new(move |_| {
            let Some(view) = view.load() else { return };
            let Some(window) = view.window() else { return };
            // AppKit uses this for edge drags and titlebar zoom animations.
            // The pinned Tao patch releases its state mutex before the latter;
            // resize callbacks can therefore safely service the native loop.
            // Non-animated programmatic resize may still hold Tauri's webview
            // locks and must not enter a nested loop here.
            if !window.inLiveResize() || !window.isVisible() || window.isMiniaturized() {
                return;
            }
            let Some(frame) = current_resize.begin() else { return };
            let ready = wait_for_frame(&view, &window, &current_resize);
            // Releasing the mouse can end the drag inside the nested loop.
            // That is cancellation, not a stalled renderer; the following
            // titlebar zoom must still be allowed to synchronize its frame.
            frame.complete(ready, window.inLiveResize());
        });
        tokens.push(unsafe {
            center.addObserverForName_object_queue_usingBlock(
                Some(NSWindowDidResizeNotification),
                Some(native),
                None,
                &block,
            )
        });
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
            WindowObservers { native: Weak::from(native), center, tokens, resize },
        );
    });
}

/// AppKit's view frame can already match the window while WebKit still shows
/// the previous page viewport. Let WebKit lay out and paint before returning
/// the native resize notification, rather than presenting those two sizes in
/// separate turns. Two animation frames include a paint between callbacks.
/// This runs outside with_webview and uses only public WebKit/Foundation APIs.
fn wait_for_frame(view: &WKWebView, window: &NSWindow, resize: &LiveResize) -> bool {
    use objc2::{runtime::AnyObject, sel};
    use objc2_foundation::NSError;
    if !view.respondsToSelector(
        sel!(callAsyncJavaScript:arguments:inFrame:inContentWorld:completionHandler:),
    ) {
        return false;
    }
    let finished = Rc::new(Cell::new(None));
    let result = finished.clone();
    let completed = RcBlock::new(move |_: *mut AnyObject, error: *mut NSError| {
        result.set(Some(error.is_null()));
    });
    let script = NSString::from_str(
        "await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); return true",
    );
    unsafe {
        view.callAsyncJavaScript_arguments_inFrame_inContentWorld_completionHandler(
            &script,
            None,
            None,
            &WKContentWorld::pageWorld(view.mtm()),
            Some(&completed),
        );
    }
    let timeout = Duration::from_millis(120);
    let deadline = Instant::now() + timeout;
    let limit = NSDate::dateWithTimeIntervalSinceNow(timeout.as_secs_f64());
    let run_loop = NSRunLoop::currentRunLoop();
    while finished.get().is_none()
        && resize.active()
        && window.isVisible()
        && window.inLiveResize()
        && Instant::now() < deadline
    {
        // Service WebKit IPC/render callbacks while AppKit owns the resize.
        // The per-window guard prevents recursive frame waits. Do not issue
        // Tauri dispatches or hold an application/runtime lock in this scope.
        if !run_loop.runMode_beforeDate(unsafe { NSDefaultRunLoopMode }, &limit) {
            break;
        }
    }
    finished.get() == Some(true)
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
