//! The Tauri glue: window manager (strip, ambient, popover, settings, details), layer modes,
//! visibility (user, fullscreen, ambient), display follow, the click-through poller, the tray, the
//! hub outlet and the page commands. Pure decisions live in `geometry`, `clickthrough` and `hub`;
//! per-OS calls live in `platform`.
use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use busyholm_contracts::settings::{LayerMode, StripDisplay};
use busyholm_contracts::{HitRects, Ledger, Moment, Settings, Snapshot};
use serde_json::json;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, PhysicalPosition, PhysicalSize, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

use crate::clickthrough::{self, ClickThrough, Sample};
use crate::geometry::{self, MonitorInfo, Os, PRect, Placement};
use crate::hub::{Collector, FeedSender, Hub, HubConfig, Outlet};
use crate::mock::{MockCollector, MockMode};
use crate::opts::Opts;
use crate::platform::{self, Layer, StripSupport};
use crate::settings::SettingsStore;
use crate::testlog::log;

mod ambient_glue;
mod wp11_glue;

const OS: Os = Os::current();

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Hide {
    Disabled,
    Fullscreen,
    Ambient,
}
impl Hide {
    fn reason(&self) -> &'static str {
        match self {
            Hide::Disabled => "hidden",
            Hide::Fullscreen => "fullscreen",
            Hide::Ambient => "ambient",
        }
    }
}

#[derive(Default)]
struct StripState {
    monitor: Option<MonitorInfo>,
    placement: Option<Placement>,
    reserved: Option<PRect>,
    hidden: BTreeSet<Hide>,
    shown: bool,
    attention: bool,
    monitors_sig: String,
}

#[derive(Clone, Copy)]
pub struct PollGeom {
    pub rect: PRect,
    pub scale: f64,
    pub css: (f64, f64),
    pub window_number: Option<isize>,
}

#[derive(Default)]
pub struct PollShared {
    geom: Mutex<Option<PollGeom>>,
    hits: Mutex<clickthrough::HitStore>,
    active: Mutex<bool>,
    cv: Condvar,
    hover_fade: AtomicBool,
}

impl PollShared {
    pub fn apply_create_placement(&self, p: Placement, window_number: Option<isize>) -> bool {
        let (_, _, lw, lh) = p.logical();
        *self.geom.lock().unwrap() = Some(PollGeom { rect: p.rect, scale: p.scale, css: (lw, lh), window_number });
        let key = clickthrough::GeomKey { x: p.rect.x, y: p.rect.y, w: p.rect.w, h: p.rect.h, scale: p.scale, css: (lw, lh) };
        self.hits.lock().unwrap().set_geometry(key)
    }

    pub fn apply_relayout_placement(&self, p: Placement, window_number: Option<isize>) -> bool {
        self.apply_create_placement(p, window_number)
    }

    pub fn publish_hits(&self, msg: &HitRects) -> bool {
        if self.geom.lock().unwrap().is_none() {
            return false;
        }
        self.hits.lock().unwrap().publish(msg)
    }

    pub fn hit_rects(&self) -> Vec<clickthrough::HitRect> {
        self.hits.lock().unwrap().rects().to_vec()
    }
}

struct TrayItems {
    strip: CheckMenuItem<tauri::Wry>,
    on_top: CheckMenuItem<tauri::Wry>,
    behind: CheckMenuItem<tauri::Wry>,
    reserve: CheckMenuItem<tauri::Wry>,
    autostart: CheckMenuItem<tauri::Wry>,
}

pub struct Core {
    app: AppHandle,
    opts: Opts,
    data_dir: PathBuf,
    settings: Mutex<SettingsStore>,
    hub: Mutex<Option<Hub>>,
    strip: Mutex<StripState>,
    poll: Arc<PollShared>,
    popover_closed_at: Mutex<Option<Instant>>,
    tray: Mutex<Option<TrayItems>>,
    relayout_gen: AtomicU64,
    fullscreen_gen: AtomicU64,
    /// World inputs for pages (seed, ledger, choices); see `world_inputs`.
    world: Mutex<crate::world_inputs::Tracker>,
    world_gen: AtomicU64,
    watch_registered: AtomicBool,
}

fn core(app: &AppHandle) -> Arc<Core> {
    app.state::<Arc<Core>>().inner().clone()
}

// ------------------------------------------------------------------------------------------------
// Monitors and placement
// ------------------------------------------------------------------------------------------------

fn monitor_to_info(m: &tauri::Monitor, pkey: Option<&(Option<String>, i32, i32)>, force_primary: bool) -> MonitorInfo {
    let wa = m.work_area();
    MonitorInfo {
        name: m.name().cloned(),
        bounds: PRect { x: m.position().x, y: m.position().y, w: m.size().width, h: m.size().height },
        work: PRect { x: wa.position.x, y: wa.position.y, w: wa.size.width, h: wa.size.height },
        scale: m.scale_factor(),
        primary: force_primary || pkey.map(|k| *k == (m.name().cloned(), m.position().x, m.position().y)).unwrap_or(false),
    }
}

pub(crate) fn monitors_with_fallback(available: Vec<MonitorInfo>, primary: Option<MonitorInfo>) -> Vec<MonitorInfo> {
    if !available.is_empty() {
        return available;
    }
    primary
        .map(|mut m| {
            m.primary = true;
            vec![m]
        })
        .unwrap_or_default()
}

fn monitors(app: &AppHandle) -> Vec<MonitorInfo> {
    let primary = app.primary_monitor().ok().flatten();
    let pkey = primary.as_ref().map(|p| (p.name().cloned(), p.position().x, p.position().y));
    let available: Vec<MonitorInfo> = app
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| monitor_to_info(m, pkey.as_ref(), false))
        .collect();
    let fallback = primary.as_ref().map(|m| monitor_to_info(m, pkey.as_ref(), true));
    monitors_with_fallback(available, fallback)
}

fn sig(ms: &[MonitorInfo]) -> String {
    ms.iter().map(|m| format!("{:?}{:?}{:?}{}", m.name, m.bounds, m.work, m.scale)).collect::<Vec<_>>().join("|")
}

fn rect_json(r: PRect) -> serde_json::Value {
    json!([r.x, r.y, r.w, r.h])
}

/// Position and size a window at a physical rectangle of a monitor with `scale`. On macOS tao
/// converts physical to points with the window's current scale, which is wrong while a window moves
/// between displays, so macOS uses points directly.
fn set_frame(w: &WebviewWindow, r: PRect, scale: f64) {
    if OS == Os::MacOs {
        let _ = w.set_size(LogicalSize::new(r.w as f64 / scale, r.h as f64 / scale));
        let _ = w.set_position(LogicalPosition::new(r.x as f64 / scale, r.y as f64 / scale));
    } else {
        let _ = w.set_size(PhysicalSize::new(r.w, r.h));
        let _ = w.set_position(PhysicalPosition::new(r.x, r.y));
    }
}

// ------------------------------------------------------------------------------------------------
// Boot data for pages
// ------------------------------------------------------------------------------------------------

impl Core {
    fn settings(&self) -> Settings {
        self.settings.lock().unwrap().get().clone()
    }

