#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[path = "../../../shared.rs"]
mod shared;

use std::path::PathBuf;

/// The TSPS desktop client, as its installer (built from tsps-desktop-client with world.json) puts it.
const CLIENT_EXE: &str = "TSPS Local/rsps-desktop.exe";

/// The panel's worlds, in its own order. Starts the panel in the background if it isn't running.
#[tauri::command]
async fn worlds() -> Result<serde_json::Value, String> {
    shared::ensure_panel().await?;
    let body = shared::answer(shared::client().get(format!("{}/api/state", shared::base()))
        .bearer_auth(shared::token()?).send().await).await?;
    let state: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    Ok(state["servers"].clone())
}

/// Points the desktop relay at the world, opens the client, and closes this window.
#[tauri::command]
async fn play(app: tauri::AppHandle, id: String) -> Result<(), String> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("Unknown world".into());
    }
    shared::answer(shared::client().post(format!("{}/api/servers/{id}/desktop", shared::base()))
        .bearer_auth(shared::token()?).header("Content-Type", "application/json").body("{}").send().await).await?;
    let exe = PathBuf::from(std::env::var("LOCALAPPDATA").map_err(|e| e.to_string())?).join(CLIENT_EXE);
    std::process::Command::new(&exe).spawn()
        .map_err(|e| format!("Couldn't open the client at {}: {e}", exe.display()))?;
    app.exit(0);
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![worlds, play])
        .run(tauri::generate_context!())
        .expect("could not start TSPS Worlds");
}
