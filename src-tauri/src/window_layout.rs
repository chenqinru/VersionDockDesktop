//! Native window geometry is separate from workbench layout and welcome sizing.
//! Each live window owns its project geometry; only the latest user adjustment is
//! used as the initial placement after restarting the application.
use crate::models::{DesktopError, WindowViewport};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, path::PathBuf, sync::Mutex, time::Duration};
use tauri::{Manager, Window};

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
struct Geometry {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    #[serde(default)]
    maximized: bool,
}
impl Geometry {
    fn valid(&self) -> bool {
        [self.x, self.y, self.width, self.height]
            .iter()
            .all(|v| v.is_finite())
            && self.width >= 320.0
            && self.height >= 240.0
    }
}
#[derive(Debug, Clone, Copy)]
struct Area {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    scale: f64,
}
impl Area {
    fn from_monitor(monitor: &tauri::Monitor) -> Self {
        let scale = monitor.scale_factor();
        let area = monitor.work_area();
        Self {
            x: f64::from(area.position.x),
            y: f64::from(area.position.y),
            width: f64::from(area.size.width) / scale,
            height: f64::from(area.size.height) / scale,
            scale,
        }
    }
    fn contains_center(&self, geometry: Geometry) -> bool {
        let x = geometry.x + geometry.width * self.scale / 2.0;
        let y = geometry.y + geometry.height * self.scale / 2.0;
        x >= self.x
            && x < self.x + self.width * self.scale
            && y >= self.y
            && y < self.y + self.height * self.scale
    }
    fn fit(&self, mut geometry: Geometry) -> Geometry {
        let available_width = (self.width - 20.0).max(1.0);
        let available_height = (self.height - 40.0).max(1.0);
        geometry.width = geometry
            .width
            .clamp(800.0_f64.min(available_width), available_width);
        geometry.height = geometry
            .height
            .clamp(480.0_f64.min(available_height), available_height);
        geometry.x = geometry.x.clamp(
            self.x,
            self.x + (self.width - geometry.width - 20.0).max(0.0) * self.scale,
        );
        geometry.y = geometry.y.clamp(
            self.y,
            self.y + (self.height - geometry.height - 40.0).max(0.0) * self.scale,
        );
        geometry
    }
    fn default_geometry(&self, workspace: bool) -> Geometry {
        let width = if workspace {
            (self.width * 0.88).clamp(1280.0, 1920.0)
        } else {
            880.0
        };
        let height = if workspace {
            (self.height * 0.88).clamp(800.0, 1200.0)
        } else {
            540.0
        };
        let mut geometry = self.fit(Geometry {
            x: self.x,
            y: self.y,
            width,
            height,
            maximized: false,
        });
        geometry.x = self.x + (self.width - geometry.width) * self.scale / 2.0;
        geometry.y = self.y + (self.height - geometry.height - 40.0).max(0.0) * self.scale / 2.0;
        geometry
    }
}
#[derive(Default, Serialize, Deserialize)]
struct Saved {
    project: Option<Geometry>,
}
struct Entry {
    workspace: bool,
    project: Option<Geometry>,
    welcome: Option<Geometry>,
    epoch: u64,
    transitioning: bool,
}
#[derive(Default)]
struct Windows {
    saved: Saved,
    entries: HashMap<String, Entry>,
    dirty: bool,
}
impl Windows {
    fn record(&mut self, label: &str, mut geometry: Geometry) {
        if !geometry.valid() {
            return;
        }
        let Some(entry) = self.entries.get_mut(label) else {
            return;
        };
        if entry.transitioning {
            return;
        }
        if entry.workspace {
            if geometry.maximized {
                let Some(previous) = entry.project else {
                    return;
                };
                geometry = Geometry {
                    maximized: true,
                    ..previous
                };
            }
            if entry.project != Some(geometry) {
                entry.project = Some(geometry);
                self.saved.project = Some(geometry);
                self.dirty = true;
            }
        } else if !geometry.maximized {
            entry.welcome = Some(geometry);
        }
    }
}
pub struct WindowLayouts {
    path: PathBuf,
    windows: Mutex<Windows>,
}