    fn requested_layer(&self) -> LayerMode {
        match self.opts.layer.as_deref() {
            Some("on_top") => LayerMode::OnTop,
            Some("behind_windows") => LayerMode::BehindWindows,
            Some("reserve_space") => LayerMode::ReserveSpace,
            _ => self.settings().strip.layer_mode,
        }
    }

    /// (z-layer, reserve space, effective name, reason)
    fn effective_layer(&self) -> (Layer, bool, &'static str, &'static str) {
        match self.requested_layer() {
            LayerMode::OnTop => (Layer::OnTop, false, "on_top", ""),
            LayerMode::BehindWindows => {
                if self.strip.lock().unwrap().attention {
                    (Layer::OnTop, false, "on_top", "needs_you")
                } else {
                    (Layer::Behind, false, "behind_windows", "")
                }
            }
            LayerMode::ReserveSpace => {
                if platform::reserve_supported() {
                    (Layer::OnTop, true, "reserve_space", "")
                } else {
                    (Layer::OnTop, false, "on_top", "unsupported")
                }
            }
        }
    }

    fn boot_script(&self, surface: &str) -> String {
        let s = self.settings();
        let strip = match platform::strip_support() {
            StripSupport::Supported => {
                let layer = self.effective_layer().2;
                let placement = self.strip.lock().unwrap().placement;
                let (w, h, scale) = placement.map(|p| { let l = p.logical(); (l.2, l.3, p.scale) }).unwrap_or((0.0, 0.0, 1.0));
                json!({ "supported": true, "layer": layer, "w": w, "h": h, "scale": scale })
            }
            StripSupport::Unsupported(why) => json!({ "supported": false, "reason": why }),
        };
        let boot = json!({
            "surface": surface, "os": OS.as_str(), "settings": s, "strip": strip,
            "test": { "freeze": self.opts.test_freeze, "fixed_rect": self.opts.test_fixed_rect, "report": crate::testlog::enabled() },
            "world_inputs": self.world.lock().unwrap().current(),
        });
        format!("window.__BUSYHOLM_BOOT__ = Object.freeze({boot});")
    }
}

// ------------------------------------------------------------------------------------------------
// Strip window
// ------------------------------------------------------------------------------------------------

fn build_strip_and_record_sig<W, F>(strip: &Mutex<StripState>, ms: &[MonitorInfo], p: Placement, m: &MonitorInfo, build: F) -> Result<W, String>
where
    F: FnOnce() -> Result<W, String>,
{
    {
        let mut st = strip.lock().unwrap();
        st.placement = Some(p);
        st.monitor = Some(m.clone());
    }
    let w = build()?;
    strip.lock().unwrap().monitors_sig = sig(ms);
    Ok(w)
}

impl Core {
    /// Main thread.
    fn create_strip(self: &Arc<Self>) -> Result<(), String> {
        if self.app.get_webview_window("strip").is_some() {
            return Ok(());
        }
        let ms = monitors(&self.app);
        let s = self.settings();
        let named = match &s.strip.display { StripDisplay::Named { name } => Some(name.as_str()), _ => None };
        let p = geometry::place(&ms, named, OS, s.strip.height, None).ok_or("no display")?;
        let m = ms[p.monitor].clone();
        let page = self.opts.strip_page.clone().unwrap_or_else(|| "strip.html".into());
        let (lx, ly, lw, lh) = p.logical();
        let w = build_strip_and_record_sig(&self.strip, &ms, p, &m, || {
            WebviewWindowBuilder::new(&self.app, "strip", WebviewUrl::App(page.into()))
                .title("Busyholm strip")
                .inner_size(lw, lh)
                .position(lx, ly)
                .decorations(false)
                .transparent(true)
                .shadow(false)
                .resizable(false)
                .skip_taskbar(true)
                .focused(false)
                .focusable(false)
                .always_on_top(true)
                .visible(false)
                .visible_on_all_workspaces(true)
                .initialization_script(self.boot_script("strip"))
                .build()
                .map_err(|e| e.to_string())
        })?;
        set_frame(&w, p.rect, p.scale);
        let _ = w.set_ignore_cursor_events(true);
        let mut d = platform::prepare_strip(&w).unwrap_or_else(|e| json!({ "error": e }));
        d["label"] = json!("strip");
        log("window", d);
        // Rectangles the page published for the old geometry are stale: click-through until it republishes.
        if self.poll.apply_create_placement(p, platform::window_number(&w)) {
            log("hit_rects_reset", json!({ "css": [lw, lh], "scale": p.scale }));
        }
        self.apply_layer();
        self.log_placement(&m, p);
        // Settings-driven visibility, then the fullscreen check, then show.
        if !s.strip.enabled {
            self.strip.lock().unwrap().hidden.insert(Hide::Disabled);
        }
        self.apply_visibility();
        if !self.watch_registered.swap(true, Ordering::SeqCst) {
            let (c1, c2) = (self.clone(), self.clone());
            platform::watch(&self.app, &w, Arc::new(move || c1.schedule_relayout()), Arc::new(move || c2.schedule_fullscreen_check()));
        }
        let me = self.clone();
        std::thread::spawn(move || me.check_fullscreen());
        Ok(())
    }

    fn log_placement(&self, m: &MonitorInfo, p: Placement) {
        let (lx, ly, lw, lh) = p.logical();
        log("placement", json!({ "monitor": m.name, "scale": p.scale, "rect_px": rect_json(p.rect), "logical": [lx, ly, lw, lh],
            "work_px": rect_json(m.work), "bounds_px": rect_json(m.bounds) }));
    }

    /// Main thread. Applies the effective layer (and reserve space) to the strip.
    fn apply_layer(self: &Arc<Self>) {
        let Some(w) = self.app.get_webview_window("strip") else { return };
        let (layer, reserve, name, reason) = self.effective_layer();
        let over_fs = self.settings().strip.show_over_fullscreen;
        let d = platform::apply_layer(&w, layer, over_fs).unwrap_or_else(|e| json!({ "error": e }));
        let requested = match self.requested_layer() {
            LayerMode::OnTop => "on_top",
            LayerMode::BehindWindows => "behind_windows",
            LayerMode::ReserveSpace => "reserve_space",
        };
        let (cur, monitor, placement) = {
            let st = self.strip.lock().unwrap();
            (st.reserved, st.monitor.clone(), st.placement)
        };
        let mut granted = None;
        if reserve {
            if let (Some(p), Some(m)) = (placement, monitor.clone()) {
                match platform::reserve_space(&w, Some(p.rect), &m) {
                    Ok(Some(r)) => {
                        granted = Some(r);
                        if r != p.rect {
                            set_frame(&w, r, p.scale);
                        }
                    }
                    Ok(None) => {}
                    Err(e) => log("reserve_error", json!({ "error": e })),
                }
            }
        } else if cur.is_some() {
            if let Some(m) = monitor.as_ref() {
                let _ = platform::reserve_space(&w, None, m);
            }
        }
        self.strip.lock().unwrap().reserved = granted;
        self.poll.hover_fade.store(layer == Layer::OnTop && self.settings().strip.hover_fade, Ordering::SeqCst);
        log("layer", json!({ "requested": requested, "effective": name, "reason": reason, "reserved": granted.map(rect_json), "native": d }));
    }

