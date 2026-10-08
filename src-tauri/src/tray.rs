//! Optional process-wide shortcut menu. Window closing and background work stay unchanged.
use crate::{
    logger::{self, LogChannel, LogLevel},
    models::{CapabilityStatus, LanguagePreference, WorkspaceDescriptor},
    state::AppState,
    windowing,
};
use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::TrayIconBuilder,
    AppHandle, Manager,
};

const TRAY_LABEL: &str = if cfg!(dev) {
    "VersionDock Desktop (Dev)"
} else {
    "VersionDock Desktop"
};
const TRAY_ID: &str = "versiondock-shortcuts";
const OPEN: &str = "versiondock-tray-open";
const QUIT: &str = "versiondock-tray-quit";
const PROJECT: &str = "versiondock-tray-project-";

pub struct TrayState {
    update_lock: tokio::sync::Mutex<()>,
    open_lock: tokio::sync::Mutex<()>,
    focus_order: Mutex<Vec<String>>,
    status: Mutex<CapabilityStatus>,
    keep_on_close: AtomicBool,
    exiting: AtomicBool,
    hidden_windows: Mutex<HashSet<String>>,
}

impl Default for TrayState {
    fn default() -> Self {
        Self {
            update_lock: Default::default(),
            open_lock: Default::default(),
            focus_order: Default::default(),
            keep_on_close: AtomicBool::new(false),
            exiting: AtomicBool::new(false),
            hidden_windows: Default::default(),
            status: Mutex::new(CapabilityStatus::unavailable(
                "TRAY_ICON_NOT_READY",
                "Tray initialization is pending",
            )),
        }
    }
}

pub fn capability(app: &AppHandle) -> CapabilityStatus {
    app.try_state::<TrayState>()
        .and_then(|state| state.status.lock().ok().map(|status| status.clone()))
        .unwrap_or_else(|| {
            CapabilityStatus::unavailable("TRAY_ICON_NOT_READY", "Tray initialization is pending")
        })
}

pub fn focus_order(app: &AppHandle) -> Vec<String> {
    app.try_state::<TrayState>()
        .and_then(|state| state.focus_order.lock().ok().map(|order| order.clone()))
        .unwrap_or_default()
}

// Exit requests are never intercepted; this flag also bypasses close handling during shutdown.
pub fn mark_exiting(app: &AppHandle) {
    if let Some(state) = app.try_state::<TrayState>() {
        state.exiting.store(true, Ordering::SeqCst);
    }
}

fn may_reveal_startup(exiting: bool, hidden: bool) -> bool {
    !exiting && !hidden
}

pub async fn reveal_startup_window(
    app: &AppHandle,
    window: &tauri::WebviewWindow,
) -> Result<bool, crate::models::DesktopError> {
    let handle = app.clone();
    let window = window.clone();
    let (send, receive) = tokio::sync::oneshot::channel();
    // Serialize this check and native show with CloseRequested on the UI thread.
    app.run_on_main_thread(move || {
        let allowed = handle.try_state::<TrayState>().is_none_or(|state| {
            let hidden = state
                .hidden_windows
                .lock()
                .map(|hidden| hidden.contains(window.label()))
                .unwrap_or(true);
            may_reveal_startup(state.exiting.load(Ordering::SeqCst), hidden)
        });
        let result = if allowed {
            windowing::restore_window(&window).map(|_| true)
        } else {
            Ok(false)
        };
        let _ = send.send(result);
    })
    .map_err(|error| {
        crate::models::DesktopError::new("WINDOW_FOCUS_FAILED", error.to_string(), true)
    })?;
    receive.await.map_err(|error| {
        crate::models::DesktopError::new("WINDOW_FOCUS_FAILED", error.to_string(), true)
    })?
}

pub fn reveal_for_interaction(app: &AppHandle, label: &str) {
    let Some(state) = app.try_state::<TrayState>() else {
        return;
    };
    let hidden = state
        .hidden_windows
        .lock()
        .map(|hidden| hidden.contains(label))
        .unwrap_or(false);
    if hidden {
        if let Some(window) = app.get_webview_window(label) {
            if let Err(error) = windowing::restore_window(&window) {
                warn("Unable to show operation prompt", error.message);
            }
        }
    }
}

