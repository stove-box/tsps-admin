#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[path = "../../../shared.rs"]
mod shared;

use std::time::{Duration, Instant};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Url, WindowEvent};

/// The dialog's buttons navigate here; the app intercepts it, so the panel page needs no app access.
const ACTION_HOST: &str = "tsps-admin.invalid";

/// The tray's Quit confirmation, drawn over whatever page the window shows.
const DIALOG: &str = r##"() => {
  document.getElementById("tsps-quit")?.remove();
  const wrap = document.createElement("div");
  wrap.id = "tsps-quit";
  wrap.innerHTML = `<style>
    #tsps-quit { position: fixed; inset: 0; z-index: 2147483647; display: grid; place-items: center; background: rgba(0,0,0,.6); }
    #tsps-quit .box { width: max-content; max-width: calc(100vw - 32px); padding: 16px 20px 18px; border-radius: 3px; color: #fff; text-shadow: 1px 1px 0 #000;
      font: 16px/1.3 "RuneScape Plain 12", system-ui, sans-serif; background: #3e3529; border: 2px solid #0e0c09;
      box-shadow: inset 0 0 0 1px #5d5240, inset 0 0 0 3px #2b251c, 0 6px 18px rgba(0,0,0,.5); }
    #tsps-quit h2 { margin: 0 0 12px; font: 16px/1.25 "RuneScape Bold 12", system-ui, sans-serif; color: #ff981f; text-align: center; }
    /* Body text in a plain UI font: the pixel font is hard to read in full sentences. */
    #tsps-quit .text { margin: 0 0 16px; padding: 12px 14px; border-radius: 2px; background: #2b251c; border: 1px solid #0e0c09;
      font: 14px/1.55 "Segoe UI", system-ui, sans-serif; color: #e4dfd3; text-shadow: none; white-space: pre-line; }
    /* Each sentence on one line; the box grows to fit the longest. */
    #tsps-quit .text p { margin: 0 0 8px; white-space: nowrap; }
    #tsps-quit .text p:last-child { margin: 0; }
    #tsps-quit .text .ask { margin-top: 12px; font-weight: 600; color: #fff; text-align: center; }
    #tsps-quit .row { display: flex; flex-wrap: wrap; gap: 10px; justify-content: center; }
    #tsps-quit button { min-height: 34px; padding: 0 14px; border-radius: 3px; cursor: pointer; color: #ff981f; text-shadow: 1px 1px 0 #000;
      font: 16px/1 "RuneScape Bold 12", system-ui, sans-serif; border: 1px solid #0e0c09;
      background: linear-gradient(#5a4e3d, #3e3529 55%, #342c22); box-shadow: inset 0 1px 0 rgba(255,255,255,.14), inset 0 -2px 0 rgba(0,0,0,.35); }
    #tsps-quit button:hover { color: #ffff00; filter: brightness(1.12); }
    #tsps-quit button.gold { color: #ffff00; background: linear-gradient(#6d5a2c, #4e4020 55%, #3d321a); }
    #tsps-quit button.red { color: #ffb0a8; background: linear-gradient(#6b2f28, #4a1f1a 55%, #3a1814); }
    #tsps-quit button:focus-visible { outline: 2px solid #ffff00; outline-offset: 2px; }
  </style>
  <div class="box" role="alertdialog" aria-modal="true" aria-labelledby="tq-title" aria-describedby="tq-text">
    <h2 id="tq-title">Shut down TSPS Admin?</h2>
    <div class="text" id="tq-text"><p>Quitting this application will stop TSPS Admin and any online worlds.</p><p>Any online worlds will be shut down before TSPS Admin is shut down.</p><p class="ask">Would you like to quit?</p></div>
    <div class="row">
      <button type="button" class="red" data-go="shutdown">Shut Down</button>
      <button type="button" data-go="cancel">Cancel</button>
    </div>
  </div>`;
  const cancel = () => wrap.remove();
  wrap.addEventListener("click", (event) => {
    const go = event.target.closest("button")?.dataset.go;
    if (!go) return;
    if (go === "cancel") return cancel();
    wrap.querySelector(".row").remove();
    wrap.querySelector("#tq-text").textContent = "Shutting down worlds… players are being saved.";
    wrap.removeEventListener("keydown", onKey);
    location.href = "http://tsps-admin.invalid/" + go;
  });
  const onKey = (event) => { if (event.key === "Escape") cancel(); };
  wrap.addEventListener("keydown", onKey);
  document.body.append(wrap);
  wrap.querySelector("button").focus();
}"##;