    /// Main thread. Shows or hides the strip from the set of hide reasons.
    fn apply_visibility(self: &Arc<Self>) {
        let Some(w) = self.app.get_webview_window("strip") else { return };
        let (want, reason) = {
            let st = self.strip.lock().unwrap();
            (st.hidden.is_empty(), st.hidden.iter().next().map(|h| h.reason()).unwrap_or("shown"))
        };
        let changed = {
            let mut st = self.strip.lock().unwrap();
            let c = st.shown != want;
            st.shown = want;
            c
        };
        if !changed {
            return;
        }
        if want {
            let _ = platform::show_inactive(&w);
        } else {
            let _ = w.hide();
        }
        self.set_poll_active(want);
        let _ = self.app.emit_to("strip", "bh:visibility", json!({ "visible": want, "reason": reason }));
        log("strip_visibility", json!({ "visible": want, "reason": reason }));
    }

    fn set_hidden(self: &Arc<Self>, h: Hide, on: bool) {
        let changed = {
            let mut st = self.strip.lock().unwrap();
            if on { st.hidden.insert(h) } else { st.hidden.remove(&h) }
        };
        if changed {
            let me = self.clone();
            let _ = self.app.run_on_main_thread(move || me.apply_visibility());
        }
    }

    /// Main thread. Re-place the strip after a display, scale, Dock, taskbar or work-area change.
    fn relayout(self: &Arc<Self>, force: bool) {
        let Some(w) = self.app.get_webview_window("strip") else {
            if self.settings().strip.enabled && platform::strip_support() == StripSupport::Supported {
                if let Err(e) = self.create_strip() {
                    log("strip_error", json!({ "error": e }));
                }
            }
            return;
        };
        let ms = monitors(&self.app);
        let new_sig = sig(&ms);
        let s = self.settings();
        let named = match &s.strip.display { StripDisplay::Named { name } => Some(name.as_str()), _ => None };
        let own = self.strip.lock().unwrap().reserved;
        let Some(p) = geometry::place(&ms, named, OS, s.strip.height, own) else { return };
        let old = {
            let mut st = self.strip.lock().unwrap();
            let old = st.placement;
            st.monitors_sig = new_sig;
            st.placement = Some(p);
            st.monitor = Some(ms[p.monitor].clone());
            old
        };
        if !force && old == Some(p) {
            return;
        }
        set_frame(&w, p.rect, p.scale);
        let (_, _, lw, lh) = p.logical();
        if self.poll.apply_relayout_placement(p, platform::window_number(&w)) {
            log("hit_rects_reset", json!({ "css": [lw, lh], "scale": p.scale }));
        }
        self.log_placement(&ms[p.monitor], p);
        if self.effective_layer().1 {
            self.apply_layer();
        }
        let _ = self.app.emit_to("strip", "bh:strip-geometry", json!({ "w": lw, "h": lh, "scale": p.scale }));
    }

    /// Any thread: debounce bursts of display notifications, then re-place on the main thread.
    fn schedule_relayout(self: &Arc<Self>) {
        let g = self.relayout_gen.fetch_add(1, Ordering::SeqCst) + 1;
        let me = self.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            if me.relayout_gen.load(Ordering::SeqCst) == g {
                let m2 = me.clone();
                let _ = me.app.run_on_main_thread(move || m2.relayout(false));
            }
        });
    }

    /// Any thread. Hide while another app is fullscreen on the strip's display (unless allowed).
    fn check_fullscreen(self: &Arc<Self>) {
        let (monitor, allowed) = (self.strip.lock().unwrap().monitor.clone(), self.settings().strip.show_over_fullscreen);
        let Some(m) = monitor else { return };
        if allowed {
            self.set_hidden(Hide::Fullscreen, false);
            return;
        }
        if let Some(fs) = platform::other_app_fullscreen(&m) {
            let was = self.strip.lock().unwrap().hidden.contains(&Hide::Fullscreen);
            if fs != was {
                log("fullscreen", json!({ "other_app_fullscreen": fs }));
            }
            self.set_hidden(Hide::Fullscreen, fs);
        }
    }

    /// Any thread: Space switches animate, so check shortly after the notification and again later.
    fn schedule_fullscreen_check(self: &Arc<Self>) {
        let g = self.fullscreen_gen.fetch_add(1, Ordering::SeqCst) + 1;
        let me = self.clone();
        std::thread::spawn(move || {
            // Waits between checks: the Space animation takes most of a second, and the window
            // only reaches its final frame at the end of it.
            for wait in [250u64, 650, 1100] {
                std::thread::sleep(Duration::from_millis(wait));
                if me.fullscreen_gen.load(Ordering::SeqCst) != g {
                    return;
                }
                me.check_fullscreen();
            }
        });
    }

    fn on_attention(self: &Arc<Self>, needs_you: bool) {
        let changed = {
            let mut st = self.strip.lock().unwrap();
            let c = st.attention != needs_you;
            st.attention = needs_you;
            c
        };
        if changed && self.requested_layer() == LayerMode::BehindWindows {
            let me = self.clone();
            let _ = self.app.run_on_main_thread(move || me.apply_layer());
        }
    }
}

// ------------------------------------------------------------------------------------------------
// Click-through poller (SPEC 6.3): 30 Hz near the strip, 4 Hz elsewhere, parked while hidden.
// ------------------------------------------------------------------------------------------------

impl Core {
    fn set_poll_active(&self, on: bool) {
        *self.poll.active.lock().unwrap() = on;
        self.poll.cv.notify_all();
    }

    fn start_poller(self: &Arc<Self>) {
        let me = self.clone();
        std::thread::Builder::new()
            .name("bh-cursor-poll".into())
            .spawn(move || me.poll_loop())
            .expect("spawn poller");
    }

    fn poll_loop(self: Arc<Self>) {
        let start = Instant::now();
        let mut ct = ClickThrough::new(clickthrough::Config::default());
        let mut last_oracle = Instant::now();
        loop {
            {
                let mut active = self.poll.active.lock().unwrap();
                if !*active {
                    let a = ct.reset();
                    self.apply_actions(a);
                    while !*active {
                        active = self.poll.cv.wait(active).unwrap();
                    }
                }
            }
            let Some(g) = *self.poll.geom.lock().unwrap() else {
                std::thread::sleep(Duration::from_millis(250));
                continue;
            };
            ct.cfg.hover_fade = self.poll.hover_fade.load(Ordering::SeqCst);
            let cur = platform::cursor(&self.app, g.scale);
            let local = cur.map(|(x, y)| ((x - g.rect.x as f64) / g.scale, (y - g.rect.y as f64) / g.scale));
            let sample = Sample { now: start.elapsed(), cursor: local, size: g.css };
            let rects = self.poll.hits.lock().unwrap().rects().to_vec();
            let a = ct.step(&sample, &rects);
            self.apply_actions(a);
            let interval = ct.interval(&sample);
            if self.opts.oracle && interval == ct.cfg.fast && last_oracle.elapsed() >= Duration::from_millis(300) {
                last_oracle = Instant::now();
                if let Some((x, y)) = cur {
                    self.oracle(x / g.scale, y / g.scale, g, ct.ignoring(), ct.faded());
                }
            }
            std::thread::sleep(interval);
        }
    }

