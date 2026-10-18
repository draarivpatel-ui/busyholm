//! WP-11 glue: hook connect and disconnect commands, onboarding state, OS notifications decided
//! by `notify` (the popover is not always open), and the tray's needs-you count. The decisions live
//! in pure modules (`connect`, `notify`, `onboarding`); this file only wires them into the shell.
use super::{core, log};
use crate::connect::{self, Connector, Part};
use crate::notify::{Notice, Notifier, Prefs};
use busyholm_contracts::{Moment, Snapshot};
use serde_json::json;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use tauri_plugin_notification::NotificationExt;

pub struct Wp11 {
    data_dir: PathBuf,
    connector: Mutex<Connector>,
    notifier: Mutex<Notifier>,
    started: Instant,
}

impl Wp11 {
    fn now(&self) -> u64 {
        self.started.elapsed().as_millis() as u64
    }
}

fn state(app: &AppHandle) -> Option<tauri::State<'_, Wp11>> {
    app.try_state::<Wp11>()
}

/// Called once from setup.
pub fn setup(app: &AppHandle, data_dir: PathBuf, first_run_window: bool, hooks: crate::hooks_link::HooksLink) {
    let mut connector = connect::from_env(data_dir.clone(), hooks);
    if let Ok(true) = connector.refresh_shim() {
        log("shim_refreshed", json!({}));
    }
    // INT-2: tell the collector what the install manifest says, before and without waiting for it to start.
    connector.report_hooks();
    app.manage(Wp11 { data_dir: data_dir.clone(), connector: Mutex::new(connector), notifier: Mutex::new(Notifier::new()), started: Instant::now() });
    // Reminders (re-notify after 5 minutes) need a clock; snapshots only arrive on change.
    let h = app.clone();
    std::thread::Builder::new()
        .name("bh-notify-tick".into())
        .spawn(move || loop {
            std::thread::sleep(Duration::from_secs(5));
            let Some(st) = state(&h) else { continue };
            let prefs = Prefs::from(&core(&h).settings());
            let out = st.notifier.lock().unwrap().tick(st.now(), &prefs);
            deliver(&h, out);
        })
        .ok();
    if first_run_window && !crate::onboarding::is_done(&data_dir) {
        log("onboarding", json!({ "open": true }));
        core(app).open_surface("settings");
    }
}

// ------------------------------------------------------------------------------------------------
// Outlet hooks
// ------------------------------------------------------------------------------------------------

pub fn on_snapshot(app: &AppHandle, s: &Snapshot) {
    let Some(st) = state(app) else { return };
    let prefs = Prefs::from(&core(app).settings());
    let out = st.notifier.lock().unwrap().on_snapshot(s, st.now(), &prefs);
    deliver(app, out);
    tray_attention(app, s.attention.needs_you);
}

pub fn on_moment(app: &AppHandle, m: &Moment) {
    let Some(st) = state(app) else { return };
    let prefs = Prefs::from(&core(app).settings());
    let out = st.notifier.lock().unwrap().on_moment(m, st.now(), &prefs);
    deliver(app, out);
}

/// Show notices as OS notifications. Skipped (but still counted as sent) while a Busyholm window
/// that lists the agents is focused, since the user is already looking at it.
fn deliver(app: &AppHandle, notices: Vec<Notice>) {
    if notices.is_empty() {
        return;
    }
    let looking = ["popover", "details"].iter().any(|l| app.get_webview_window(l).and_then(|w| w.is_focused().ok()).unwrap_or(false));
    for n in notices {
        log("notification", json!({ "kind": format!("{:?}", n.kind), "shown": !looking }));
        if looking {
            continue;
        }
        if let Err(e) = app.notification().builder().title(&n.title).body(&n.body).show() {
            log("notification_error", json!({ "error": e.to_string() }));
        }
    }
}

/// SPEC 4.3: the tray turns to a flag with a count while an agent needs you.
fn tray_attention(app: &AppHandle, n: u8) {
    let Some(tray) = app.tray_by_id("main") else { return };
    let tip = match n {
        0 => "Busyholm".to_string(),
        1 => "Busyholm: 1 agent needs you".to_string(),
        _ => format!("Busyholm: {n} agents need you"),
    };
    let _ = tray.set_tooltip(Some(&tip));
    #[cfg(target_os = "macos")]
    {
        let _ = tray.set_title(if n > 0 { Some(n.to_string()) } else { None });
    }
    let bytes: &[u8] = if n > 0 { include_bytes!("../../icons/tray-flag@2x.png") } else { include_bytes!("../../icons/tray@2x.png") };
    if let Ok(img) = tauri::image::Image::from_bytes(bytes) {
        let _ = tray.set_icon(Some(img));
        let _ = tray.set_icon_as_template(true);
    }
}