fn should_hide_on_close(label: &str, enabled: bool, tray_available: bool, exiting: bool) -> bool {
    windowing::is_business_window(label) && enabled && tray_available && !exiting
}

pub fn close_requested(window: &tauri::Window, api: &tauri::CloseRequestApi) {
    let Some(state) = window.app_handle().try_state::<TrayState>() else {
        return;
    };
    if !should_hide_on_close(
        window.label(),
        state.keep_on_close.load(Ordering::SeqCst),
        capability(window.app_handle()).available,
        state.exiting.load(Ordering::SeqCst),
    ) {
        return;
    }
    // Track only windows hidden by this feature, never startup or drag-preview windows.
    let Ok(mut hidden) = state.hidden_windows.lock() else {
        return;
    };
    match window.hide() {
        Ok(()) => {
            hidden.insert(window.label().to_string());
            api.prevent_close();
        }
        Err(error) => warn("Unable to keep window in tray", error),
    }
}

fn restore_hidden_windows(app: &AppHandle, state: &TrayState) -> bool {
    let Ok(labels) = state.hidden_windows.lock().map(|labels| labels.clone()) else {
        return false;
    };
    for label in labels {
        let restored = app
            .get_webview_window(&label)
            .is_none_or(|window| match window.show() {
                Ok(()) => true,
                Err(error) => {
                    warn("Unable to restore hidden window", error);
                    false
                }
            });
        if restored {
            if let Ok(mut hidden) = state.hidden_windows.lock() {
                hidden.remove(&label);
            }
        }
    }
    state
        .hidden_windows
        .lock()
        .map(|hidden| hidden.is_empty())
        .unwrap_or(false)
}

pub fn window_event(app: &AppHandle, label: &str, event: &tauri::WindowEvent) {
    if !windowing::is_business_window(label) {
        return;
    }
    let Some(state) = app.try_state::<TrayState>() else {
        return;
    };
    if matches!(event, tauri::WindowEvent::Destroyed)
        || (matches!(event, tauri::WindowEvent::Focused(true))
            && app
                .get_webview_window(label)
                .is_some_and(|window| window.is_visible().unwrap_or(false)))
    {
        if let Ok(mut hidden) = state.hidden_windows.lock() {
            hidden.remove(label);
        }
    }
    match event {
        tauri::WindowEvent::Focused(true) => {
            if let Ok(mut order) = state.focus_order.lock() {
                order.retain(|value| value != label);
                order.push(label.to_string());
            }
        }
        tauri::WindowEvent::Destroyed => {
            if let Ok(mut order) = state.focus_order.lock() {
                order.retain(|value| value != label);
            }
        }
        _ => return,
    }
    schedule_refresh(app);
}

pub fn schedule_refresh(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        refresh(&app).await;
    });
}

fn warn(message: &str, error: impl std::fmt::Display) {
    logger::log_entry(
        LogLevel::Warn,
        LogChannel::Core,
        message,
        Some(error.to_string()),
        None,
        None,
    );
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ProjectEntry {
    id: String,
    name: String,
    title: String,
    paths: Vec<String>,
    window_label: String,
}

fn project_entries(
    windows: &HashMap<String, Vec<Vec<String>>>,
    descriptors: &[WorkspaceDescriptor],
    order: &[String],
) -> Vec<ProjectEntry> {
    let mut grouped: HashMap<String, (Vec<String>, Vec<String>)> = HashMap::new();
    for (label, tabs) in windows {
        if !windowing::is_business_window(label) {
            continue;
        }
        for paths in tabs.iter().filter(|paths| !paths.is_empty()) {
            let item = grouped
                .entry(crate::state::workspace_id(paths))
                .or_insert_with(|| (paths.clone(), vec![]));
            item.1.push(label.clone());
        }
    }
    let mut entries = grouped
        .into_iter()
        .filter_map(|(id, (paths, labels))| {
            let window_label = windowing::preferred_window(&labels, order)?;
            let name = descriptors
                .iter()
                .find(|item| windowing::paths_match(&item.paths, &paths))
                .map(|item| item.name.clone())
                .unwrap_or_else(|| {
                    if paths.len() == 1 {
                        paths[0]
                            .trim_end_matches(['/', '\\'])
                            .rsplit(['/', '\\'])
                            .next()
                            .filter(|name| !name.is_empty())
                            .unwrap_or(&paths[0])
                            .to_string()
                    } else {
                        format!("{} roots", paths.len())
                    }
                });
            Some(ProjectEntry {
                id,
                title: name.clone(),
                name,
                paths,
                window_label,
            })
        })
        .collect::<Vec<_>>();
    let mut counts = HashMap::new();
    for entry in &entries {
        *counts.entry(entry.name.to_lowercase()).or_insert(0usize) += 1;
    }
    for entry in &mut entries {
        if counts[&entry.name.to_lowercase()] > 1 {
            entry.title = format!("{} — {}", entry.name, entry.paths.join("; "));
        }
    }
    entries.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| a.title.cmp(&b.title))
            .then_with(|| a.id.cmp(&b.id))
    });
    entries
}