    fn apply_actions(&self, a: clickthrough::Actions) {
        if let Some(ig) = a.set_ignore {
            if let Some(w) = self.app.get_webview_window("strip") {
                let _ = w.set_ignore_cursor_events(ig);
            }
            log("clickthrough", json!({ "ignore": ig }));
        }
        if let Some(f) = a.set_fade {
            let _ = self.app.emit_to("strip", "bh:strip-fade", json!({ "on": f }));
            log("fade", json!({ "on": f }));
        }
    }

    /// macOS test oracle: ask the window server which window a click at the cursor would reach.
    fn oracle(&self, x_pts: f64, y_pts: f64, g: PollGeom, ignoring: bool, faded: bool) {
        let (tx, rx) = std::sync::mpsc::channel();
        let _ = self.app.run_on_main_thread(move || {
            let _ = tx.send(platform::window_at(x_pts, y_pts));
        });
        if let Ok(hit) = rx.recv_timeout(Duration::from_millis(500)) {
            log("oracle", json!({ "cursor_pts": [x_pts, y_pts], "hit_window": hit, "strip_window": g.window_number,
                "click_goes_to_strip": hit.is_some() && hit == g.window_number, "ignoring": ignoring, "faded": faded }));
        }
    }
}

// ------------------------------------------------------------------------------------------------
// Other windows: ambient, popover, settings, details
// ------------------------------------------------------------------------------------------------

impl Core {
    fn strip_or_primary_monitor(&self) -> Option<MonitorInfo> {
        if let Some(m) = self.strip.lock().unwrap().monitor.clone() {
            return Some(m);
        }
        let ms = monitors(&self.app);
        geometry::pick_monitor(&ms, None, OS).map(|i| ms[i].clone())
    }

    /// Main thread. Ambient mode on demand (SPEC 6.4; manual by default per Revision 1).
    fn open_ambient(self: &Arc<Self>) {
        if let Some(w) = self.app.get_webview_window("ambient") {
            let _ = w.set_focus();
            return;
        }
        let Some(m) = self.strip_or_primary_monitor() else { return };
        let s = m.scale;
        let b = m.bounds;
        let r = WebviewWindowBuilder::new(&self.app, "ambient", WebviewUrl::App("ambient.html".into()))
            .title("Busyholm")
            .inner_size(b.w as f64 / s, b.h as f64 / s)
            .position(b.x as f64 / s, b.y as f64 / s)
            .decorations(false)
            .resizable(false)
            .skip_taskbar(true)
            .always_on_top(true)
            .visible_on_all_workspaces(true)
            // Focus after prepare_ambient, which first remembers the frontmost app (macOS).
            .focused(false)
            .initialization_script(self.boot_script("ambient"))
            .build();
        match r {
            Ok(w) => {
                set_frame(&w, b, s);
                let mut d = platform::prepare_ambient(&w).unwrap_or_else(|e| json!({ "error": e }));
                d["label"] = json!("ambient");
                log("window", d);
                let _ = w.set_focus();
                self.set_hidden(Hide::Ambient, true);
                log("ambient", json!({ "open": true }));
                ambient_glue::on_open(self, s);
                if let Some(secs) = self.opts.test_close_ambient_after {
                    let me = self.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_secs_f64(secs));
                        let m2 = me.clone();
                        let _ = me.app.run_on_main_thread(move || m2.close_ambient());
                    });
                }
            }
            Err(e) => log("ambient_error", json!({ "error": e.to_string() })),
        }
    }

    /// Main thread. Destroys the ambient window and brings the strip back.
    fn close_ambient(self: &Arc<Self>) {
        if let Some(w) = self.app.get_webview_window("ambient") {
            let _ = w.destroy();
            platform::after_ambient(&self.app);
            log("ambient", json!({ "open": false }));
        }
        self.set_hidden(Hide::Ambient, false);
    }

    /// SPEC 6.4 idle trigger (gated by Revision 1 item 5). The logic lives in `crate::ambient`
    /// and `ambient_glue`; see there.
    fn start_idle_trigger(self: &Arc<Self>) {
        ambient_glue::start_trigger(self);
    }

    /// Any thread: send `bh:world-inputs` shortly after a change (bursts coalesce into one event,
    /// and identical inputs are never sent twice). Also the hook for a future choices writer.
    pub fn schedule_world_publish(self: &Arc<Self>) {
        let g = self.world_gen.fetch_add(1, Ordering::SeqCst) + 1;
        let me = self.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(250));
            if me.world_gen.load(Ordering::SeqCst) != g {
                return;
            }
            let w = me.world.lock().unwrap().take_if_changed();
            if let Some(w) = w {
                let _ = me.app.emit("bh:world-inputs", &w);
                log("world_inputs", json!({ "seed": w.seed, "days": w.ledger.days.len(), "choices": w.choices.log.len() }));
            }
        });
    }

    /// The collector rewrites ledger.json about every 30 s while it runs (it emits a ledger only on
    /// quit), and choices.json can change on disk: check their stamps every 30 s.
    fn start_world_file_watch(self: &Arc<Self>) {
        let me = self.clone();
        let _ = std::thread::Builder::new().name("bh-world-files".into()).spawn(move || loop {
            std::thread::sleep(Duration::from_secs(30));
            if me.world.lock().unwrap().refresh_files() {
                me.schedule_world_publish();
            }
        });
    }

    fn toggle_ambient(self: &Arc<Self>) {
        if self.app.get_webview_window("ambient").is_some() {
            self.close_ambient();
        } else {
            self.open_ambient();
        }
    }

    /// Main thread. The popover under (macOS menu bar) or above (Windows taskbar) the tray icon.
    fn toggle_popover(self: &Arc<Self>, anchor: Option<(f64, f64, f64, f64)>) {
        if let Some(w) = self.app.get_webview_window("popover") {
            let _ = w.destroy();
            return;
        }
        // Clicking the tray icon while the popover is open first blurs (and closes) it; do not
        // reopen it on that same click.
        if let Some(t) = *self.popover_closed_at.lock().unwrap() {
            if t.elapsed() < Duration::from_millis(350) {
                return;
            }
        }
        let ms = monitors(&self.app);
        let (pw, ph) = (360.0, 480.0);
        // A tray rect is only trusted when it lies on a display, in the top or bottom fifth (menu
        // bar or taskbar): right after launch macOS can report a rect that is not placed yet.
        let anchor = anchor.filter(|&(x, y, w, h)| {
            ms.iter().any(|m| {
                let (cx, cy) = (x + w / 2.0, y + h / 2.0);
                let band = m.bounds.h as f64 / 5.0;
                m.bounds.contains(cx, cy) && (cy - m.bounds.y as f64 <= band || m.bounds.bottom() as f64 - cy <= band)
            })
        });
        let (ax, ay, aw, ah) = anchor.unwrap_or_else(|| {
            let m = ms.iter().find(|m| m.primary).or(ms.first());
            m.map(|m| ((m.work.right() as f64) - 40.0 * m.scale, m.work.y as f64, 1.0, 1.0)).unwrap_or((0.0, 0.0, 1.0, 1.0))
        });
        let m = ms.iter().find(|m| m.bounds.contains(ax + aw / 2.0, ay + ah / 2.0)).or(ms.first()).cloned();
        let Some(m) = m else { return };
        let s = m.scale;
        let (w_px, h_px) = (pw * s, ph * s);
        let mut x = ax + aw / 2.0 - w_px / 2.0;
        let below = ay + ah / 2.0 < (m.bounds.y as f64 + m.bounds.h as f64 / 2.0);
        let mut y = if below { ay + ah + 6.0 * s } else { ay - h_px - 6.0 * s };
        x = x.clamp(m.work.x as f64 + 8.0 * s, (m.work.right() as f64 - w_px - 8.0 * s).max(m.work.x as f64));
        y = y.clamp(m.work.y as f64, (m.work.bottom() as f64 - h_px).max(m.work.y as f64));
        let r = WebviewWindowBuilder::new(&self.app, "popover", WebviewUrl::App("popover.html".into()))
            .title("Busyholm")
            .inner_size(pw, ph)
            .position(x / s, y / s)
            .decorations(false)
            .resizable(false)
            .skip_taskbar(true)
            .always_on_top(true)
            .visible_on_all_workspaces(true)
            .focused(true)
            .initialization_script(self.boot_script("popover"));
        // WP-11: native popover material on macOS; the page tints it instead of painting a solid sheet.
        #[cfg(target_os = "macos")]
        let r = r
            .transparent(true)
            .initialization_script("window.__BH_GLASS__ = true;")
            .effects(tauri::window::EffectsBuilder::new().effect(tauri::window::Effect::Popover).state(tauri::window::EffectState::Active).radius(12.0).build());
        let r = r.build();
        match r {
            Ok(w) => {
                set_frame(&w, PRect { x: x as i32, y: y as i32, w: w_px as u32, h: h_px as u32 }, s);
                let _ = w.set_focus();
                let me = self.clone();
                w.on_window_event(move |e| {
                    if let WindowEvent::Focused(false) = e {
                        *me.popover_closed_at.lock().unwrap() = Some(Instant::now());
                        let m2 = me.clone();
                        let _ = me.app.run_on_main_thread(move || {
                            if let Some(p) = m2.app.get_webview_window("popover") {
                                let _ = p.destroy();
                            }
                        });
                    }
                });
                log("window", json!({ "label": "popover", "pos_px": [x, y], "size_px": [w_px, h_px], "anchor_px": [ax, ay, aw, ah] }));
            }
            Err(e) => log("popover_error", json!({ "error": e.to_string() })),
        }
    }

    /// Main thread. Ordinary decorated, focusable windows (settings, details).
    fn open_window(self: &Arc<Self>, label: &str) {
        if let Some(w) = self.app.get_webview_window(label) {
            let _ = w.show();
            let _ = w.set_focus();
            return;
        }
        let (title, page, w, h) = match label {
            "settings" => ("Busyholm Settings", "settings.html", 560.0, 640.0),
            _ => ("Busyholm", "details.html", 440.0, 560.0),
        };
        let r = WebviewWindowBuilder::new(&self.app, label, WebviewUrl::App(page.into()))
            .title(title)
            .inner_size(w, h)
            .min_inner_size(320.0, 320.0)
            .center()
            .focused(true)
            .initialization_script(self.boot_script(label))
            .build();
        match r {
            Ok(win) => {
                let _ = win.set_focus();
                log("window", json!({ "label": label }));
            }
            Err(e) => log("window_error", json!({ "label": label, "error": e.to_string() })),
        }
    }

    fn open_surface(self: &Arc<Self>, surface: &str) {
        let me = self.clone();
        let s = surface.to_string();
        let _ = self.app.run_on_main_thread(move || match s.as_str() {
            "ambient" => me.open_ambient(),
            "popover" => {
                let anchor = me.app.tray_by_id("main").and_then(|t| t.rect().ok().flatten()).map(|r| {
                    let p = r.position.to_physical::<f64>(1.0);
                    let z = r.size.to_physical::<f64>(1.0);
                    (p.x, p.y, z.width, z.height)
                });
                me.toggle_popover(anchor)
            }
            "settings" | "details" => me.open_window(&s),
            _ => {}
        });
    }
}