// ------------------------------------------------------------------------------------------------
// Commands (page to core)
// ------------------------------------------------------------------------------------------------

fn allow(window: &WebviewWindow, labels: &[&str]) -> Result<(), String> {
    if labels.contains(&window.label()) {
        Ok(())
    } else {
        Err("not allowed from this window".into())
    }
}

#[tauri::command]
pub fn bh_connect_status(window: WebviewWindow) -> Result<connect::Status, String> {
    allow(&window, &["settings", "popover", "details"])?;
    let st = state(window.app_handle()).ok_or("not ready")?;
    let r = st.connector.lock().unwrap().status();
    log("connect_status", json!({ "window": window.label(), "ok": r.is_ok() }));
    r
}

#[tauri::command]
pub fn bh_connect_preview(window: WebviewWindow, parts: Vec<Part>) -> Result<connect::Preview, String> {
    allow(&window, &["settings"])?;
    let st = state(window.app_handle()).ok_or("not ready")?;
    let r = st.connector.lock().unwrap().preview_connect(&parts);
    log("connect_preview", json!({ "parts": parts.len(), "ok": r.is_ok() }));
    r
}

#[tauri::command]
pub fn bh_disconnect_preview(window: WebviewWindow, parts: Vec<Part>) -> Result<connect::Preview, String> {
    allow(&window, &["settings"])?;
    let st = state(window.app_handle()).ok_or("not ready")?;
    let r = st.connector.lock().unwrap().preview_disconnect(&parts);
    log("disconnect_preview", json!({ "parts": parts.len(), "ok": r.is_ok() }));
    r
}

#[tauri::command]
pub fn bh_connect_apply(window: WebviewWindow, token: u64) -> Result<connect::Status, String> {
    allow(&window, &["settings"])?;
    let app = window.app_handle().clone();
    let st = state(&app).ok_or("not ready")?;
    let r = st.connector.lock().unwrap().apply(token);
    log("connect_apply", json!({ "ok": r.is_ok() }));
    if let Ok(s) = &r {
        let _ = app.emit("bh:connect-status", s);
    }
    r
}

pub(crate) fn run_delete_everything<FStop, FEmit, FExit>(
    connector: &Mutex<Connector>,
    notifier: &Mutex<Notifier>,
    stop_collector_and_autostart: FStop,
    emit_status: FEmit,
    exit_app: FExit,
) -> Result<connect::Status, String>
where
    FStop: FnOnce(),
    FEmit: FnOnce(&connect::Status),
    FExit: FnOnce(),
{
    if let Err(e) = connector.lock().unwrap().check_data_dir() {
        log("delete_everything", json!({ "ok": false, "step": "check_data_dir", "error": &e }));
        return Err(e);
    }
    if let Err(e) = connector.lock().unwrap().disconnect_for_delete() {
        log("delete_everything", json!({ "ok": false, "step": "disconnect", "error": &e }));
        return Err(e);
    }
    let disconnected_status = connector.lock().unwrap().status().ok();
    stop_collector_and_autostart();
    *notifier.lock().unwrap() = Notifier::new();
    let r = connector.lock().unwrap().delete_data_files();
    match &r {
        Ok(s) => {
            log("delete_everything", json!({ "ok": true }));
            emit_status(s);
        }
        Err(e) => {
            log("delete_everything", json!({ "ok": false, "step": "delete_data_files", "error": e }));
            if let Some(s) = connector.lock().unwrap().status().ok().or(disconnected_status) {
                emit_status(&s);
            }
        }
    }
    exit_app();
    r
}

#[tauri::command]
pub fn bh_delete_everything(window: WebviewWindow) -> Result<connect::Status, String> {
    allow(&window, &["settings"])?;
    let app = window.app_handle().clone();
    let st = state(&app).ok_or("not ready")?;
    let c = core(&app);
    run_delete_everything(
        &st.connector,
        &st.notifier,
        || {
            c.stop_collector_without_flush();
            c.disable_autostart_for_delete();
        },
        |s| {
            let _ = app.emit("bh:connect-status", s);
        },
        || {
            let app_exit = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(50));
                app_exit.exit(0);
            });
        },
    )
}