fn native_error(error: impl std::fmt::Display) -> DesktopError {
    DesktopError::new("WINDOW_LAYOUT_FAILED", error.to_string(), true)
}
fn warn(error: impl std::fmt::Display) {
    crate::logger::log_entry(
        crate::models::LogLevel::Warn,
        crate::models::LogChannel::Core,
        "Unable to save window layout",
        Some(error.to_string()),
        None,
        None,
    );
}
impl WindowLayouts {
    pub fn load(config_dir: PathBuf) -> Self {
        let path = config_dir.join("window-layout.json");
        let mut saved = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Saved>(&bytes).ok())
            .unwrap_or_default();
        saved.project = saved.project.filter(Geometry::valid);
        Self {
            path,
            windows: Mutex::new(Windows {
                saved,
                entries: HashMap::new(),
                dirty: false,
            }),
        }
    }
    pub fn register(&self, label: &str, transferred: bool) {
        let mut windows = self.windows.lock().unwrap();
        let project = windows.saved.project;
        windows.entries.entry(label.into()).or_insert(Entry {
            workspace: transferred,
            project,
            welcome: None,
            epoch: 0,
            transitioning: false,
        });
    }
    fn persist(&self, windows: &Windows) -> Result<(), DesktopError> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(native_error)?;
        }
        let temp = self.path.with_extension("json.tmp");
        std::fs::write(
            &temp,
            serde_json::to_vec_pretty(&windows.saved).map_err(native_error)?,
        )
        .map_err(native_error)?;
        std::fs::rename(temp, &self.path).map_err(native_error)
    }
    fn flush_pending(&self, windows: &mut Windows) -> Result<(), DesktopError> {
        if windows.dirty {
            self.persist(windows)?;
            windows.dirty = false;
        }
        Ok(())
    }
    pub fn capture(&self, window: &Window) -> Result<(), DesktopError> {
        self.capture_inner(window, true)
    }
    fn capture_inner(&self, window: &Window, save: bool) -> Result<(), DesktopError> {
        if window.is_minimized().map_err(native_error)?
            || window.is_fullscreen().map_err(native_error)?
            || crate::window_surface::is_presenting_resize(window.label())
        {
            return if save {
                self.flush_pending(&mut self.windows.lock().unwrap())
            } else {
                Ok(())
            };
        }
        let maximized = window.is_maximized().map_err(native_error)?;
        let scale = window.scale_factor().map_err(native_error)?;
        let position = window.outer_position().map_err(native_error)?;
        let size = window
            .inner_size()
            .map_err(native_error)?
            .to_logical::<f64>(scale);
        let geometry = Geometry {
            x: f64::from(position.x),
            y: f64::from(position.y),
            width: size.width,
            height: size.height,
            maximized,
        };
        let mut windows = self.windows.lock().unwrap();
        windows.record(window.label(), geometry);
        if save {
            self.flush_pending(&mut windows)?;
        }
        Ok(())
    }
    fn area(window: &Window, geometry: Option<Geometry>) -> Area {
        let monitors = window.available_monitors().unwrap_or_default();
        let target = geometry
            .and_then(|geometry| {
                monitors
                    .iter()
                    .find(|monitor| Area::from_monitor(monitor).contains_center(geometry))
                    .cloned()
            })
            .or_else(|| window.current_monitor().ok().flatten())
            .or_else(|| window.primary_monitor().ok().flatten());
        target.as_ref().map(Area::from_monitor).unwrap_or(Area {
            x: 0.0,
            y: 0.0,
            width: 1600.0,
            height: 1000.0,
            scale: 1.0,
        })
    }
    fn set_mode(
        &self,
        window: &Window,
        workspace: bool,
        preserve: bool,
    ) -> Result<Option<Geometry>, DesktopError> {
        self.register(window.label(), preserve && workspace);
        let (same_mode, initialized) = {
            let windows = self.windows.lock().unwrap();
            let entry = &windows.entries[window.label()];
            (entry.workspace == workspace, entry.epoch > 0)
        };
        if same_mode && initialized {
            return Ok(None);
        }
        // Capture the project before making the same native window a welcome screen.
        if initialized && !same_mode {
            self.capture(window)?;
        }
        let (saved, epoch) = {
            let mut windows = self.windows.lock().unwrap();
            let entry = windows.entries.get_mut(window.label()).unwrap();
            entry.workspace = workspace;
            entry.transitioning = true;
            entry.epoch += 1;
            (
                if workspace {
                    entry.project
                } else {
                    entry.welcome
                },
                entry.epoch,
            )
        };
        let result = (|| {
            let area = Self::area(window, saved);
            window.set_resizable(workspace).map_err(native_error)?;
            window.set_maximizable(workspace).map_err(native_error)?;
            window
                .set_min_size(Some(tauri::LogicalSize::new(
                    800.0_f64.min((area.width - 20.0).max(1.0)),
                    480.0_f64.min((area.height - 40.0).max(1.0)),
                )))
                .map_err(native_error)?;
            let mut target = None;
            if !preserve {
                window.set_fullscreen(false).map_err(native_error)?;
                window.unmaximize().map_err(native_error)?;
                let geometry = saved
                    .map(|value| area.fit(value))
                    .unwrap_or_else(|| area.default_geometry(workspace));
                target = Some(geometry);
                window
                    .set_size(tauri::LogicalSize::new(geometry.width, geometry.height))
                    .map_err(native_error)?;
                window
                    .set_position(tauri::PhysicalPosition::new(
                        geometry.x.round() as i32,
                        geometry.y.round() as i32,
                    ))
                    .map_err(native_error)?;
                // Set normal bounds before maximizing, including the first launch.
                if workspace {
                    self.windows
                        .lock()
                        .unwrap()
                        .entries
                        .get_mut(window.label())
                        .unwrap()
                        .project = Some(geometry);
                    if geometry.maximized {
                        window.maximize().map_err(native_error)?;
                    }
                }
            }
            Ok(target)
        })();
        if let Some(entry) = self.windows.lock().unwrap().entries.get_mut(window.label()) {
            if entry.epoch == epoch {
                entry.transitioning = false;
            }
        }
        let target = result?;
        if preserve {
            self.capture(window)?;
        }
        Ok(target)
    }
    pub fn reset(&self, window: &Window) -> Result<(), DesktopError> {
        let workspace = {
            let mut windows = self.windows.lock().unwrap();
            windows.saved = Saved::default();
            for entry in windows.entries.values_mut() {
                entry.project = None;
                entry.welcome = None;
                entry.epoch += 1;
            }
            self.persist(&windows)?;
            windows.dirty = false;
            let entry = windows.entries.get_mut(window.label());
            entry
                .map(|entry| {
                    entry.epoch = 0;
                    entry.workspace
                })
                .unwrap_or(false)
        };
        self.set_mode(window, workspace, false).map(|_| ())
    }
    pub fn remove(&self, label: &str) {
        self.windows.lock().unwrap().entries.remove(label);
    }
}