// ------------------------------------------------------------------------------------------------
// Settings changes
// ------------------------------------------------------------------------------------------------

impl Core {
    fn update_settings(self: &Arc<Self>, new: Settings) -> Result<Settings, String> {
        let old = self.settings();
        self.settings.lock().unwrap().set(new.clone())?;
        log("settings_saved", json!({}));
        let me = self.clone();
        let (o, n) = (old.clone(), new.clone());
        let _ = self.app.run_on_main_thread(move || me.apply_settings_change(&o, &n));
        let _ = self.app.emit("bh:settings", &new);
        Ok(new)
    }

    /// Main thread.
    fn apply_settings_change(self: &Arc<Self>, old: &Settings, new: &Settings) {
        if old.strip.enabled != new.strip.enabled {
            if new.strip.enabled && self.app.get_webview_window("strip").is_none() && platform::strip_support() == StripSupport::Supported {
                let _ = self.create_strip();
            }
            self.set_hidden(Hide::Disabled, !new.strip.enabled);
        }
        if old.strip.height != new.strip.height || old.strip.display != new.strip.display {
            self.relayout(true);
        }
        if old.strip.layer_mode != new.strip.layer_mode || old.strip.hover_fade != new.strip.hover_fade || old.strip.show_over_fullscreen != new.strip.show_over_fullscreen {
            self.apply_layer();
            let me = self.clone();
            std::thread::spawn(move || me.check_fullscreen());
        }
        if old.other.launch_at_login != new.other.launch_at_login {
            self.apply_autostart(new.other.launch_at_login);
        }
        if old.ambient.shortcut != new.ambient.shortcut {
            self.register_shortcuts();
        }
        self.sync_tray();
    }

    fn apply_autostart(&self, on: bool) {
        use tauri_plugin_autostart::ManagerExt;
        let al = self.app.autolaunch();
        let r = if on { al.enable() } else { al.disable() };
        log("autostart", json!({ "enabled": al.is_enabled().ok(), "ok": r.is_ok() }));
    }

    pub(crate) fn stop_collector_without_flush(&self) {
        if let Some(h) = self.hub.lock().unwrap().take() {
            h.shutdown_without_flush();
        }
    }

    pub(crate) fn disable_autostart_for_delete(&self) {
        let fresh = self.settings.lock().unwrap().reset_in_memory();
        self.apply_autostart(false);
        self.register_shortcuts();
        self.world.lock().unwrap().clear();
        let _ = self.app.emit("bh:settings", &fresh);
    }

