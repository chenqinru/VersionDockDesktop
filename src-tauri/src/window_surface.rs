//! Keep the main webview and its native host fitted to the window client area.
//! Window geometry and webview geometry are separate on Windows/WebView2.
use crate::models::{DesktopError, WindowViewport};
use tauri::{Manager, WebviewWindow};
#[cfg(any(not(any(target_os = "macos", target_os = "linux")), test))]
use tauri::{PhysicalPosition, PhysicalSize};

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

pub struct Surface {
    pub viewport: WindowViewport,
    pub sample: (u32, u32, u64),
    pub maximized: bool,
    pub minimized: bool,
    pub ready: bool,
}

fn error(error: impl std::fmt::Display) -> DesktopError {
    DesktopError::new("WINDOW_SURFACE_FAILED", error.to_string(), true)
}

pub fn is_presenting_resize(_label: &str) -> bool {
    #[cfg(target_os = "macos")]
    {
        macos::is_presenting(_label)
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

#[cfg(any(not(any(target_os = "macos", target_os = "linux")), test))]
fn fitted(
    size: PhysicalSize<u32>,
    origin: PhysicalPosition<i32>,
    bounds: PhysicalSize<u32>,
) -> bool {
    size.width > 0 && size.height > 0 && origin == PhysicalPosition::new(0, 0) && bounds == size
}

/// Always read the current client size on the UI thread. A delayed resize event
/// must never reapply its obsolete payload after a newer resize or DPI change.
pub async fn synchronize(window: &WebviewWindow) -> Result<Surface, DesktopError> {
    let (send, receive) = tokio::sync::oneshot::channel();
    let current = window.clone();
    #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
    window
        .with_webview(move |platform| {
            let _ = send.send(inspect(current, platform));
        })
        .map_err(error)?;
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    window
        .app_handle()
        .run_on_main_thread(move || {
            let _ = send.send(inspect(current));
        })
        .map_err(error)?;
    receive.await.map_err(error)?
}

fn inspect(
    window: WebviewWindow,
    #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
    platform: tauri::webview::PlatformWebview,
) -> Result<Surface, DesktopError> {
    let size = window.inner_size().map_err(error)?;
    let scale = window.scale_factor().map_err(error)?;
    let logical = size.to_logical::<f64>(scale);
    let mut surface = Surface {
        viewport: WindowViewport {
            width: logical.width,
            height: logical.height,
        },
        sample: (size.width, size.height, scale.to_bits()),
        maximized: window.is_maximized().map_err(error)?,
        minimized: window.is_minimized().map_err(error)?,
        ready: false,
    };
    if surface.minimized || size.width == 0 || size.height == 0 {
        return Ok(surface);
    }

    #[cfg(target_os = "windows")]
    {
        surface.ready = windows::fit(&window, &platform)?;
    }
    #[cfg(target_os = "macos")]
    {
        surface.ready = macos::fit(&platform)?;
    }
    #[cfg(target_os = "linux")]
    {
        // Main GTK webviews are packed in a Box: Wry's set_bounds only
        // allocates Fixed children and cannot repair this layout.
        surface.ready = linux::fit(
            &platform.inner(),
            logical.width.round() as i32,
            logical.height.round() as i32,
        )
        .map_err(error)?;
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        let webview: &tauri::Webview = window.as_ref();
        let bounds = webview.bounds().map_err(error)?;
        surface.ready = fitted(
            size,
            bounds.position.to_physical::<i32>(scale),
            bounds.size.to_physical::<u32>(scale),
        );
        if !surface.ready {
            webview
                .set_bounds(tauri::Rect {
                    position: PhysicalPosition::new(0, 0).into(),
                    size: size.into(),
                })
                .map_err(error)?;
        }
    }
    // Business windows on macOS, Windows and Linux use native filling. Only
    // the fallback needs proportional bounds, enabled after a measured 1:1 fit.
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    if surface.ready {
        let webview: &tauri::Webview = window.as_ref();
        webview.set_auto_resize(true).map_err(error)?;
    }
    Ok(surface)
}

pub fn schedule(window: WebviewWindow) {
    #[cfg(target_os = "macos")]
    {
        // A native resize notification already runs on the UI thread. Fit
        // here, before returning to AppKit; a Tokio round trip can queue stale
        // repairs behind the next drag step. Startup calls are dispatched by
        // with_webview to the same UI thread.
        let current = window.clone();
        if let Err(error) = window.with_webview(move |platform| {
            macos::observe(&platform, &current);
            if let Err(error) = macos::fit(&platform) {
                // Logging emits a frontend event; leave the native callback
                // before re-entering the runtime's webview dispatcher.
                tauri::async_runtime::spawn(async move { warn(error) });
            }
        }) {
            warn(self::error(error));
        }
    }
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    {
        // Resize events already run on the UI thread. Do not queue one Tokio
        // task per drag step before coming back to the same native thread.
        let current = window.clone();
        if let Err(error) = window.with_webview(move |platform| {
            #[cfg(target_os = "windows")]
            let result = windows::observe(&current, &platform)
                .and_then(|()| inspect(current, platform).map(|_| ()));
            #[cfg(target_os = "linux")]
            let result = inspect(current, platform).map(|_| ());
            if let Err(error) = result {
                // Emitting log events must not re-enter a native callback.
                tauri::async_runtime::spawn(async move { warn(error) });
            }
        }) {
            warn(self::error(error));
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    tauri::async_runtime::spawn(async move {
        if let Err(error) = synchronize(&window).await {
            warn(error);
        }
    });
}

fn warn(error: DesktopError) {
    crate::logger::log_entry(
        crate::models::LogLevel::Warn,
        crate::models::LogChannel::Core,
        "Unable to fit webview to window",
        Some(error.message),
        None,
        None,
    );
}

pub fn window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    #[cfg(target_os = "macos")]
    if matches!(event, tauri::WindowEvent::Destroyed) {
        let label = window.label().to_owned();
        let _ = window
            .app_handle()
            .run_on_main_thread(move || macos::forget(&label));
    }
    if crate::windowing::is_business_window(window.label())
        && matches!(
            event,
            tauri::WindowEvent::Resized(_)
                | tauri::WindowEvent::ScaleFactorChanged { .. }
                | tauri::WindowEvent::Focused(true)
        )
    {
        if let Some(webview) = window.app_handle().get_webview_window(window.label()) {
            schedule(webview);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn old_welcome_host_is_not_ready_when_the_outer_window_has_grown() {
        let project = PhysicalSize::new(1200, 760);
        assert!(!fitted(
            project,
            PhysicalPosition::new(0, 0),
            PhysicalSize::new(880, 540)
        ));
        assert!(fitted(project, PhysicalPosition::new(0, 0), project));
    }
    #[test]
    fn fitting_checks_origin_shrinking_and_physical_dpi_dimensions() {
        for size in [PhysicalSize::new(880, 540), PhysicalSize::new(1800, 1140)] {
            assert!(!fitted(size, PhysicalPosition::new(8, 8), size));
            assert!(!fitted(
                size,
                PhysicalPosition::new(0, 0),
                PhysicalSize::new(1200, 760)
            ));
            assert!(fitted(size, PhysicalPosition::new(0, 0), size));
        }
        assert!(!fitted(
            PhysicalSize::new(0, 0),
            PhysicalPosition::new(0, 0),
            PhysicalSize::new(0, 0)
        ));
    }
}