#[cfg(target_os = "macos")]
pub fn native_resize_boundary(window: &Window) {
    if let Some(layouts) = window.app_handle().try_state::<WindowLayouts>() {
        if let Err(error) = layouts.capture_inner(window, false) {
            // Logging also emits to webviews. Leave AppKit's callback before
            // doing that; the caller may be inside a native window operation.
            tauri::async_runtime::spawn(async move { warn(error.message) });
        }
    }
}

pub fn window_event(window: &Window, event: &tauri::WindowEvent) {
    if !crate::windowing::is_business_window(window.label()) {
        return;
    }
    let Some(layouts) = window.app_handle().try_state::<WindowLayouts>() else {
        return;
    };
    match event {
        tauri::WindowEvent::Destroyed => layouts.remove(window.label()),
        tauri::WindowEvent::CloseRequested { .. } => {
            if let Err(error) = layouts.capture(window) {
                warn(error.message);
            }
        }
        tauri::WindowEvent::Moved(_)
        | tauri::WindowEvent::Resized(_)
        | tauri::WindowEvent::ScaleFactorChanged { .. } => {
            // Keep normal bounds immediately, even if maximize/fullscreen follows
            // before the disk debounce expires. Only the file write is delayed.
            if let Err(error) = layouts.capture_inner(window, false) {
                warn(error.message);
            }
            let epoch = {
                let mut windows = layouts.windows.lock().unwrap();
                let Some(entry) = windows.entries.get_mut(window.label()) else {
                    return;
                };
                if entry.transitioning {
                    return;
                }
                entry.epoch += 1;
                entry.epoch
            };
            let window = window.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(250)).await;
                let app = window.app_handle().clone();
                let _ = app.run_on_main_thread(move || {
                    let layouts = window.state::<WindowLayouts>();
                    let current = layouts
                        .windows
                        .lock()
                        .unwrap()
                        .entries
                        .get(window.label())
                        .is_some_and(|entry| entry.epoch == epoch && !entry.transitioning);
                    if current {
                        if let Err(error) = layouts.capture(&window) {
                            warn(error.message);
                        }
                    }
                });
            });
        }
        _ => {}
    }
}

