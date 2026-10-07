use std::time::Duration;

use tauri::Manager;
use tauri_plugin_updater::UpdaterExt;

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