#[tauri::command]
pub fn bh_onboarding(window: WebviewWindow, action: String) -> Result<serde_json::Value, String> {
    allow(&window, &["settings", "popover", "details"])?;
    let st = state(window.app_handle()).ok_or("not ready")?;
    match action.as_str() {
        "get" => {
            let done = crate::onboarding::is_done(&st.data_dir);
            log("onboarding", json!({ "window": window.label(), "get": done }));
            Ok(json!({ "done": done }))
        }
        "done" => {
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
            crate::onboarding::mark_done(&st.data_dir, now)?;
            log("onboarding", json!({ "done": true }));
            Ok(json!({ "done": true }))
        }
        _ => Err("unknown action".into()),
    }
}

#[tauri::command]
pub fn bh_third_party_notices(window: WebviewWindow) -> Result<String, String> {
    allow(&window, &["settings", "details"])?;
    let mut candidates = Vec::new();
    if let Ok(dir) = window.app_handle().path().resource_dir() {
        candidates.push(dir.join("THIRD-PARTY-NOTICES.txt"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("../Resources/THIRD-PARTY-NOTICES.txt"));
            candidates.push(dir.join("THIRD-PARTY-NOTICES.txt"));
        }
    }
    #[cfg(debug_assertions)]
    candidates.push(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packaging/out/notices/THIRD-PARTY-NOTICES.txt"));
    for p in candidates {
        if let Ok(text) = std::fs::read_to_string(&p) {
            if !text.trim().is_empty() {
                return Ok(text);
            }
        }
    }
    Err("third-party notices file not found".into())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use busyholm_installer::{Layout, Sources};
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn p2_2_part2_delete_everything_checks_data_dir_before_stopping_and_still_exits_if_file_delete_fails() {
        let base = std::env::temp_dir().join(format!("bh-wp11-glue-p2-2-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let home = base.join("home");
        let data_dir = base.join("data");
        let layout = Layout {
            data_dir: data_dir.clone(),
            claude_dir: home.join(".claude"),
            codex_dir: home.join(".codex"),
            opencode_dir: home.join(".config/opencode"),
        };
        for d in [&layout.claude_dir, &layout.codex_dir, &layout.opencode_dir] {
            std::fs::create_dir_all(d).unwrap();
        }
        let shim = base.join("busyholm-hook");
        std::fs::write(&shim, b"#!/bin/sh\nexit 0\n").unwrap();
        let sources = Sources { shim_binary: shim, opencode_plugin: "const RUNTIME_FILE_OVERRIDE = null;\n".into() };

        // 1. If data_dir is a symlink, check_data_dir refuses BEFORE stopping the collector.
        let outside = base.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, &data_dir).unwrap();
        let connector = Mutex::new(Connector::new(layout.clone(), Some(sources.clone()), home.clone()));
        let notifier = Mutex::new(Notifier::new());
        let (mut stopped, mut emitted, mut exited) = (false, false, false);
        let res = run_delete_everything(
            &connector,
            &notifier,
            || stopped = true,
            |_| emitted = true,
            || exited = true,
        );
        assert!(res.is_err(), "symlinked data_dir must be refused");
        assert!(!stopped && !emitted && !exited, "collector must not be stopped when check_data_dir fails");
        std::fs::remove_file(&data_dir).unwrap();

        // 2. Once the collector has been stopped, even if deleting files inside data_dir fails,
        //    status is emitted and the app still exits.
        std::fs::create_dir_all(&data_dir).unwrap();
        std::fs::write(layout.claude_settings(), b"{}\n").unwrap();
        {
            let mut c = connector.lock().unwrap();
            let pv = c.preview_connect(&[Part::ClaudeHooks]).unwrap();
            c.apply(pv.token).unwrap();
        }
        std::fs::write(data_dir.join("ledger.json"), b"{}\n").unwrap();

        let (mut stopped, mut emitted_any_connected, mut exited) = (false, None, false);
        let data_for_stop = data_dir.clone();
        let res = run_delete_everything(
            &connector,
            &notifier,
            || {
                stopped = true;
                // Make data_dir read-only after disconnect so unlinking ledger.json inside delete_data_files fails.
                std::fs::set_permissions(&data_for_stop, std::fs::Permissions::from_mode(0o500)).unwrap();
            },
            |s| emitted_any_connected = Some(s.any_connected),
            || exited = true,
        );
        std::fs::set_permissions(&data_dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        let _ = std::fs::remove_dir_all(&base);

        assert!(res.is_err(), "delete_data_files failed because data_dir was made read-only");
        assert!(stopped, "collector stop ran");
        assert_eq!(emitted_any_connected, Some(false), "disconnected status must still be emitted");
        assert!(exited, "app must still exit once collector has been stopped");
    }
}