async fn on_main_thread<T: Send + 'static>(
    window: &tauri::WebviewWindow,
    action: impl FnOnce(tauri::WebviewWindow) -> Result<T, DesktopError> + Send + 'static,
) -> Result<T, DesktopError> {
    let (send, receive) = tokio::sync::oneshot::channel();
    let current = window.clone();
    window
        .app_handle()
        .clone()
        .run_on_main_thread(move || {
            let _ = send.send(action(current));
        })
        .map_err(native_error)?;
    receive.await.map_err(native_error)?
}

fn matches_target(viewport: &WindowViewport, maximized: bool, target: Option<Geometry>) -> bool {
    viewport.width > 0.0
        && viewport.height > 0.0
        && target.is_none_or(|target| {
            maximized == target.maximized
                && (maximized
                    || ((viewport.width - target.width).abs() <= 1.0
                        && (viewport.height - target.height).abs() <= 1.0))
        })
}

pub async fn set_mode(
    window: tauri::WebviewWindow,
    workspace: bool,
    preserve: bool,
) -> Result<WindowViewport, DesktopError> {
    let (target, epoch) = on_main_thread(&window, move |window| {
        let layouts = window.state::<WindowLayouts>();
        let target = layouts.set_mode(&window.as_ref().window(), workspace, preserve)?;
        let mut windows = layouts.windows.lock().unwrap();
        let entry = windows
            .entries
            .get_mut(window.label())
            .ok_or_else(|| native_error("Window closed"))?;
        // Do not persist intermediate unmaximize/resize events as user geometry.
        entry.transitioning = true;
        Ok((target, entry.epoch))
    })
    .await?;
    let result = confirm_viewport(&window, target, epoch).await;
    let confirmed = result.as_ref().is_ok_and(|(_, confirmed)| *confirmed);
    let cleanup = on_main_thread(&window, move |window| {
        let layouts = window.state::<WindowLayouts>();
        let current = {
            let mut windows = layouts.windows.lock().unwrap();
            if let Some(entry) = windows
                .entries
                .get_mut(window.label())
                .filter(|entry| entry.epoch == epoch)
            {
                entry.transitioning = false;
                true
            } else {
                false
            }
        };
        if current && confirmed {
            layouts.capture(&window.as_ref().window())?;
        }
        Ok(())
    })
    .await;
    if let Err(error) = cleanup {
        warn(error.message);
    }
    result.map(|(viewport, _)| viewport)
}