fn chinese(preference: &LanguagePreference, locale: Option<&str>) -> bool {
    match preference {
        LanguagePreference::ZhCn => true,
        LanguagePreference::En => false,
        LanguagePreference::System => locale
            .unwrap_or("en")
            .to_ascii_lowercase()
            .starts_with("zh"),
    }
}

fn menu(app: &AppHandle, entries: &[ProjectEntry], zh: bool) -> tauri::Result<Menu<tauri::Wry>> {
    let open = MenuItem::with_id(
        app,
        OPEN,
        if zh { "打开窗口" } else { "Open Window" },
        true,
        None::<&str>,
    )?;
    let projects = Submenu::new(
        app,
        if zh {
            "已打开项目"
        } else {
            "Open Projects"
        },
        true,
    )?;
    if entries.is_empty() {
        projects.append(&MenuItem::new(
            app,
            if zh {
                "暂无打开项目"
            } else {
                "No Open Projects"
            },
            false,
            None::<&str>,
        )?)?;
    } else {
        for entry in entries {
            projects.append(&MenuItem::with_id(
                app,
                format!("{PROJECT}{}", entry.id),
                &entry.title,
                true,
                None::<&str>,
            )?)?;
        }
    }
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(
        app,
        QUIT,
        if zh {
            "退出 VersionDock Desktop"
        } else {
            "Quit VersionDock Desktop"
        },
        true,
        None::<&str>,
    )?;
    let menu = Menu::new(app)?;
    if cfg!(dev) {
        menu.append(&MenuItem::new(app, TRAY_LABEL, false, None::<&str>)?)?;
        menu.append(&PredefinedMenuItem::separator(app)?)?;
    }
    for item in [
        &open as &dyn tauri::menu::IsMenuItem<tauri::Wry>,
        &projects,
        &separator,
        &quit,
    ] {
        menu.append(item)?;
    }
    Ok(menu)
}

fn registered_windows(app: &AppHandle) -> HashMap<String, Vec<Vec<String>>> {
    let state = app.state::<AppState>();
    let mut windows = state
        .window_workspaces
        .lock()
        .map(|windows| windows.clone())
        .unwrap_or_default();
    windows.retain(|label, _| {
        windowing::is_business_window(label) && app.get_webview_window(label).is_some()
    });
    windows
}

