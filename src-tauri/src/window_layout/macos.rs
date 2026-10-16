//! Change position and size in one AppKit animation, outside runtime locks.
use super::{native_error, DesktopError, Geometry};
use objc2::MainThreadMarker;
use objc2_app_kit::{NSWindow, NSWorkspace};
use objc2_foundation::{NSPoint, NSRect, NSSize};
use tauri::{PhysicalPosition, Window};

fn target_frame(
    current: NSRect,
    position: PhysicalPosition<i32>,
    scale: f64,
    frame_size: NSSize,
    target: Geometry,
) -> NSRect {
    // Translate Tauri's physical, top-left coordinates relative to the current
    // native frame. This also works on screens above/left of the primary screen
    // without introducing a second global screen-coordinate conversion.
    NSRect::new(
        NSPoint::new(
            current.origin.x + (target.x - f64::from(position.x)) / scale,
            current.origin.y + current.size.height
                - (target.y - f64::from(position.y)) / scale
                - frame_size.height,
        ),
        frame_size,
    )
}

/// Called on the UI thread with no WindowLayouts or WebView lock held. AppKit's
/// animation runs a nested loop and reuses the live-resize drawing observer.
pub(super) fn set_geometry(
    window: &Window,
    geometry: Geometry,
    animate: bool,
) -> Result<bool, DesktopError> {
    let _main_thread = MainThreadMarker::new()
        .ok_or_else(|| native_error("Window geometry must be set on the main thread"))?;
    // Fullscreen exits and restoring a maximized window retain Tauri's native
    // state management, including its normal-size restoration bookkeeping.
    if geometry.maximized || window.is_fullscreen().map_err(native_error)? {
        return Ok(false);
    }
    let pointer = window.ns_window().map_err(native_error)?;
    // The captured Tauri window owns this pointer throughout this UI action.
    let native = unsafe { &*pointer.cast::<NSWindow>() };
    let size = native
        .frameRectForContentRect(NSRect::new(
            NSPoint::new(0.0, 0.0),
            NSSize::new(geometry.width, geometry.height),
        ))
        .size;
    let target = target_frame(
        native.frame(),
        window.outer_position().map_err(native_error)?,
        window.scale_factor().map_err(native_error)?,
        size,
        geometry,
    );
    let animate = animate
        && native.isVisible()
        && !native.isMiniaturized()
        && !NSWorkspace::sharedWorkspace().accessibilityDisplayShouldReduceMotion();
    if native.frame() != target {
        native.setFrame_display_animate(target, true, animate);
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn position_and_content_size_share_one_frame_on_scaled_negative_origin_screens() {
        let frame = target_frame(
            NSRect::new(NSPoint::new(-1200.0, 300.0), NSSize::new(880.0, 540.0)),
            PhysicalPosition::new(-2400, -200),
            2.0,
            NSSize::new(1440.0, 920.0),
            Geometry {
                x: -2600.0,
                y: -300.0,
                width: 1440.0,
                height: 900.0,
                maximized: false,
            },
        );
        assert_eq!(frame.origin, NSPoint::new(-1300.0, -30.0));
        assert_eq!(frame.size, NSSize::new(1440.0, 920.0));
    }

    #[test]
    fn resizing_at_the_same_position_keeps_the_native_top_left_corner() {
        let frame = target_frame(
            NSRect::new(NSPoint::new(80.0, 100.0), NSSize::new(1440.0, 900.0)),
            PhysicalPosition::new(80, 60),
            1.0,
            NSSize::new(880.0, 540.0),
            Geometry {
                x: 80.0,
                y: 60.0,
                width: 880.0,
                height: 540.0,
                maximized: false,
            },
        );
        assert_eq!(frame.origin, NSPoint::new(80.0, 460.0));
        assert_eq!(frame.origin.y + frame.size.height, 1000.0);
    }
}