async fn confirm_viewport(
    window: &tauri::WebviewWindow,
    target: Option<Geometry>,
    epoch: u64,
) -> Result<(WindowViewport, bool), DesktopError> {
    // set_size/unmaximize/maximize may enqueue OS work. Confirm the native result
    // instead of reporting the old webview bounds as the new content size.
    let deadline = tokio::time::Instant::now() + Duration::from_millis(1200);
    let mut previous = None;
    loop {
        let expired = tokio::time::Instant::now() >= deadline;
        on_main_thread(window, move |window| {
            if !window
                .state::<WindowLayouts>()
                .windows
                .lock()
                .unwrap()
                .entries
                .get(window.label())
                .is_some_and(|entry| entry.epoch == epoch)
            {
                return Err(native_error("Window layout request superseded"));
            }
            Ok(())
        })
        .await?;
        // A successful setter only means the resize was requested. Read both
        // webview layers on a later native turn before accepting the dimensions.
        let surface = crate::window_surface::synchronize(window).await?;
        let matching =
            surface.ready && matches_target(&surface.viewport, surface.maximized, target);
        let confirmed = matching && previous == Some(surface.sample);
        let done = confirmed || expired || surface.minimized;
        if done {
            if expired {
                crate::logger::log_entry(
                    crate::models::LogLevel::Warn,
                    crate::models::LogChannel::Core,
                    "Window resize confirmation timed out",
                    None,
                    None,
                    None,
                );
            }
            return Ok((surface.viewport, confirmed));
        }
        previous = matching.then_some(surface.sample);
        tokio::time::sleep(Duration::from_millis(16)).await;
    }
}
pub async fn reset(window: tauri::WebviewWindow) -> Result<(), DesktopError> {
    let (send, receive) = tokio::sync::oneshot::channel();
    window
        .app_handle()
        .clone()
        .run_on_main_thread(move || {
            let result = window
                .state::<WindowLayouts>()
                .reset(&window.as_ref().window());
            let _ = send.send(result);
        })
        .map_err(native_error)?;
    receive.await.map_err(native_error)?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn resize_confirmation_requires_target_content_size_and_maximize_state() {
        let target = Geometry {
            x: 0.0,
            y: 0.0,
            width: 1440.0,
            height: 900.0,
            maximized: false,
        };
        assert!(!matches_target(
            &WindowViewport {
                width: 880.0,
                height: 540.0
            },
            false,
            Some(target)
        ));
        assert!(!matches_target(
            &WindowViewport {
                width: 1440.0,
                height: 900.0
            },
            true,
            Some(target)
        ));
        assert!(matches_target(
            &WindowViewport {
                width: 1440.8,
                height: 899.6
            },
            false,
            Some(target)
        ));
        assert!(!matches_target(
            &WindowViewport {
                width: 0.0,
                height: 0.0
            },
            false,
            None
        ));
        let maximized = Geometry {
            maximized: true,
            ..target
        };
        assert!(!matches_target(
            &WindowViewport {
                width: 1440.0,
                height: 900.0
            },
            false,
            Some(maximized)
        ));
        assert!(matches_target(
            &WindowViewport {
                width: 1920.0,
                height: 1040.0
            },
            true,
            Some(maximized)
        ));
    }

    #[test]
    fn missing_monitor_and_smaller_work_area_keep_geometry_visible() {
        let area = Area {
            x: 0.0,
            y: 25.0,
            width: 1280.0,
            height: 775.0,
            scale: 1.0,
        };
        let old = Geometry {
            x: -3000.0,
            y: -900.0,
            width: 1920.0,
            height: 1200.0,
            maximized: true,
        };
        let fitted = area.fit(old);
        assert!(fitted.x >= area.x && fitted.y >= area.y);
        assert!(fitted.x + fitted.width <= area.x + area.width);
        assert!(fitted.y + fitted.height <= area.y + area.height);
        assert!(fitted.maximized);
        let negative = Area {
            x: -1920.0,
            y: 0.0,
            width: 1920.0,
            height: 1080.0,
            scale: 1.0,
        };
        assert!(negative.contains_center(Geometry {
            x: -1800.0,
            y: 100.0,
            width: 1200.0,
            height: 800.0,
            maximized: false
        }));
    }
    #[test]
    fn welcome_and_each_live_window_keep_independent_project_bounds() {
        let root = tempfile::tempdir().unwrap();
        let layouts = WindowLayouts::load(root.path().into());
        let project = Geometry {
            x: 60.0,
            y: 90.0,
            width: 1300.0,
            height: 850.0,
            maximized: true,
        };
        {
            let mut windows = layouts.windows.lock().unwrap();
            windows.saved.project = Some(project);
            layouts.persist(&windows).unwrap();
        }
        let restored = WindowLayouts::load(root.path().into());
        restored.register("main", false);
        restored.register("window-second", true);
        let mut windows = restored.windows.lock().unwrap();
        windows.entries.get_mut("main").unwrap().welcome = Some(Geometry {
            width: 880.0,
            height: 540.0,
            ..project
        });
        windows
            .entries
            .get_mut("window-second")
            .unwrap()
            .project
            .as_mut()
            .unwrap()
            .x = 300.0;
        assert_eq!(windows.entries["main"].project, Some(project));
        assert_eq!(windows.saved.project, Some(project));
        assert_ne!(
            windows.entries["main"].project,
            windows.entries["window-second"].project
        );
    }
    #[test]
    fn resize_intermediate_bounds_do_not_replace_saved_project_geometry() {
        let root = tempfile::tempdir().unwrap();
        let layouts = WindowLayouts::load(root.path().into());
        layouts.register("main", true);
        let project = Geometry {
            x: 180.0,
            y: 100.0,
            width: 1440.0,
            height: 900.0,
            maximized: false,
        };
        let intermediate = Geometry {
            width: 880.0,
            height: 540.0,
            ..project
        };
        let mut windows = layouts.windows.lock().unwrap();
        windows.record("main", project);
        windows.entries.get_mut("main").unwrap().transitioning = true;
        windows.record("main", intermediate);
        assert_eq!(windows.saved.project, Some(project));
        layouts.flush_pending(&mut windows).unwrap();
        let restored = WindowLayouts::load(root.path().into());
        assert_eq!(
            restored.windows.lock().unwrap().saved.project,
            Some(project)
        );
        windows.entries.get_mut("main").unwrap().transitioning = false;
        windows.record("main", intermediate);
        assert_eq!(windows.saved.project, Some(intermediate));
    }

    #[test]
    fn maximizing_immediately_after_resize_preserves_normal_bounds_before_debounced_save() {
        let root = tempfile::tempdir().unwrap();
        let layouts = WindowLayouts::load(root.path().into());
        layouts.register("main", true);
        let normal = Geometry {
            x: 180.0,
            y: 130.0,
            width: 1380.0,
            height: 820.0,
            maximized: false,
        };
        let screen = Geometry {
            x: 0.0,
            y: 0.0,
            width: 1920.0,
            height: 1080.0,
            maximized: true,
        };
        let mut windows = layouts.windows.lock().unwrap();
        windows.record("main", normal);
        windows.record("main", screen);
        assert!(windows.dirty);
        layouts.flush_pending(&mut windows).unwrap();
        assert!(!windows.dirty);
        drop(windows);
        let saved = WindowLayouts::load(root.path().into());
        assert_eq!(
            saved.windows.lock().unwrap().saved.project,
            Some(Geometry {
                maximized: true,
                ..normal
            })
        );
        let scaled = Area {
            x: -3840.0,
            y: 0.0,
            width: 1920.0,
            height: 1080.0,
            scale: 2.0,
        };
        let fitted = scaled.fit(Geometry {
            x: -3500.0,
            y: 100.0,
            ..normal
        });
        assert!(scaled.contains_center(fitted));
        assert!(fitted.x + fitted.width * 2.0 <= 0.0);
        assert!(fitted.y + (fitted.height + 40.0) * 2.0 <= 2160.0);
    }

    #[test]
    fn damaged_or_invalid_geometry_falls_back_without_losing_app_settings() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(
            root.path().join("window-layout.json"),
            r#"{"project":{"x":0,"y":0,"width":0,"height":100}}"#,
        )
        .unwrap();
        assert!(WindowLayouts::load(root.path().into())
            .windows
            .lock()
            .unwrap()
            .saved
            .project
            .is_none());
    }
}
