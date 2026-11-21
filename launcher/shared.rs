// Shared by TSPS Worlds and TSPS Admin: finding, starting and calling the tsps-admin panel.

use std::net::TcpStream;
use std::path::PathBuf;
use std::time::{Duration, Instant};

/// tsps-admin's checkout: both apps are built from `launcher/<app>/src-tauri` inside it.
pub fn admin_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("..")
}

/// The panel's port, read the way the panel reads it.
pub fn port() -> u16 {
    let mut port = 47100;
    for file in ["config.json", "config.local.json"] {
        let Ok(text) = std::fs::read_to_string(admin_dir().join(file)) else { continue };
        if let Some(value) = serde_json::from_str::<serde_json::Value>(&text).ok().and_then(|c| c["port"].as_u64()) {
            port = value as u16;
        }
    }
    port
}

pub fn base() -> String {
    format!("http://127.0.0.1:{}", port())
}

pub fn token() -> Result<String, String> {
    std::env::var("ADMIN_TOKEN")
        .or_else(|_| std::fs::read_to_string(admin_dir().join("data").join("admin.token")))
        .map(|token| token.trim().to_owned())
        .map_err(|_| "tsps-admin hasn't made its token yet.".to_string())
}

/// Whether something on this machine is listening on `port`.
pub fn listening(port: u16) -> bool {
    TcpStream::connect_timeout(&([127, 0, 0, 1], port).into(), Duration::from_millis(300)).is_ok()
}

fn running() -> bool {
    listening(port())
}

/// Starts the panel in the background unless it's already up, the way its own restart relaunches
/// it: hidden, detached, logging to data/panel.log. Closing either app never stops it.
pub async fn ensure_panel() -> Result<(), String> {
    if running() { return Ok(()); }
    let dir = admin_dir();
    std::fs::create_dir_all(dir.join("data")).map_err(|e| e.to_string())?;
    let log = std::fs::File::create(dir.join("data").join("panel.log")).map_err(|e| e.to_string())?;
    let mut command = std::process::Command::new(option_env!("TSPS_NODE").unwrap_or("node"));
    command.arg("src/server.mjs").current_dir(&dir)
        .stdin(std::process::Stdio::null())
        .stdout(log.try_clone().map_err(|e| e.to_string())?).stderr(log);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command.spawn().map_err(|e| format!("Couldn't start tsps-admin: {e}"))?;
    let started = Instant::now();
    while !running() {
        if started.elapsed() > Duration::from_secs(30) {
            return Err("tsps-admin didn't start; see data/panel.log in its folder.".into());
        }
        sleep(Duration::from_millis(250)).await;
    }
    Ok(())
}

pub async fn sleep(duration: Duration) {
    tauri::async_runtime::spawn_blocking(move || std::thread::sleep(duration)).await.ok();
}

pub fn client() -> reqwest::Client {
    reqwest::Client::builder().timeout(Duration::from_secs(5)).build().expect("HTTP client")
}

/// The panel's answer as text, or its error message.
pub async fn answer(response: Result<reqwest::Response, reqwest::Error>) -> Result<String, String> {
    let response = response.map_err(|_| "tsps-admin isn't answering.".to_string())?;
    let status = response.status();
    let body = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        let error = serde_json::from_str::<serde_json::Value>(&body).ok().and_then(|v| v["error"].as_str().map(str::to_owned));
        return Err(error.unwrap_or_else(|| format!("tsps-admin answered {status}")));
    }
    Ok(body)
}