    fn register_shortcuts(&self) {
        use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};
        let gs = self.app.global_shortcut();
        let _ = gs.unregister_all();
        if let Some(acc) = self.settings().ambient.shortcut {
            match acc.parse::<Shortcut>() {
                Ok(sc) => {
                    let ok = gs.register(sc).is_ok();
                    log("shortcut", json!({ "ambient": ok }));
                }
                Err(_) => log("shortcut", json!({ "ambient": false, "error": "unparsable accelerator" })),
            }
        }
    }

    fn sync_tray(&self) {
        let s = self.settings();
        if let Some(t) = self.tray.lock().unwrap().as_ref() {
            let _ = t.strip.set_checked(s.strip.enabled);
            let l = self.requested_layer();
            let _ = t.on_top.set_checked(l == LayerMode::OnTop);
            let _ = t.behind.set_checked(l == LayerMode::BehindWindows);
            let _ = t.reserve.set_checked(l == LayerMode::ReserveSpace);
            let _ = t.autostart.set_checked(s.other.launch_at_login);
        }
    }

    fn set_layer_mode(self: &Arc<Self>, mode: LayerMode) {
        let mut s = self.settings();
        s.strip.layer_mode = mode;
        let _ = self.update_settings(s);
    }
}

// ------------------------------------------------------------------------------------------------
// Tray
// ------------------------------------------------------------------------------------------------

fn build_tray(app: &AppHandle, c0: &Arc<Core>) -> tauri::Result<()> {
    let s = c0.settings();
    let l = c0.requested_layer();
    let strip_ok = platform::strip_support() == StripSupport::Supported;
    let details = MenuItem::with_id(app, "details", "Open Busyholm", true, None::<&str>)?;
    let strip = CheckMenuItem::with_id(app, "strip", "Show strip", strip_ok, s.strip.enabled, None::<&str>)?;
    let on_top = CheckMenuItem::with_id(app, "layer_on_top", "On top", strip_ok, l == LayerMode::OnTop, None::<&str>)?;
    let behind = CheckMenuItem::with_id(app, "layer_behind", "Behind windows (experimental)", strip_ok, l == LayerMode::BehindWindows, None::<&str>)?;
    let reserve = CheckMenuItem::with_id(app, "layer_reserve", "Reserve space (experimental)", strip_ok && platform::reserve_supported(), l == LayerMode::ReserveSpace, None::<&str>)?;
    let layer = Submenu::with_id_and_items(app, "layer", "Strip layer", strip_ok, &[&on_top, &behind, &reserve])?;
    let ambient = MenuItem::with_id(app, "ambient", "Start ambient scene", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings...", true, None::<&str>)?;
    let autostart = CheckMenuItem::with_id(app, "autostart", "Launch at login", true, s.other.launch_at_login, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Busyholm", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let sep3 = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&details, &sep1, &strip, &layer, &ambient, &sep2, &settings, &autostart, &sep3, &quit])?;
    *c0.tray.lock().unwrap() = Some(TrayItems { strip, on_top, behind, reserve, autostart });

    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray@2x.png"))?;
    TrayIconBuilder::with_id("main")
        .icon(icon)
        .icon_as_template(true)
        .tooltip("Busyholm")
        .menu(&menu)
        // Left click opens the popover on macOS and Windows; Linux tray hosts only show the menu.
        .show_menu_on_left_click(OS == Os::Linux)
        .on_menu_event(|app, ev| {
            let c = core(app);
            log("tray_menu", json!(ev.id().as_ref()));
            match ev.id().as_ref() {
                "details" => c.open_surface("details"),
                "settings" => c.open_surface("settings"),
                "ambient" => c.open_surface("ambient"),
                "strip" => {
                    let mut s = c.settings();
                    s.strip.enabled = !s.strip.enabled;
                    let _ = c.update_settings(s);
                }
                "layer_on_top" => c.set_layer_mode(LayerMode::OnTop),
                "layer_behind" => c.set_layer_mode(LayerMode::BehindWindows),
                "layer_reserve" => c.set_layer_mode(LayerMode::ReserveSpace),
                "autostart" => {
                    let mut s = c.settings();
                    s.other.launch_at_login = !s.other.launch_at_login;
                    let _ = c.update_settings(s);
                }
                "quit" => app.exit(0),
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, ev| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, rect, .. } = ev {
                let c = core(tray.app_handle());
                let p = rect.position.to_physical::<f64>(1.0);
                let z = rect.size.to_physical::<f64>(1.0);
                let anchor = (p.x, p.y, z.width, z.height);
                let c2 = c.clone();
                let _ = c.app.run_on_main_thread(move || c2.toggle_popover(Some(anchor)));
            }
        })
        .build(app)?;
    // Evidence that the OS placed the status item.
    let h = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(2));
        let h2 = h.clone();
        let _ = h.run_on_main_thread(move || {
            let r = h2.tray_by_id("main").and_then(|t| t.rect().ok().flatten()).map(|r| {
                let p = r.position.to_physical::<f64>(1.0);
                let z = r.size.to_physical::<f64>(1.0);
                [p.x, p.y, z.width, z.height]
            });
            log("tray_rect", json!({ "rect": r }));
        });
    });
    Ok(())
}

// ------------------------------------------------------------------------------------------------
// Hub outlet and collectors
// ------------------------------------------------------------------------------------------------

struct TauriOutlet {
    app: AppHandle,
}

impl Outlet for TauriOutlet {
    fn snapshot(&self, s: &Snapshot) {
        let _ = self.app.emit("bh:snapshot", s);
        log("snapshot", json!({ "agents": s.agents.len(), "needs_you": s.attention.needs_you }));
        if let Some(c) = self.app.try_state::<Arc<Core>>() {
            c.inner().on_attention(s.attention.needs_you > 0);
        }
        wp11_glue::on_snapshot(&self.app, s);
    }
    fn moment(&self, m: &Moment) {
        let _ = self.app.emit("bh:moment", m);
        log("moment", json!({}));
        wp11_glue::on_moment(&self.app, m);
    }
    fn ledger(&self, l: &Ledger) {
        // The collector persists ledger.json itself (one writer per file, SPEC 6.11); the shell
        // only hands it to the pages as world inputs.
        log("ledger", json!({}));
        if let Some(c) = self.app.try_state::<Arc<Core>>() {
            let c = c.inner();
            c.world.lock().unwrap().set_ledger(l.clone());
            c.schedule_world_publish();
        }
    }
    fn note(&self, event: &str, data: serde_json::Value) {
        log(event, data);
    }
}

/// Used when no collector is available (release builds before WP-03 is linked): sends nothing.
#[cfg_attr(feature = "collector", allow(dead_code))]
struct NullCollector;
impl Collector for NullCollector {
    fn name(&self) -> &'static str {
        "none"
    }
    fn run(&mut self, _out: &FeedSender, stop: &AtomicBool) -> Result<(), String> {
        while !stop.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(500));
        }
        Ok(())
    }
}

fn pick_collector(opts: &Opts, data_dir: &std::path::Path, hooks: crate::hooks_link::HooksLink) -> Box<dyn Collector> {
    if let Some(dir) = &opts.mock {
        let mode = if opts.mock_static { MockMode::Static } else { MockMode::Cycle { period: Duration::from_secs(3) } };
        return Box::new(MockCollector::new(dir.clone(), mode).with_pick(opts.mock_fixture.clone()));
    }
    default_collector(data_dir, hooks)
}