pub async fn refresh(app: &AppHandle) {
    let Some(controller) = app.try_state::<TrayState>() else {
        return;
    };
    // Read after acquiring the lock: a queued older refresh cannot overwrite newer settings.
    let _guard = controller.update_lock.lock().await;
    if controller.exiting.load(Ordering::SeqCst) {
        return;
    }
    let snapshot = app.state::<AppState>().app.read().await.clone();
    let may_hide = snapshot.settings.close_to_tray;
    // Stop intercepting close before revealing sessions when the preference is disabled.
    if !may_hide {
        controller.keep_on_close.store(false, Ordering::SeqCst);
    }
    let restored = may_hide || restore_hidden_windows(app, &controller);
    // If revealing a hidden window fails, keep its recovery entry accessible.
    let show_icon = snapshot.settings.show_tray_icon || !restored;
    let result = if !show_icon {
        app.tray_by_id(TRAY_ID)
            .map(|icon| icon.set_visible(false))
            .unwrap_or(Ok(()))
    } else {
        let entries = project_entries(
            &registered_windows(app),
            &snapshot.recent_workspaces,
            &focus_order(app),
        );
        let zh = chinese(
            &snapshot.settings.language,
            tauri_plugin_os::locale().as_deref(),
        );
        update_icon(app, &entries, zh)
    };
    let status = match result {
        Ok(()) if show_icon => CapabilityStatus::available(),
        Ok(()) => CapabilityStatus::unavailable(
            "TRAY_ICON_DISABLED",
            "Tray shortcuts are disabled in settings",
        ),
        Err(error) => {
            warn("Unable to update tray shortcuts", &error);
            CapabilityStatus::unavailable("TRAY_ICON_UNAVAILABLE", error.to_string())
        }
    };
    controller
        .keep_on_close
        .store(may_hide && status.available, Ordering::SeqCst);
    if !status.available {
        restore_hidden_windows(app, &controller);
    }
    if let Ok(mut current) = controller.status.lock() {
        *current = status;
    };
}

fn update_icon(app: &AppHandle, entries: &[ProjectEntry], zh: bool) -> tauri::Result<()> {
    let menu = menu(app, entries, zh)?;
    if let Some(icon) = app.tray_by_id(TRAY_ID) {
        icon.set_menu(Some(menu))?;
        return icon.set_visible(true);
    }
    #[cfg(target_os = "macos")]
    let icon = tauri::image::Image::new(include_bytes!("../icons/tray-template.rgba"), 36, 36);
    #[cfg(not(target_os = "macos"))]
    let icon = tauri::image::Image::new(
        if cfg!(dev) {
            include_bytes!("../icons/tray-brand-dev.rgba")
        } else {
            include_bytes!("../icons/tray-brand.rgba")
        },
        32,
        32,
    );
    let builder = TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .icon_as_template(cfg!(target_os = "macos"))
        .tooltip(TRAY_LABEL)
        .menu(&menu)
        .show_menu_on_left_click(!cfg!(target_os = "windows"))
        .on_menu_event(|app, event| {
            let id = event.id().as_ref().to_string();
            if id != OPEN && id != QUIT && !id.starts_with(PROJECT) {
                return;
            }
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                handle_menu(&app, &id).await;
            });
        });
    #[cfg(all(dev, target_os = "macos"))]
    let builder = builder.title("Dev");
    #[cfg(target_os = "windows")]
    let builder = builder.on_tray_icon_event(|icon, event| {
        if matches!(
            event,
            tauri::tray::TrayIconEvent::Click {
                button: tauri::tray::MouseButton::Left,
                button_state: tauri::tray::MouseButtonState::Up,
                ..
            }
        ) {
            let app = icon.app_handle().clone();
            tauri::async_runtime::spawn(async move {
                handle_menu(&app, OPEN).await;
            });
        }
    });
    // Keep the one native icon registered while disabled, avoiding duplicate menu listeners.
    builder.build(app)?;
    Ok(())
}

async fn handle_menu(app: &AppHandle, id: &str) {
    if !app
        .state::<AppState>()
        .app
        .read()
        .await
        .settings
        .show_tray_icon
    {
        return;
    }
    let result = if id == OPEN {
        open_window(app).await
    } else if id == QUIT {
        mark_exiting(app);
        app.state::<AppState>().cancel_all().await;
        app.exit(0);
        return;
    } else if let Some(project_id) = id.strip_prefix(PROJECT) {
        let snapshot = app.state::<AppState>().app.read().await.clone();
        let entries = project_entries(
            &registered_windows(app),
            &snapshot.recent_workspaces,
            &focus_order(app),
        );
        if let Some(entry) = entries.iter().find(|entry| entry.id == project_id) {
            windowing::focus_workspace(app, &entry.paths, None, &focus_order(app)).map(|_| ())
        } else {
            Ok(())
        }
    } else {
        return;
    };
    if let Err(error) = result {
        warn("Unable to open tray shortcut", error.message);
    }
    refresh(app).await;
}

