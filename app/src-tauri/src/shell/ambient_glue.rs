//! WP-12 glue between `crate::ambient` (pure trigger and exit guard, per-OS probes) and the shell's
//! `Core` (windows, settings, strip state). A child module of `shell` so it can use `Core`'s
//! private fields; the shell itself only calls `start_trigger` and `on_open`.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::json;
use tauri::Manager;

use super::Core;
use crate::ambient::guard::ExitGuard;
use crate::ambient::os;
use crate::ambient::trigger::{Environment, Step, Trigger, TriggerConfig};
use crate::platform;
use crate::testlog::log;

/// A mouse move over this many CSS px ends the scene (SPEC 6.4).
const MOVE_PX: f64 = 8.0;
/// Poll period of the exit guard: with the tail of one poll this keeps detection well under 100 ms.
const GUARD_POLL: Duration = Duration::from_millis(40);
/// Extra grace for a scene the user started by hand (tray click, shortcut): the cursor is usually
/// still travelling back from the menu. Added to `guard::GRACE_S`.
const MANUAL_EXTRA_GRACE: f64 = 0.9;

/// Set by the trigger just before it opens a scene, read once by `on_open`.
static OPENED_BY_IDLE: AtomicBool = AtomicBool::new(false);

struct CoreEnv(Arc<Core>);

impl Environment for CoreEnv {
    fn ambient_open(&self) -> bool {
        self.0.app.get_webview_window("ambient").is_some()
    }
    fn strip_disabled(&self) -> bool {
        self.0.strip.lock().unwrap().hidden.contains(&super::Hide::Disabled)
    }
    /// Asked fresh, not read from the strip's hidden state: "show over fullscreen apps" turns that
    /// state off, but ambient must still never start over a fullscreen app.
    fn fullscreen_on_strip_display(&self) -> Option<bool> {
        #[cfg(debug_assertions)]
        match std::env::var("BUSYHOLM_FAKE_FULLSCREEN").as_deref() {
            Ok("on") => return Some(true),
            Ok("off") => return Some(false),
            _ => {}
        }
        let m = self.0.strip_or_primary_monitor()?;
        platform::other_app_fullscreen(&m)
    }
    fn media_or_call_active(&self) -> Option<bool> {
        os::media_or_call_active()
    }
    fn battery_saver(&self) -> Option<bool> {
        os::battery_saver()
    }
}

/// SPEC 6.4 idle trigger, gated by Revision 1 item 5 (`platform::IDLE_TRIGGER_VERIFIED`, false on
/// every OS today, so this thread wakes once a minute and does nothing else).
pub(super) fn start_trigger(core: &Arc<Core>) {
    let me = core.clone();
    let _ = std::thread::Builder::new().name("bh-idle".into()).spawn(move || {
        let (source, source_name) = os::idle_source();
        let env = CoreEnv(me.clone());
        let mut trigger = Trigger::new();
        let mut last_state: Option<String> = None;
        // One sample at start, so a test can see that the real idle clock of this OS answers.
        log("idle_probe", json!({ "source": source_name, "idle_s": source.idle_seconds().map(|s| (s * 10.0).round() / 10.0) }));
        loop {
            let cfg = TriggerConfig {
                idle_minutes: me.settings().ambient.idle_minutes,
                fullscreen_check_verified: platform::IDLE_TRIGGER_VERIFIED || os::gate_override(),
            };
            let step = trigger.step(&cfg, source.idle_seconds(), &env);
            let (state, pause) = match step {
                Step::Disabled(why) => (format!("off: {why}"), Duration::from_secs(60)),
                Step::Wait(d) => ("on".to_string(), d),
                Step::Skipped(r, d) => (format!("skipped: {}", r.as_str()), d),
                Step::Enter | Step::Exit => ("on".to_string(), Duration::from_millis(250)),
            };
            if last_state.as_deref() != Some(&state) {
                // `enabled` is the field the WP-02 acceptance test reads; `state` adds the detail.
                log("idle_trigger", json!({ "enabled": !state.starts_with("off"), "reason": state.strip_prefix("off: "), "state": state, "source": source_name }));
                last_state = Some(state);
            }
            match step {
                Step::Enter => {
                    log("idle_enter", json!({ "idle_s": source.idle_seconds().map(|s| s.round()) }));
                    OPENED_BY_IDLE.store(true, Ordering::SeqCst);
                    let m2 = me.clone();
                    let _ = me.app.run_on_main_thread(move || m2.open_ambient());
                }
                Step::Exit => {
                    log("idle_exit", json!({ "by": "trigger" }));
                    let m2 = me.clone();
                    let _ = me.app.run_on_main_thread(move || m2.close_ambient());
                }
                _ => {}
            }
            std::thread::sleep(pause);
        }
    });
}

/// Main thread, right after the ambient window opened. Starts the native exit guard: a backstop
/// that ends the scene on a key, a click or a move over 8 px even if the page never loads or hangs.
pub(super) fn on_open(core: &Arc<Core>, scale: f64) {
    let by_idle = OPENED_BY_IDLE.swap(false, Ordering::SeqCst);
    let me = core.clone();
    let _ = std::thread::Builder::new().name("bh-ambient-guard".into()).spawn(move || {
        let (source, _) = os::idle_source();
        let started = Instant::now();
        let extra = if by_idle { 0.0 } else { MANUAL_EXTRA_GRACE };
        let mut guard = ExitGuard::new(extra, MOVE_PX * scale);
        loop {
            std::thread::sleep(GUARD_POLL);
            if me.app.get_webview_window("ambient").is_none() {
                return;
            }
            let t = started.elapsed().as_secs_f64();
            let reason = guard.observe(t, platform::cursor(&me.app, scale), source.idle_seconds());
            if let Some(r) = reason {
                log("ambient_exit", json!({ "by": "guard", "reason": format!("{r:?}"), "after_s": (t * 1000.0).round() / 1000.0 }));
                let m2 = me.clone();
                let _ = me.app.run_on_main_thread(move || m2.close_ambient());
                return;
            }
        }
    });
}