/// With the `collector` feature: the real WP-03 collector.
#[cfg(feature = "collector")]
fn default_collector(data_dir: &std::path::Path, hooks: crate::hooks_link::HooksLink) -> Box<dyn Collector> {
    Box::new(crate::collector_link::RealCollector::new(data_dir.to_path_buf()).with_hooks(hooks))
}

/// Without it: the fixture mock in development builds, nothing in release builds.
#[cfg(not(feature = "collector"))]
fn default_collector(_data_dir: &std::path::Path, _hooks: crate::hooks_link::HooksLink) -> Box<dyn Collector> {
    if cfg!(debug_assertions) && crate::opts::repo_fixtures().exists() {
        return Box::new(MockCollector::new(crate::opts::repo_fixtures(), MockMode::Cycle { period: Duration::from_secs(3) }));
    }
    Box::new(NullCollector)
}

// ------------------------------------------------------------------------------------------------
// Commands (page to core)
// ------------------------------------------------------------------------------------------------

type CoreState<'a> = tauri::State<'a, Arc<Core>>;

#[tauri::command]
fn bh_get_world_inputs(core: CoreState<'_>) -> Option<crate::world_inputs::WorldInputs> {
    core.world.lock().unwrap().current()
}

#[tauri::command]
fn bh_get_snapshot(core: CoreState<'_>) -> Option<Snapshot> {
    core.hub.lock().unwrap().as_ref().and_then(|h| h.latest())
}

#[tauri::command]
fn bh_hit_rects(window: WebviewWindow, core: CoreState<'_>, msg: serde_json::Value) -> Result<(), String> {
    if window.label() != "strip" {
        return Err("hit rects come from the strip only".into());
    }
    let m: HitRects = busyholm_contracts::from_value(msg).map_err(|e| e.to_string())?;
    if core.poll.geom.lock().unwrap().is_none() {
        return Ok(());
    }
    let (accepted, rects) = {
        let mut hits = core.poll.hits.lock().unwrap();
        let accepted = hits.publish(&m);
        (accepted, hits.rects().to_vec())
    };
    if !accepted {
        // laid out for a geometry the strip no longer has: the page republishes after bh:strip-geometry
        log("hit_rects_ignored", json!({ "viewport": [m.viewport.w, m.viewport.h] }));
        return Ok(());
    }
    let r1 = |v: f64| (v * 10.0).round() / 10.0;
    log("hit_rects", json!({ "count": rects.len(), "viewport": [m.viewport.w, m.viewport.h],
        "rects": rects.iter().map(|r| [r1(r.x), r1(r.y), r1(r.w), r1(r.h)]).collect::<Vec<_>>() }));
    Ok(())
}

#[tauri::command]
fn bh_visibility_ack(window: WebviewWindow, visible: bool) {
    log("visibility_ack", json!({ "label": window.label(), "visible": visible }));
}

#[tauri::command]
fn bh_renderer_stats(window: WebviewWindow, core: CoreState<'_>, stats: crate::renderer_stats::RendererStats) {
    if !crate::testlog::enabled() || !matches!(window.label(), "strip" | "ambient") || !stats.valid() {
        return;
    }
    let mut data = serde_json::to_value(stats).unwrap();
    if let Some(s) = core.hub.lock().unwrap().as_ref().and_then(|h| h.latest()) {
        data["collector_agents"] = json!(s.agents.len());
        data["collector_working"] = json!(s.agents.iter().filter(|a| a.state == busyholm_contracts::snapshot::AgentState::Working).count());
    }
    log("page_stats", data);
}

#[tauri::command]
fn bh_ambient_exit(core: CoreState<'_>) {
    let c = core.inner().clone();
    let c2 = c.clone();
    let _ = c.app.run_on_main_thread(move || c2.close_ambient());
}

#[tauri::command]
fn bh_get_settings(core: CoreState<'_>) -> Settings {
    core.settings()
}

#[tauri::command]
fn bh_set_settings(core: CoreState<'_>, settings: serde_json::Value) -> Result<Settings, String> {
    let s: Settings = busyholm_contracts::from_value(settings).map_err(|e| e.to_string())?;
    core.inner().update_settings(s)
}

#[tauri::command]
fn bh_open(core: CoreState<'_>, surface: String) {
    core.inner().open_surface(&surface);
}

#[tauri::command]
fn bh_close(window: WebviewWindow, core: CoreState<'_>) {
    match window.label() {
        "ambient" => {
            let c = core.inner().clone();
            let c2 = c.clone();
            let _ = c.app.run_on_main_thread(move || c2.close_ambient());
        }
        "strip" => {}
        _ => {
            let _ = window.destroy();
        }
    }
}

const PAGE_EVENTS: &[&str] = &["resident_click", "card_open", "card_close", "ambient_input"];

#[tauri::command]
fn bh_page_event(window: WebviewWindow, name: String) {
    if PAGE_EVENTS.contains(&name.as_str()) {
        log("page_event", json!({ "name": name, "label": window.label() }));
    }
}

// ------------------------------------------------------------------------------------------------
// Entry point
// ------------------------------------------------------------------------------------------------