fn show(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn eval(app: &AppHandle, script: String) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.eval(script);
    }
}

fn status(app: &AppHandle, text: &str) {
    let text = serde_json::to_string(text).expect("status text serializes");
    eval(app, format!("(document.getElementById('tq-text') ?? document.getElementById('status') ?? {{}}).textContent = {text};"));
}

fn confirm(app: &AppHandle) {
    show(app);
    eval(app, format!("({DIALOG})();"));
}

/// Starts the panel if needed, then shows it in the window, signed in with its token.
async fn open_panel(app: AppHandle) {
    let result = async {
        shared::ensure_panel().await?;
        let url = format!("{}/?token={}", shared::base(), shared::token()?);
        let window = app.get_webview_window("main").ok_or("no window")?;
        window.navigate(Url::parse(&url).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
    }.await;
    if let Err(error) = result { status(&app, &error); }
}

/// Asks the panel to stop (it saves players and stops the worlds it started, as Ctrl+C in its
/// console does), then waits for every world's game port to close before the app exits.
async fn shutdown(app: AppHandle) {
    let result: Result<(), String> = async {
        let token = shared::token()?;
        let body = shared::answer(shared::client().get(format!("{}/api/state", shared::base())).bearer_auth(&token).send().await).await?;
        let state: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
        let ports: Vec<u16> = state["servers"].as_array().into_iter().flatten()
            .filter_map(|s| s["ports"]["game"].as_u64()).map(|p| p as u16)
            .filter(|&p| shared::listening(p)).collect();
        shared::answer(shared::client().post(format!("{}/api/panel/quit", shared::base()))
            .bearer_auth(&token).header("Content-Type", "application/json").body("{}").send().await).await?;
        let started = Instant::now();
        loop {
            let left = ports.iter().filter(|&&p| shared::listening(p)).count();
            if left == 0 { return Ok(()); }
            // The panel gives each world 60 s to save before ending it, so this is only a backstop.
            if started.elapsed() > Duration::from_secs(600) {
                return Err(format!("{left} world(s) still haven't stopped after 10 minutes."));
            }
            status(&app, &format!("Shutting down worlds… {left} still saving ({} s).", started.elapsed().as_secs()));
            shared::sleep(Duration::from_secs(1)).await;
        }
    }.await;
    match result {
        Ok(()) => app.exit(0),
        // Leaving now would look like the worlds stopped when they didn't: stay, and say why.
        Err(error) => {
            confirm(&app);
            status(&app, &format!("Couldn't shut down cleanly: {error}\nIf tsps-admin was started before this app was updated, restart it once from the panel."));
        }
    }
}

fn main() {
    tauri::Builder::default()
        // A second launch shows the running window instead of adding another tray icon.
        .plugin(tauri_plugin_single_instance::init(|app, _, _| show(app)))
        .setup(|app| {
            let open = MenuItem::with_id(app, "open", "Open TSPS Admin", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit and stop all worlds…", true, None::<&str>)?;
            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().cloned().ok_or("the app has no icon")?)
                .tooltip("TSPS Admin: worlds keep running")
                .menu(&Menu::with_items(app, &[&open, &quit_item])?)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show(app),
                    "quit" => confirm(app),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        show(tray.app_handle());
                    }
                })
                .build(app)?;
            let handle = app.handle().clone();
            tauri::WebviewWindowBuilder::from_config(app.handle(), &app.config().app.windows[0])?
                // Tells the panel it's in the app, so its Play button opens the desktop client (public/app.js).
                .initialization_script("Object.defineProperty(window, '__TSPS_ADMIN_APP__', { value: true });")
                .initialization_script(include_str!("titlebar.js"))
                .on_navigation(move |url| {
                    if url.host_str() != Some(ACTION_HOST) { return true; }
                    if url.path() == "/shutdown" { tauri::async_runtime::spawn(shutdown(handle.clone())); }
                    false
                })
                .build()?;
            tauri::async_runtime::spawn(open_panel(app.handle().clone()));
            Ok(())
        })
        // The X only hides the window: the panel and its worlds keep running, reachable from the tray.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("could not start TSPS Admin");
}
