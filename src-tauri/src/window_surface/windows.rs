//! Finish WebView2 host fitting inside the native resize message, before paint.
use super::{error, fitted, DesktopError};
use tauri::{PhysicalPosition, PhysicalSize, WebviewWindow};
use windows_sys::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, WPARAM},
    UI::{
        Shell::{DefSubclassProc, GetWindowSubclass, RemoveWindowSubclass, SetWindowSubclass},
        WindowsAndMessaging::{SIZE_MINIMIZED, WM_DPICHANGED, WM_NCDESTROY, WM_SIZE},
    },
};

const SUBCLASS_ID: usize = 0x56445346;
struct ResizeHook(std::rc::Rc<dyn Fn()>);

// Owned by the HWND, exclusively on its UI thread. Remove and release the hook
// at WM_NCDESTROY; closing a project window must not retain its COM controller.
unsafe extern "system" fn resize_message(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _id: usize,
    data: usize,
) -> LRESULT {
    if message == WM_NCDESTROY {
        unsafe {
            RemoveWindowSubclass(hwnd, Some(resize_message), SUBCLASS_ID);
            drop(Box::from_raw(data as *mut ResizeHook));
            return DefSubclassProc(hwnd, message, wparam, lparam);
        }
    }
    if !((message == WM_SIZE && wparam != SIZE_MINIMIZED as usize) || message == WM_DPICHANGED) {
        return unsafe { DefSubclassProc(hwnd, message, wparam, lparam) };
    }
    // Wry updates its controller and asynchronously moves the child HWND.
    // Finish that move synchronously after Wry has handled the same message.
    let fit = unsafe { &*(data as *const ResizeHook) }.0.clone();
    let result = unsafe { DefSubclassProc(hwnd, message, wparam, lparam) };
    if installed(hwnd) {
        fit();
    }
    result
}

fn installed(hwnd: HWND) -> bool {
    let mut data = 0;
    unsafe { GetWindowSubclass(hwnd, Some(resize_message), SUBCLASS_ID, &mut data) != 0 }
}

fn install(hwnd: HWND, fit: Box<dyn Fn()>) -> Result<(), DesktopError> {
    if installed(hwnd) {
        return Ok(());
    }
    let hook = Box::into_raw(Box::new(ResizeHook(fit.into())));
    if unsafe { SetWindowSubclass(hwnd, Some(resize_message), SUBCLASS_ID, hook as usize) } == 0 {
        unsafe { drop(Box::from_raw(hook)) };
        return Err(error("Unable to observe native window resizing"));
    }
    Ok(())
}

pub(super) fn observe(
    window: &WebviewWindow,
    platform: &tauri::webview::PlatformWebview,
) -> Result<(), DesktopError> {
    let hwnd = window.hwnd().map_err(error)?.0;
    if !installed(hwnd) {
        let fit = native_fit(window, platform, None)?;
        install(
            hwnd,
            Box::new(move || {
                let _ = fit();
            }),
        )?;
    }
    Ok(())
}

pub(super) fn fit(
    window: &WebviewWindow,
    platform: &tauri::webview::PlatformWebview,
) -> Result<bool, DesktopError> {
    native_fit(window, platform, None)?()
}

pub(super) fn prepare(
    window: &WebviewWindow,
    platform: &tauri::webview::PlatformWebview,
    size: PhysicalSize<u32>,
) -> Result<(), DesktopError> {
    native_fit(window, platform, Some(size))?().map(|_| ())
}

fn native_fit(
    window: &WebviewWindow,
    platform: &tauri::webview::PlatformWebview,
    target: Option<PhysicalSize<u32>>,
) -> Result<impl Fn() -> Result<bool, DesktopError> + 'static, DesktopError> {
    use windows_sys::Win32::{
        Foundation::RECT,
        Graphics::Gdi::ScreenToClient,
        UI::WindowsAndMessaging::{
            GetClientRect, GetParent, GetWindowRect, SetWindowPos, SWP_NOACTIVATE, SWP_NOCOPYBITS,
            SWP_NOZORDER,
        },
    };
    let controller = platform.controller();
    let outer = window.hwnd().map_err(error)?.0;
    let fit = move || {
        let mut client = RECT::default();
        if unsafe { GetClientRect(outer, &mut client) } == 0 {
            return Err(error(std::io::Error::last_os_error()));
        }
        let mut host = Default::default();
        let mut controller_bounds = Default::default();
        let mut host_bounds = RECT::default();
        let size = target.unwrap_or_else(|| {
            PhysicalSize::new(
                (client.right - client.left).max(0) as u32,
                (client.bottom - client.top).max(0) as u32,
            )
        });
        if size.width == 0 || size.height == 0 {
            return Ok(false);
        }
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
                let mut point = windows_sys::Win32::Foundation::POINT {
                    x: host_rect.left,
                    y: host_rect.top,
                };
                if ScreenToClient(outer, &mut point) == 0 {
                    return Err(error(std::io::Error::last_os_error()));
                }
                origin = PhysicalPosition::new(point.x, point.y);
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
        let ready = host_ready && controller_ready;
        if !ready {
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
        Ok(ready)
    };
    Ok(fit)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::Cell, rc::Rc};
    use windows_sys::Win32::{
        Foundation::RECT,
        UI::WindowsAndMessaging::{
            CreateWindowExW, DestroyWindow, GetClientRect, IsWindowVisible, SendMessageW,
            SetWindowPos, SWP_NOACTIVATE, SWP_NOZORDER, WS_OVERLAPPEDWINDOW,
        },
    };

    #[test]
    fn native_resize_hook_runs_before_return_and_is_released_on_destroy() {
        let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
        let hwnd = unsafe {
            CreateWindowExW(
                0,
                class.as_ptr(),
                std::ptr::null(),
                WS_OVERLAPPEDWINDOW,
                0,
                0,
                880,
                540,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null(),
            )
        };
        assert!(!hwnd.is_null());
        let bounds = Rc::new(Cell::new((0, 0)));
        let owned = bounds.clone();
        install(
            hwnd,
            Box::new(move || {
                let mut size = RECT::default();
                assert_ne!(unsafe { GetClientRect(hwnd, &mut size) }, 0);
                owned.set((size.right, size.bottom));
            }),
        )
        .unwrap();
        install(
            hwnd,
            Box::new(|| panic!("hook must not be installed twice")),
        )
        .unwrap();
        for (width, height) in [(1200, 760), (880, 540), (1800, 1140), (800, 480)] {
            assert_ne!(
                unsafe {
                    SetWindowPos(
                        hwnd,
                        std::ptr::null_mut(),
                        0,
                        0,
                        width,
                        height,
                        SWP_NOACTIVATE | SWP_NOZORDER,
                    )
                },
                0
            );
            let mut client = RECT::default();
            assert_ne!(unsafe { GetClientRect(hwnd, &mut client) }, 0);
            assert_eq!(bounds.get(), (client.right, client.bottom));
        }
        let previous = bounds.replace((-1, -1));
        unsafe { SendMessageW(hwnd, WM_SIZE, SIZE_MINIMIZED as usize, 0) };
        assert_eq!(bounds.get(), (-1, -1));
        bounds.set(previous);
        assert_eq!(unsafe { IsWindowVisible(hwnd) }, 0);
        assert_eq!(Rc::strong_count(&bounds), 2);
        assert_ne!(unsafe { DestroyWindow(hwnd) }, 0);
        assert_eq!(Rc::strong_count(&bounds), 1);
    }
}
