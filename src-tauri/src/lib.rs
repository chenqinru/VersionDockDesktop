#![allow(
    clippy::field_reassign_with_default,
    clippy::large_enum_variant,
    clippy::result_large_err,
    clippy::too_many_arguments
)]

mod ai;
mod app_updater;
mod changelist;
mod cli;
mod commands;
mod diff_content;
#[cfg(target_os = "linux")]
mod gtk_preview;
mod http_client;
mod identity;
mod interactions;
pub mod logger;
mod models;
mod protection;
mod provider;
mod shelf;
mod state;
mod svn_account;
mod tab_drag;
mod tray;
mod update_worker;
mod vcs;
mod windowing;
mod workspace;

#[cfg(test)]
mod integration_tests;

use state::AppState;
use tauri::Manager;

#[cfg(target_os = "macos")]
fn application_menu(
    app: &tauri::AppHandle<tauri::Wry>,
) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{AboutMetadata, Menu, PredefinedMenuItem};

    let menu = Menu::default(app)?;
    let first_item = menu.items()?.into_iter().next().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "the macOS default application menu is missing",
        )
    })?;
    let application_submenu = first_item.as_submenu().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "the first macOS menu item is not the application submenu",
        )
    })?;
    let package = app.package_info();
    let about = PredefinedMenuItem::about(
        app,
        None,
        Some(AboutMetadata {
            name: Some(package.name.clone()),
            version: Some(package.version.to_string()),
            copyright: app.config().bundle.copyright.clone(),
            authors: app
                .config()
                .bundle
                .publisher
                .clone()
                .map(|value| vec![value]),
            icon: app.default_window_icon().cloned(),
            ..Default::default()
        }),
    )?;

    application_submenu.remove_at(0)?;
    application_submenu.insert(&about, 0)?;
    Ok(menu)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if update_worker::run_if_worker() {
        return;
    }
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder.menu(application_menu);

    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_system_symbols::init())
        .plugin(tauri_plugin_window_controls::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_filter(|_| false)
                .build(),
        )
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            let log_dir = config_dir.join("logs");
            let logger = logger::init_global_logger(log_dir);
            logger.set_app_handle(app.handle().clone());
            app.manage(AppState::load(config_dir));
            app.manage(tray::TrayState::default());
            tray::schedule_refresh(app.handle());

            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_fullscreen(false);
                let _ = window.unmaximize();
                let _ = window.set_resizable(false);
                let _ = window.set_maximizable(false);
                let _ = window.set_size(tauri::LogicalSize::new(880.0, 540.0));
                let _ = window.center();

                #[cfg(target_os = "windows")]
                {
                    use tauri_plugin_window_controls::WindowControlsExt;
                    let _ = window.set_title_bar_height(38);
                    let _ = window.set_title_bar_overlay(true);
                }
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                tray::close_requested(window, api);
            }
            if matches!(event, tauri::WindowEvent::Destroyed) {
                let state = window.state::<AppState>();
                let _ = state.unregister_window(window.label());
                if !state.has_registered_windows() {
                    let app = window.app_handle().clone();
                    tauri::async_runtime::spawn(async move {
                        app.state::<AppState>().cancel_all().await;
                    });
                }
            }
            tray::window_event(window.app_handle(), window.label(), event);
        })
        .invoke_handler(tauri::generate_handler![
            commands::bridge_request,
            commands::bridge_cancel,
            interactions::respond_native_interaction,
            commands::follow_tab_drag_preview,
            app_updater::check_update_mirror,
            app_updater::restart_app
        ])
        .build(tauri::generate_context!())
        .expect("error while building VersionDock Desktop")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
                tray::mark_exiting(app);
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    app.state::<AppState>().cancel_all().await;
                });
            }
        });
    if let Some(logger) = logger::get_logger() {
        let _ = logger.flush();
    }
}

#[cfg(test)]
mod binding_tests {
    use std::path::PathBuf;

    #[test]
    fn export_bindings() {
        let output = specta_typescript::Typescript::default()
            .header("// This file is generated by Rust. Do not edit.\n")
            .export(&specta::collect(), specta_serde::Format)
            .expect("TypeScript bindings should export");
        let target = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../src/bindings/generated.ts");
        std::fs::create_dir_all(target.parent().expect("binding parent"))
            .expect("binding directory");
        std::fs::write(target, output).expect("write generated bindings");
        let defaults = serde_json::json!({
            "settings": crate::models::DesktopSettings::default(),
            "layout": crate::models::LayoutState::default(),
        });
        let target = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../src/settings/defaults.generated.json");
        std::fs::create_dir_all(target.parent().expect("defaults parent"))
            .expect("defaults directory");
        std::fs::write(
            target,
            format!(
                "{}\n",
                serde_json::to_string_pretty(&defaults).expect("serialize defaults")
            ),
        )
        .expect("write generated setting defaults");
    }
}
