//! Shared business-window creation and navigation for IPC and the tray.
use crate::{
    models::{DesktopError, WindowTabTransfer},
    state::AppState,
};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

pub async fn set_controls_visible(
    window: WebviewWindow,
    visible: bool,
) -> Result<(), DesktopError> {
    #[cfg(target_os = "macos")]
    {
        let (send, receive) = tokio::sync::oneshot::channel();
        let app = window.app_handle().clone();
        app.run_on_main_thread(move || {
            let result = (|| {
                use objc2_app_kit::{NSWindow, NSWindowButton};
                let native = window.ns_window().map_err(|error| {
                    DesktopError::new("WINDOW_CONTROLS_FAILED", error.to_string(), true)
                })?;
                // Tauri owns this NSWindow for the captured window's lifetime.
                // AppKit views must only be accessed on the main thread.
                let native = unsafe { &*native.cast::<NSWindow>() };
                for kind in [
                    NSWindowButton::CloseButton,
                    NSWindowButton::MiniaturizeButton,
                    NSWindowButton::ZoomButton,
                ] {
                    if let Some(button) = native.standardWindowButton(kind) {
                        button.setHidden(!visible);
                    }
                }
                Ok(())
            })();
            let _ = send.send(result);
        })
        .map_err(|error| DesktopError::new("WINDOW_CONTROLS_FAILED", error.to_string(), true))?;
        receive
            .await
            .map_err(|error| DesktopError::new("WINDOW_CONTROLS_FAILED", error.to_string(), true))?
    }
    #[cfg(target_os = "windows")]
    {
        let (send, receive) = tokio::sync::oneshot::channel();
        let app = window.app_handle().clone();
        app.run_on_main_thread(move || {
            if let Ok(mut hidden) = HIDDEN_CAPTIONS.lock() {
                if visible {
                    hidden.remove(window.label());
                } else {
                    hidden.insert(window.label().to_owned());
                }
            }
            let result = sync_windows_snap_visibility(&window.as_ref().window(), visible);
            let _ = send.send(result);
        })
        .map_err(|error| DesktopError::new("WINDOW_CONTROLS_FAILED", error.to_string(), true))?;
        receive
            .await
            .map_err(|error| DesktopError::new("WINDOW_CONTROLS_FAILED", error.to_string(), true))?
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (window, visible);
        Ok(())
    }
}

#[cfg(target_os = "windows")]
static HIDDEN_CAPTIONS: std::sync::LazyLock<std::sync::Mutex<std::collections::HashSet<String>>> =
    std::sync::LazyLock::new(Default::default);

#[cfg(target_os = "windows")]
fn sync_windows_snap_visibility(window: &tauri::Window, visible: bool) -> Result<(), DesktopError> {
    use windows_sys::Win32::UI::{
        Input::KeyboardAndMouse::EnableWindow,
        WindowsAndMessaging::{FindWindowExW, ShowWindow, SW_HIDE, SW_SHOWNOACTIVATE},
    };
    let parent = window
        .hwnd()
        .map_err(|error| DesktopError::new("WINDOW_CONTROLS_FAILED", error.to_string(), true))?;
    let class: Vec<u16> = "TboSnapOverlay\0".encode_utf16().collect();
    // The plugin's transparent maximize hit surface is a native child HWND;
    // CSS alone cannot put it behind a modal or prevent it intercepting input.
    unsafe {
        let overlay = FindWindowExW(
            parent.0,
            std::ptr::null_mut(),
            class.as_ptr(),
            std::ptr::null(),
        );
        if !overlay.is_null() {
            EnableWindow(overlay, i32::from(visible));
            ShowWindow(overlay, if visible { SW_SHOWNOACTIVATE } else { SW_HIDE });
        }
    }
    Ok(())
}

