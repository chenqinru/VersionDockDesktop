use tauri::{AppHandle, Manager, WebviewWindow};

pub struct TabDropTarget {
    pub label: String,
    pub client_x: f64,
}

// Window APIs and AppKit ordering must run on the UI thread. Both preview and
// release use this one hit test, in physical desktop coordinates.
pub async fn drop_target(
    app: &AppHandle,
    source: &str,
    point: Option<tauri::PhysicalPosition<f64>>,
) -> Option<TabDropTarget> {
    let (send, receive) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    let source = source.to_string();
    app.run_on_main_thread(move || {
        let _ = send.send(hit_test(&handle, &source, point));
    })
    .ok()?;
    receive.await.ok().flatten()
}

fn hit_test(
    app: &AppHandle,
    source: &str,
    point: Option<tauri::PhysicalPosition<f64>>,
) -> Option<TabDropTarget> {
    let point = point.or_else(|| app.cursor_position().ok())?;
    let windows = app.webview_windows();
    let registered = app
        .state::<crate::state::AppState>()
        .window_workspaces
        .lock()
        .ok()?
        .clone();
    let candidates: Vec<_> = windows
        .values()
        .filter(|window| {
            window.label() != source
                && !window.label().starts_with("tab-drag-preview-")
                && window.is_visible().unwrap_or(false)
                && !window.is_minimized().unwrap_or(false)
        })
        .cloned()
        .collect();
    let mut matches = Vec::new();
    for window in ordered_windows(&candidates) {
        let (Ok(position), Ok(size), Ok(scale)) = (
            window.outer_position(),
            window.outer_size(),
            window.scale_factor(),
        ) else {
            continue;
        };
        let scale = scale.max(f64::EPSILON);
        let x = point.x - f64::from(position.x);
        let y = point.y - f64::from(position.y);
        let inside =
            x >= 0.0 && y >= 0.0 && x <= f64::from(size.width) && y <= f64::from(size.height);
        let snaps = registered.contains_key(window.label())
            && crate::commands::point_in_tab_snap_zone(
                x / scale,
                y / scale,
                0.0,
                0.0,
                f64::from(size.width) / scale,
            );
        // A foreground workspace body occludes a title bar behind it.
        if inside && !snaps {
            return None;
        }
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        if inside && snaps {
            return Some(TabDropTarget {
                label: window.label().into(),
                client_x: x / scale,
            });
        }
        if snaps {
            matches.push(TabDropTarget {
                label: window.label().into(),
                client_x: x / scale,
            });
        }
    }
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        matches.into_iter().next()
    }
    // Wayland does not expose global stacking order. Refuse ambiguous targets
    // rather than choosing an arbitrary HashMap entry.
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    if matches.len() == 1 {
        matches.pop()
    } else {
        None
    }
}

#[cfg(target_os = "macos")]
fn ordered_windows(windows: &[WebviewWindow]) -> Vec<WebviewWindow> {
    use std::ffi::{c_char, c_void};
    #[link(name = "objc")]
    unsafe extern "C" {
        fn objc_getClass(name: *const c_char) -> *mut c_void;
        fn sel_registerName(name: *const c_char) -> *mut c_void;
        fn objc_msgSend();
    }
    // These are no-argument Objective-C object messages and NSArray accessors.
    // Reading AppKit's orderedWindows on the main thread avoids screen capture
    // permissions and preserves the actual stacking order of our native windows.
    unsafe {
        let message: unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void =
            std::mem::transmute(objc_msgSend as *const ());
        let count: unsafe extern "C" fn(*mut c_void, *mut c_void) -> usize =
            std::mem::transmute(objc_msgSend as *const ());
        let item: unsafe extern "C" fn(*mut c_void, *mut c_void, usize) -> *mut c_void =
            std::mem::transmute(objc_msgSend as *const ());
        let application = message(
            objc_getClass(c"NSApplication".as_ptr()),
            sel_registerName(c"sharedApplication".as_ptr()),
        );
        let ordered = message(application, sel_registerName(c"orderedWindows".as_ptr()));
        let mut result = Vec::new();
        for index in 0..count(ordered, sel_registerName(c"count".as_ptr())) {
            let native = item(ordered, sel_registerName(c"objectAtIndex:".as_ptr()), index);
            if let Some(window) = windows
                .iter()
                .find(|window| window.ns_window().ok() == Some(native))
            {
                result.push(window.clone());
            }
        }
        result
    }
}

#[cfg(target_os = "windows")]
fn ordered_windows(windows: &[WebviewWindow]) -> Vec<WebviewWindow> {
    use std::ffi::c_void;
    #[link(name = "user32")]
    unsafe extern "system" {
        fn GetTopWindow(window: *mut c_void) -> *mut c_void;
        fn GetWindow(window: *mut c_void, command: u32) -> *mut c_void;
    }
    let mut result = Vec::new();
    unsafe {
        let mut native = GetTopWindow(std::ptr::null_mut());
        while !native.is_null() {
            if let Some(window) = windows
                .iter()
                .find(|window| window.hwnd().is_ok_and(|hwnd| hwnd.0 == native))
            {
                result.push(window.clone());
            }
            native = GetWindow(native, 2); // GW_HWNDNEXT
        }
    }
    result
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn ordered_windows(windows: &[WebviewWindow]) -> Vec<WebviewWindow> {
    let mut windows = windows.to_vec();
    windows.sort_by_key(|window| !window.is_focused().unwrap_or(false));
    windows
}