async fn open_window(app: &AppHandle) -> Result<(), crate::models::DesktopError> {
    let controller = app.state::<TrayState>();
    let _guard = controller.open_lock.lock().await;
    // Include not-yet-registered welcome windows so repeated clicks never create duplicates.
    let labels = app
        .webview_windows()
        .keys()
        .filter(|label| windowing::is_business_window(label))
        .cloned()
        .collect::<Vec<_>>();
    if let Some(label) = windowing::preferred_window(&labels, &focus_order(app)) {
        if let Some(window) = app.get_webview_window(&label) {
            return windowing::restore_window(&window);
        }
    }
    windowing::create_window(
        app,
        &app.state::<AppState>(),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn windows(values: &[(&str, &[&str])]) -> HashMap<String, Vec<Vec<String>>> {
        values
            .iter()
            .map(|(label, paths)| {
                (
                    label.to_string(),
                    paths.iter().map(|path| vec![path.to_string()]).collect(),
                )
            })
            .collect()
    }
    #[test]
    fn delayed_startup_reveal_does_not_reopen_hidden_or_exiting_windows() {
        assert!(may_reveal_startup(false, false));
        assert!(!may_reveal_startup(false, true));
        assert!(!may_reveal_startup(true, false));
    }

    #[test]
    fn close_policy_keeps_only_business_windows_with_a_working_tray() {
        assert!(should_hide_on_close("main", true, true, false));
        assert!(should_hide_on_close("window-2", true, true, false));
        assert!(!should_hide_on_close("main", false, true, false));
        assert!(!should_hide_on_close("main", true, false, false));
        assert!(!should_hide_on_close("main", true, true, true));
        assert!(!should_hide_on_close(
            "tab-drag-preview-2",
            true,
            true,
            false
        ));
    }

    #[tokio::test]
    async fn close_to_tray_enables_and_persists_its_recovery_entry() {
        let directory = tempfile::tempdir().unwrap();
        let state = AppState::load(directory.path().to_path_buf());
        let mut settings = state.app.read().await.settings.clone();
        settings.show_tray_icon = false;
        state
            .update_settings(settings, Some(&["showTrayIcon".into()]))
            .await
            .unwrap();
        let mut settings = state.app.read().await.settings.clone();
        settings.close_to_tray = true;
        let result = state
            .update_settings(settings, Some(&["closeToTray".into()]))
            .await
            .unwrap();
        assert!(result.settings.close_to_tray && result.settings.show_tray_icon);
        let mut settings = result.settings;
        settings.show_tray_icon = false;
        let result = state
            .update_settings(settings, Some(&["showTrayIcon".into()]))
            .await
            .unwrap();
        assert!(result.settings.show_tray_icon);
        let restored = AppState::load(directory.path().to_path_buf());
        let snapshot = restored.app.read().await;
        assert!(snapshot.settings.close_to_tray && snapshot.settings.show_tray_icon);
        drop(snapshot);
        let mut settings = result.settings;
        settings.close_to_tray = false;
        state
            .update_settings(settings, Some(&["closeToTray".into()]))
            .await
            .unwrap();
        let mut settings = state.app.read().await.settings.clone();
        settings.show_tray_icon = false;
        let result = state
            .update_settings(settings, Some(&["showTrayIcon".into()]))
            .await
            .unwrap();
        assert!(!result.settings.close_to_tray && !result.settings.show_tray_icon);
    }

    #[test]
    fn projects_sort_disambiguate_and_exclude_preview_windows() {
        let entries = project_entries(
            &windows(&[
                ("main", &["/a/zoo", "/a/App"]),
                ("window-2", &["/b/App"]),
                ("tab-drag-preview-x", &["/preview"]),
            ]),
            &[],
            &[],
        );
        assert_eq!(
            entries
                .iter()
                .map(|entry| entry.name.as_str())
                .collect::<Vec<_>>(),
            ["App", "App", "zoo"]
        );
        assert_eq!(entries[0].title, "App — /a/App");
        assert_eq!(entries[1].title, "App — /b/App");
    }
    #[test]
    fn duplicate_project_prefers_most_recent_window_and_disappears_when_closed() {
        let order = vec!["main".into(), "window-2".into()];
        let mut values = windows(&[("main", &["/same"]), ("window-2", &["/same"])]);
        let entries = project_entries(&values, &[], &order);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].window_label, "window-2");
        let old_id = entries[0].id.clone();
        values.remove("window-2");
        assert_eq!(
            project_entries(&values, &[], &order)[0].window_label,
            "main"
        );
        values.clear();
        assert!(project_entries(&values, &[], &order)
            .iter()
            .all(|entry| entry.id != old_id));
    }
    #[test]
    fn multiple_roots_use_existing_workspace_name_and_order_independent_identity() {
        let paths = vec!["/a".into(), "/b".into()];
        let descriptor = WorkspaceDescriptor {
            id: crate::state::workspace_id(&paths),
            name: "Two projects".into(),
            paths: paths.clone(),
            last_opened_at: String::new(),
            available: true,
        };
        let windows = HashMap::from([
            ("main".into(), vec![paths]),
            ("window-2".into(), vec![vec!["/b".into(), "/a".into()]]),
        ]);
        let entries = project_entries(&windows, &[descriptor], &[]);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].title, "Two projects");
    }
    #[test]
    fn language_matches_preference_and_system_locale() {
        assert!(chinese(&LanguagePreference::ZhCn, Some("en-US")));
        assert!(!chinese(&LanguagePreference::En, Some("zh-CN")));
        assert!(chinese(&LanguagePreference::System, Some("ZH-Hans-CN")));
        assert!(!chinese(&LanguagePreference::System, None));
    }
    #[tokio::test]
    async fn tray_preference_is_persisted_without_changing_other_settings() {
        let directory = tempfile::tempdir().unwrap();
        let state = AppState::load(directory.path().to_path_buf());
        let mut settings = state.app.read().await.settings.clone();
        settings.show_tray_icon = false;
        settings.auto_fetch_interval_minutes = 123;
        state
            .update_settings(settings, Some(&["showTrayIcon".into()]))
            .await
            .unwrap();
        let restored = AppState::load(directory.path().to_path_buf());
        let snapshot = restored.app.read().await;
        assert!(!snapshot.settings.show_tray_icon);
        assert_eq!(snapshot.settings.auto_fetch_interval_minutes, 15);
    }

    #[test]
    fn embedded_icons_have_tightly_packed_rgba_and_a_transparent_template() {
        let template = include_bytes!("../icons/tray-template.rgba");
        let brand = include_bytes!("../icons/tray-brand.rgba");
        assert_eq!(template.len(), 36 * 36 * 4);
        assert_eq!(brand.len(), 32 * 32 * 4);
        assert!(template
            .as_chunks::<4>()
            .0
            .iter()
            .all(|pixel| pixel[..3] == [0, 0, 0]));
        assert!(template
            .as_chunks::<4>()
            .0
            .iter()
            .any(|pixel| pixel[3] == 0));
        assert!(template
            .as_chunks::<4>()
            .0
            .iter()
            .any(|pixel| pixel[3] == 255));
    }

    #[test]
    fn legacy_settings_default_to_visible_and_explicit_off_survives() {
        let mut json = serde_json::to_value(crate::models::DesktopSettings::default()).unwrap();
        json.as_object_mut().unwrap().remove("showTrayIcon");
        json.as_object_mut().unwrap().remove("closeToTray");
        assert!(
            !serde_json::from_value::<crate::models::DesktopSettings>(json.clone())
                .unwrap()
                .close_to_tray
        );
        assert!(
            serde_json::from_value::<crate::models::DesktopSettings>(json.clone())
                .unwrap()
                .show_tray_icon
        );
        json["showTrayIcon"] = false.into();
        assert!(
            !serde_json::from_value::<crate::models::DesktopSettings>(json)
                .unwrap()
                .show_tray_icon
        );
    }
}