pub fn run() {
    let opts = crate::opts::parse(std::env::args());
    crate::testlog::init(opts.test_log.clone());
    log("start", json!({ "pid": std::process::id(), "version": env!("CARGO_PKG_VERSION"), "os": OS.as_str() }));

    let builder = tauri::Builder::default();
    // One Busyholm per user: a second launch focuses the running app's details window and exits.
    // Registered first, as the plugin requires. Runs with a data-folder override (tests, other
    // agents' parallel test runs) skip it unless --single-instance asks for it.
    let single = opts.single_instance || (opts.data_dir.is_none() && std::env::var_os("BUSYHOLM_DATA_DIR").is_none());
    let builder = if single {
        builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // The second launch's arguments are never logged.
            log("second_instance", json!({}));
            if let Some(c) = app.try_state::<Arc<Core>>() {
                c.inner().open_surface("details");
            }
        }))
    } else {
        builder
    };
    // tao activates the app at launch by default, which steals focus from the user's app.
    #[cfg(target_os = "macos")]
    let builder = builder.activate_ignoring_other_apps(false);
    #[cfg(target_os = "macos")]
    let builder = builder.on_web_content_process_terminate(|webview| {
        // SPEC 6.11: a crashed webview is reloaded by the core.
        log("webview_crashed", json!({ "label": webview.label() }));
        let _ = webview.reload();
    });

    let app = builder
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        let c = core(app);
                        let c2 = c.clone();
                        let _ = c.app.run_on_main_thread(move || c2.toggle_ambient());
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            bh_get_snapshot, bh_get_world_inputs, bh_hit_rects, bh_visibility_ack, bh_renderer_stats, bh_ambient_exit, bh_get_settings, bh_set_settings, bh_open, bh_close, bh_page_event,
            wp11_glue::bh_connect_status, wp11_glue::bh_connect_preview, wp11_glue::bh_disconnect_preview, wp11_glue::bh_connect_apply, wp11_glue::bh_delete_everything, wp11_glue::bh_onboarding, wp11_glue::bh_third_party_notices
        ])
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory); // menu-bar app, no Dock icon
            let h = app.handle().clone();
            let hooks = crate::hooks_link::HooksLink::new();
            let data_dir = crate::paths::data_dir(opts.data_dir.clone()).ok_or("no app data folder")?;
            let (store, note) = SettingsStore::load(&data_dir)?;
            log("settings", json!({ "load": format!("{note:?}") }));
            let core = Arc::new(Core {
                app: h.clone(),
                opts: opts.clone(),
                data_dir: data_dir.clone(),
                settings: Mutex::new(store),
                hub: Mutex::new(None),
                strip: Mutex::new(StripState::default()),
                poll: Arc::new(PollShared { geom: Mutex::new(None), hits: Mutex::new(clickthrough::HitStore::default()), active: Mutex::new(false), cv: Condvar::new(), hover_fade: AtomicBool::new(true) }),
                popover_closed_at: Mutex::new(None),
                tray: Mutex::new(None),
                relayout_gen: AtomicU64::new(0),
                fullscreen_gen: AtomicU64::new(0),
                world: Mutex::new(crate::world_inputs::Tracker::new(data_dir.clone())),
                world_gen: AtomicU64::new(0),
                watch_registered: AtomicBool::new(false),
            });
            app.manage(core.clone());

            build_tray(&h, &core)?;
            // WP-11: connect commands, notifications, first-run onboarding (not in test runs).
            wp11_glue::setup(&h, data_dir.clone(), opts.test_log.is_none() && std::env::var_os("BUSYHOLM_NO_ONBOARDING").is_none(), hooks.clone());
            {
                use tauri_plugin_autostart::ManagerExt;
                let on = core.settings().other.launch_at_login;
                let enabled = h.autolaunch().is_enabled().unwrap_or(false);
                // Off by default: only ever enabled by the user's setting.
                if on && !enabled {
                    let _ = h.autolaunch().enable();
                }
                log("autostart", json!({ "enabled": h.autolaunch().is_enabled().ok() }));
            }
            core.register_shortcuts();
            core.start_idle_trigger();
            core.start_world_file_watch();

            let hub = Hub::start(pick_collector(&opts, &core.data_dir, hooks.clone()), Arc::new(TauriOutlet { app: h.clone() }), HubConfig::default());
            *core.hub.lock().unwrap() = Some(hub);

            match platform::strip_support() {
                StripSupport::Supported => {
                    if let Err(e) = core.create_strip() {
                        log("strip_error", json!({ "error": e }));
                    }
                    core.start_poller();
                    // SPEC 6.5 backstop: re-check displays and fullscreen every 5 s, in case an OS
                    // change came without a notification (Dock moves on some macOS versions).
                    let c = core.clone();
                    std::thread::Builder::new().name("bh-backstop".into()).spawn(move || loop {
                        std::thread::sleep(Duration::from_secs(5));
                        let ms = monitors(&c.app);
                        if sig(&ms) != c.strip.lock().unwrap().monitors_sig {
                            let c2 = c.clone();
                            let _ = c.app.run_on_main_thread(move || c2.relayout(false));
                        }
                        c.check_fullscreen();
                    })?;
                }
                StripSupport::Unsupported(why) => {
                    log("strip_unsupported", json!({ "reason": why }));
                    core.open_window("details");
                }
            }
            if !opts.open.is_empty() {
                // Test and debug use: wait until the tray icon has been placed by the OS.
                let (c, list) = (core.clone(), opts.open.clone());
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(2500));
                    for s in &list {
                        c.open_surface(s);
                    }
                });
            }
            if let Some(secs) = opts.exit_after {
                let h2 = h.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_secs_f64(secs));
                    h2.exit(0);
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the Busyholm app");

    app.run(|app, event| match event {
        // A menu-bar app: closing the last window must not quit (only Quit or an explicit exit).
        RunEvent::ExitRequested { api, code, .. } => {
            if code.is_none() {
                api.prevent_exit();
            }
        }
        RunEvent::Exit => {
            if let Some(c) = app.try_state::<Arc<Core>>() {
                let c = c.inner().clone();
                let (monitor, reserved) = {
                    let st = c.strip.lock().unwrap();
                    (st.monitor.clone(), st.reserved.is_some())
                };
                if let (Some(w), Some(m), true) = (app.get_webview_window("strip"), monitor, reserved) {
                    let _ = platform::reserve_space(&w, None, &m);
                }
                if let Some(h) = c.hub.lock().unwrap().take() {
                    h.shutdown();
                }
                log("exit", json!({}));
            }
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_monitor(name: &str, primary: bool) -> MonitorInfo {
        MonitorInfo {
            name: Some(name.to_string()),
            bounds: PRect { x: 0, y: 0, w: 2880, h: 1800 },
            work: PRect { x: 0, y: 25, w: 2880, h: 1700 },
            scale: 2.0,
            primary,
        }
    }

    #[test]
    fn monitors_with_fallback_uses_primary_when_available_monitors_is_empty() {
        let primary = sample_monitor("Built-in Retina Display", false);
        let resolved = monitors_with_fallback(Vec::new(), Some(primary));
        assert_eq!(resolved.len(), 1);
        assert_eq!(resolved[0].name.as_deref(), Some("Built-in Retina Display"));
        assert!(resolved[0].primary, "fallback monitor must be marked primary");

        let avail = vec![sample_monitor("External Display", false), sample_monitor("Built-in Retina Display", true)];
        let resolved_non_empty = monitors_with_fallback(avail.clone(), Some(sample_monitor("Ignored Fallback", true)));
        assert_eq!(resolved_non_empty, avail, "non-empty available_monitors must be returned as is");

        let resolved_none = monitors_with_fallback(Vec::new(), None);
        assert!(resolved_none.is_empty());
    }

    #[test]
    fn p3_2_create_strip_stores_monitors_sig_only_after_window_build_succeeds() {
        let ms = vec![sample_monitor("Built-in Retina Display", true)];
        let p = geometry::place(&ms, None, OS, 56, None).expect("placement on primary monitor");
        let m = ms[p.monitor].clone();
        let strip = Mutex::new(StripState::default());

        let err = build_strip_and_record_sig(&strip, &ms, p, &m, || -> Result<(), String> {
            assert_eq!(strip.lock().unwrap().placement, Some(p), "placement is available for boot_script during build");
            Err("window build failed".into())
        })
        .expect_err("failed build must return Err");
        assert_eq!(err, "window build failed");
        assert!(
            strip.lock().unwrap().monitors_sig.is_empty(),
            "monitors_sig must remain empty when window build fails so bh-backstop retries"
        );
        assert_ne!(
            sig(&ms),
            strip.lock().unwrap().monitors_sig,
            "bh-backstop condition sig(&ms) != monitors_sig must remain true after failed build"
        );

        let built = build_strip_and_record_sig(&strip, &ms, p, &m, || -> Result<&str, String> { Ok("strip-window") })
            .expect("succeeding build must return Ok");
        assert_eq!(built, "strip-window");
        assert_eq!(
            strip.lock().unwrap().monitors_sig,
            sig(&ms),
            "monitors_sig must be stored once window build succeeds"
        );
    }
}
