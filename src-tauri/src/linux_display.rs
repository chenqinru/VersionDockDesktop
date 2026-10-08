use std::ffi::OsStr;

// GTK tries these backends in order. Keeping Wayland as a fallback lets a
// Wayland-only desktop start when DISPLAY exists but XWayland is unavailable.
const XWAYLAND_FIRST: &str = "x11,wayland";

#[cfg(target_os = "linux")]
pub fn configure() {
    let backend = std::env::var_os("GDK_BACKEND");
    let session = std::env::var_os("XDG_SESSION_TYPE");
    let wayland_display = std::env::var_os("WAYLAND_DISPLAY");
    let x_display = std::env::var_os("DISPLAY");
    if let Some(preferred) = preferred_backend(
        backend.as_deref(),
        session.as_deref(),
        wayland_display.as_deref(),
        x_display.as_deref(),
    ) {
        // Called before Tauri/GTK initialization and application worker threads.
        std::env::set_var("GDK_BACKEND", preferred);
    }
}

fn preferred_backend(
    backend: Option<&OsStr>,
    session: Option<&OsStr>,
    wayland_display: Option<&OsStr>,
    x_display: Option<&OsStr>,
) -> Option<&'static str> {
    if backend.is_some() || !x_display.is_some_and(|value| !value.is_empty()) {
        return None;
    }
    let wayland = session == Some(OsStr::new("wayland"))
        || wayland_display.is_some_and(|value| !value.is_empty());
    wayland.then_some(XWAYLAND_FIRST)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefers_xwayland_for_a_wayland_session_with_an_x_display() {
        assert_eq!(
            preferred_backend(
                None,
                Some(OsStr::new("wayland")),
                None,
                Some(OsStr::new(":0"))
            ),
            Some("x11,wayland")
        );
    }

    #[test]
    fn detects_wayland_when_the_session_hint_is_missing() {
        assert_eq!(
            preferred_backend(
                None,
                None,
                Some(OsStr::new("wayland-0")),
                Some(OsStr::new(":1"))
            ),
            Some("x11,wayland")
        );
    }

    #[test]
    fn preserves_every_explicit_backend_override() {
        for backend in ["wayland", "x11", "wayland,x11", ""] {
            assert_eq!(
                preferred_backend(
                    Some(OsStr::new(backend)),
                    Some(OsStr::new("wayland")),
                    None,
                    Some(OsStr::new(":0"))
                ),
                None
            );
        }
    }

    #[test]
    fn leaves_a_wayland_only_session_unchanged() {
        for display in [None, Some(OsStr::new(""))] {
            assert_eq!(
                preferred_backend(
                    None,
                    Some(OsStr::new("wayland")),
                    Some(OsStr::new("wayland-0")),
                    display
                ),
                None
            );
        }
    }

    #[test]
    fn leaves_x11_and_headless_sessions_unchanged() {
        assert_eq!(
            preferred_backend(None, Some(OsStr::new("x11")), None, Some(OsStr::new(":0"))),
            None
        );
        assert_eq!(preferred_backend(None, None, None, None), None);
        assert_eq!(
            preferred_backend(None, None, Some(OsStr::new("")), Some(OsStr::new(":0"))),
            None
        );
    }
}