pub fn caption_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    #[cfg(target_os = "windows")]
    {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            if let Ok(mut hidden) = HIDDEN_CAPTIONS.lock() {
                hidden.remove(window.label());
            }
        } else if matches!(
            event,
            tauri::WindowEvent::Resized(_) | tauri::WindowEvent::ScaleFactorChanged { .. }
        ) {
            let hidden = HIDDEN_CAPTIONS
                .lock()
                .is_ok_and(|hidden| hidden.contains(window.label()));
            if hidden {
                let _ = sync_windows_snap_visibility(window, false);
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    let _ = (window, event);
}

pub fn is_business_window(label: &str) -> bool {
    label == "main" || label.starts_with("window-")
}

pub fn preferred_window(labels: &[String], focus_order: &[String]) -> Option<String> {
    focus_order
        .iter()
        .rev()
        .find(|label| labels.contains(label))
        .cloned()
        .or_else(|| labels.iter().min().cloned())
}

pub fn restore_window(window: &WebviewWindow) -> Result<(), DesktopError> {
    window
        .unminimize()
        .and_then(|_| window.show())
        .and_then(|_| window.set_focus())
        .map_err(|error| DesktopError::new("WINDOW_FOCUS_FAILED", error.to_string(), true))
}

pub fn paths_match(a: &[String], b: &[String]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut left = a.to_vec();
    let mut right = b.to_vec();
    left.sort();
    right.sort();
    left == right
}

pub fn focus_workspace(
    app: &AppHandle,
    paths: &[String],
    exclude: Option<&str>,
    focus_order: &[String],
) -> Result<bool, DesktopError> {
    let labels = {
        let state = app.state::<AppState>();
        let map = state.window_workspaces.lock().map_err(|_| {
            DesktopError::new(
                "WINDOW_STATE_LOCK_FAILED",
                "Unable to read window tabs",
                true,
            )
        })?;
        map.iter()
            .filter(|(label, tabs)| {
                is_business_window(label)
                    && exclude != Some(label.as_str())
                    && app.get_webview_window(label).is_some()
                    && tabs.iter().any(|tab| paths_match(tab, paths))
            })
            .map(|(label, _)| label.clone())
            .collect::<Vec<_>>()
    };
    let Some(label) = preferred_window(&labels, focus_order) else {
        return Ok(false);
    };
    let Some(window) = app.get_webview_window(&label) else {
        return Ok(false);
    };
    restore_window(&window)?;
    window
        .emit("versiondock://focus-tab", paths)
        .map_err(|error| DesktopError::new("WINDOW_FOCUS_FAILED", error.to_string(), true))?;
    Ok(true)
}

pub fn create_window(
    app: &AppHandle,
    state: &AppState,
    fallback_window: Option<&WebviewWindow>,
    paths: Option<Vec<String>>,
    x: Option<f64>,
    y: Option<f64>,
    width: Option<f64>,
    height: Option<f64>,
    transfer: Option<WindowTabTransfer>,
) -> Result<String, DesktopError> {
    let label = format!("window-{}", uuid::Uuid::new_v4().simple());
    let mut query = vec!["window=new".to_string()];
    if let Some(paths) = &paths {
        if !paths.is_empty() {
            let encoded = serde_json::to_string(paths).unwrap_or_default();
            query.push(format!("workspacePaths={}", url_encode(&encoded)));
        }
    }
    if let Some(transfer) = &transfer {
        let encoded = serde_json::to_string(transfer).unwrap_or_default();
        query.push(format!("tabTransfer={}", url_encode(&encoded)));
    }
    let query_suffix = format!("?{}", query.join("&"));

    let main_url = app
        .get_webview_window("main")
        .and_then(|window| window.url().ok())
        .or_else(|| fallback_window.and_then(|window| window.url().ok()))
        .or_else(|| {
            #[cfg(dev)]
            {
                app.config().build.dev_url.clone()
            }
            #[cfg(not(dev))]
            {
                None
            }
        });
    let webview_url = match main_url {
        Some(mut url) if matches!(url.scheme(), "http" | "https") => {
            url.set_path("/");
            url.set_query(Some(query_suffix.trim_start_matches('?')));
            url.set_fragment(None);
            tauri::WebviewUrl::External(url)
        }
        _ => {
            let url_path = format!("index.html{}", query_suffix);
            tauri::WebviewUrl::App(url_path.into())
        }
    };

    let builder = tauri::WebviewWindowBuilder::new(app, &label, webview_url)
        .title(
            app.config()
                .product_name
                .as_deref()
                .unwrap_or("VersionDock Desktop"),
        )
        .inner_size(width.unwrap_or(880.0), height.unwrap_or(540.0))
        .min_inner_size(800.0, 480.0)
        // The frontend reveals the themed shell before repository loading
        // finishes. Transfers can immediately show their initial tab.
        .visible(false)
        .focused(false)
        .background_color(tauri::window::Color(18, 19, 20, 255))
        .resizable(true);

    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);

    #[cfg(target_os = "linux")]
    let builder = builder.decorations(false);

    #[cfg(target_os = "windows")]
    let builder = builder.decorations(true);

    let builder = if let (Some(x), Some(y)) = (x, y) {
        builder.position(x, y)
    } else {
        builder.center()
    };

    // Bind before building: the new webview may immediately request its session.
    if let Some(transfer) = &transfer {
        state.bind_tab_session(transfer, &label)?;
    }
    let window = builder.build().map_err(|err| {
        DesktopError::new(
            "WINDOW_CREATE_FAILED",
            format!("Failed to create window: {err}"),
            true,
        )
    })?;
    #[cfg(target_os = "windows")]
    {
        use tauri_plugin_window_controls::WindowControlsExt;
        let _ = window.set_title_bar_height(38);
        let _ = window.set_title_bar_overlay(true);
    }
    crate::window_surface::schedule(window);

    Ok(label)
}

fn url_encode(input: &str) -> String {
    let mut encoded = String::new();
    for byte in input.bytes() {
        match byte {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char);
            }
            _ => {
                encoded.push_str(&format!("%{:02X}", byte));
            }
        }
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn navigation_uses_live_windows_and_falls_back_after_recent_window_closes() {
        let labels = vec!["main".into(), "window-2".into()];
        let order = vec!["main".into(), "window-2".into(), "window-closed".into()];
        assert_eq!(
            preferred_window(&labels, &order).as_deref(),
            Some("window-2")
        );
        assert_eq!(
            preferred_window(&["main".into()], &order).as_deref(),
            Some("main")
        );
        assert_eq!(preferred_window(&[], &order), None);
        assert!(!is_business_window("tab-drag-preview-2"));
    }
    #[test]
    fn transferred_multi_root_project_matches_independent_of_path_order() {
        assert!(paths_match(
            &["/中文/a".into(), "C:\\project & b".into()],
            &["C:\\project & b".into(), "/中文/a".into()]
        ));
        assert!(!paths_match(&["/a".into()], &["/a".into(), "/b".into()]));
        let paths = r#"["/中文/project & a","C:\\project # b"]"#;
        let url = url::Url::parse(&format!(
            "http://localhost/?workspacePaths={}",
            url_encode(paths)
        ))
        .unwrap();
        assert_eq!(url.query_pairs().next().unwrap().1, paths);
    }
}
