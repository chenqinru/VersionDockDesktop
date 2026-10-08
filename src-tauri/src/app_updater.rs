use std::time::Duration;

use tauri::Manager;
use tauri_plugin_updater::UpdaterExt;

#[tauri::command]
pub async fn restart_app(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let env = app.env();
        let binary = tauri::process::current_binary(&env).map_err(|error| error.to_string())?;
        if let Some(bundle) = macos_app_bundle(&binary) {
            // Launch Services transfers activation to the updated .app. Spawning
            // Contents/MacOS directly can leave the new instance in the background.
            let status = tokio::process::Command::new("/usr/bin/open")
                .arg("-n")
                .arg(bundle)
                .arg("--args")
                .args(env.args_os.iter().skip(1))
                .status()
                .await
                .map_err(|error| format!("Unable to restart application: {error}"))?;
            if !status.success() {
                return Err(format!("Unable to restart application: {status}"));
            }
            // Exit only after the system has accepted the new application launch.
            app.exit(0);
            return Ok(());
        }
    }
    // Unbundled development binaries and other platforms keep Tauri's restart.
    app.request_restart();
    Ok(())
}

#[cfg(target_os = "macos")]
fn macos_app_bundle(binary: &std::path::Path) -> Option<&std::path::Path> {
    let macos = binary.parent()?;
    let contents = macos.parent()?;
    let bundle = contents.parent()?;
    (macos.file_name()? == "MacOS"
        && contents.file_name()? == "Contents"
        && bundle.extension()? == "app")
        .then_some(bundle)
}

#[cfg(all(test, target_os = "macos"))]
mod restart_tests {
    use super::macos_app_bundle;
    use std::path::Path;

    #[test]
    fn restart_resolves_the_bundle_with_spaces_and_unicode() {
        let binary =
            Path::new("/Applications/版本工具 VersionDock.app/Contents/MacOS/versiondock-desktop");
        assert_eq!(
            macos_app_bundle(binary),
            Some(Path::new("/Applications/版本工具 VersionDock.app"))
        );
        assert!(macos_app_bundle(Path::new("/tmp/target/debug/versiondock-desktop")).is_none());
        assert!(macos_app_bundle(Path::new(
            "/tmp/VersionDock.app/Other/MacOS/versiondock-desktop"
        ))
        .is_none());
    }
}

// Select only configured mirrors. No URL or publishing credential comes from
// the webview, and installation still uses the official signature verifier.
#[tauri::command]
pub async fn check_update_mirror(
    webview: tauri::Webview,
) -> Result<Option<serde_json::Value>, String> {
    let config: tauri_plugin_updater::Config = serde_json::from_value(
        webview
            .config()
            .plugins
            .0
            .get("updater")
            .cloned()
            .ok_or("Updater configuration is missing")?,
    )
    .map_err(|error| error.to_string())?;
    let endpoints = config.endpoints.into_iter().skip(1).collect::<Vec<_>>();
    if endpoints.is_empty() {
        return Ok(None);
    }
    let update = webview
        .updater_builder()
        .endpoints(endpoints)
        .map_err(|error| error.to_string())?
        .timeout(Duration::from_secs(15))
        .header("Cache-Control", "no-cache")
        .map_err(|error| error.to_string())?
        .build()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| error.to_string())?;
    Ok(update.map(|update| {
        let metadata = serde_json::json!({
            "currentVersion": update.current_version,
            "version": update.version,
            "date": update.raw_json.get("pub_date"),
            "body": update.body,
            "rawJson": update.raw_json,
        });
        let rid = webview.resources_table().add(update);
        let mut metadata = metadata;
        metadata["rid"] = serde_json::json!(rid);
        metadata
    }))
}
