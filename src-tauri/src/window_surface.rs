//! Keep the main webview and its native host fitted to the window client area.
//! Window geometry and webview geometry are separate on Windows/WebView2.
use crate::models::{DesktopError, WindowViewport};
use tauri::{Manager, WebviewWindow};
#[cfg(any(not(target_os = "macos"), test))]
use tauri::{PhysicalPosition, PhysicalSize};

#[cfg(target_os = "macos")]
mod macos;

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

#[cfg(any(not(target_os = "macos"), test))]
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
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    window
        .with_webview(move |platform| {
            let _ = send.send(inspect(current, platform));
        })
        .map_err(error)?;
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
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
    #[cfg(any(target_os = "windows", target_os = "macos"))]
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
        use windows_sys::Win32::{
            Foundation::RECT,
            UI::WindowsAndMessaging::{
                GetClientRect, GetParent, GetWindowRect, SetWindowPos, SWP_NOACTIVATE,
                SWP_NOCOPYBITS, SWP_NOZORDER,
            },
        };
        let controller = platform.controller();
        let mut host = Default::default();
        let mut controller_bounds = Default::default();
        let mut host_bounds = RECT::default();
        let outer = window.hwnd().map_err(error)?.0;
        let mut origin = PhysicalPosition::new(0, 0);
        // Tauri exposes the controller, so no Wry class-name lookup or
        // private window implementation is needed to locate its host.
        unsafe {
            controller.ParentWindow(&mut host).map_err(error)?;
            controller.Bounds(&mut controller_bounds).map_err(error)?;
            if GetClientRect(host.0, &mut host_bounds) == 0 {
                return Err(error(std::io::Error::last_os_error()));
            }
            if host.0 != outer {
                if GetParent(host.0) != outer {
                    return Err(error("Unexpected WebView2 host parent"));
                }
                let mut host_rect = RECT::default();
                if GetWindowRect(host.0, &mut host_rect) == 0 {
                    return Err(error(std::io::Error::last_os_error()));
                }
                let client_origin = window.inner_position().map_err(error)?;
                origin = PhysicalPosition::new(
                    host_rect.left - client_origin.x,
                    host_rect.top - client_origin.y,
                );
            }
        }
        let host_ready = fitted(
            size,
            origin,
            PhysicalSize::new(
                (host_bounds.right - host_bounds.left).max(0) as u32,
                (host_bounds.bottom - host_bounds.top).max(0) as u32,
            ),
        );
        let controller_ready = fitted(
            size,
            PhysicalPosition::new(controller_bounds.left, controller_bounds.top),
            PhysicalSize::new(
                (controller_bounds.right - controller_bounds.left).max(0) as u32,
                (controller_bounds.bottom - controller_bounds.top).max(0) as u32,
            ),
        );
        surface.ready = host_ready && controller_ready;
        if !surface.ready {
            controller_bounds.left = 0;
            controller_bounds.top = 0;
            controller_bounds.right = i32::try_from(size.width).map_err(error)?;
            controller_bounds.bottom = i32::try_from(size.height).map_err(error)?;
            unsafe {
                // Wry normally positions this HWND asynchronously. Fit
                // both layers synchronously and discard copied old pixels.
                if host.0 != outer
                    && SetWindowPos(
                        host.0,
                        std::ptr::null_mut(),
                        0,
                        0,
                        controller_bounds.right,
                        controller_bounds.bottom,
                        SWP_NOACTIVATE | SWP_NOZORDER | SWP_NOCOPYBITS,
                    ) == 0
                {
                    return Err(error(std::io::Error::last_os_error()));
                }
                controller.SetBounds(controller_bounds).map_err(error)?;
                controller
                    .NotifyParentWindowPositionChanged()
                    .map_err(error)?;
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        surface.ready = macos::fit(&platform)?;
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
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
    // Only enable proportional resizing once the measured ratio is 1:1.
    // Enabling it while the webview is still small preserves that ratio.
    // macOS main webviews use AppKit's native autoresizing, not Wry's
    // proportional set_bounds (which only handles child webviews on macOS).
    #[cfg(not(target_os = "macos"))]
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
            macos::observe_fullscreen(&platform, &current);
            if let Err(error) = macos::fit(&platform) {
                // Logging emits a frontend event; leave the native callback
                // before re-entering the runtime's webview dispatcher.
                tauri::async_runtime::spawn(async move { warn(error) });
            }
        }) {
            warn(self::error(error));
        }
    }
    #[cfg(not(target_os = "macos"))]
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
