//! Linux (gtk 0.18). The strip is supported on X11 only (SPEC 6.3, Revision 1 item 5). Tauri has no
//! layer-shell, so on a Wayland session `strip_support` says Unsupported and the tray and the
//! details window carry the product.
//!
//! - Strip: `_NET_WM_WINDOW_TYPE_DOCK` (GTK type hint Dock), skip taskbar and pager, keep above,
//!   on all workspaces, never takes focus (`accept_focus` false, so the WM never gives it input
//!   focus when it is clicked or mapped).
//! - Reserve space: `_NET_WM_STRUT_PARTIAL` (and the older `_NET_WM_STRUT`) on the strip's window.
//! - Fullscreen check: `_NET_CLIENT_LIST` on the root window, then each client's `_NET_WM_STATE`.
//! - Notifications, not polling: GDK `monitors-changed` and `size-changed`, plus a GDK event filter
//!   on the root window that sees `_NET_WORKAREA`, `_NET_ACTIVE_WINDOW`, `_NET_CURRENT_DESKTOP`
//!   and `_NET_CLIENT_LIST(_STACKING)` change. (The glue's 5 s backstop covers anything missed, for
//!   example an app toggling fullscreen in place, which changes only its own `_NET_WM_STATE`; under
//!   openbox the toggle also restacks, so the filter saw it within 0.3 s in the VM.)
//! - Window manager denylist: `strip_support` withholds the strip under window managers measured to
//!   fail click-through (`DENIED_WMS`); `BUSYHOLM_STRIP_ANY_WM=1` skips the list for testers.
//! - Height: see `fix_height_floor` (the spike's 200 px strip).
//! - Known limit, not fixable here: click-through is an X11 input shape on the strip's window. A
//!   window manager that wraps every window in a frame window of its own (openbox, and in the VM
//!   test fluxbox, xfwm4 and icewm) puts the pointer on that frame, which has no input shape, so
//!   clicks on empty strip area do not reach the window beneath. Verified to work with no window
//!   manager and under metacity (app/tests/linux/acceptance.sh, test 2).
//!
//! Units. GDK window coordinates and sizes are device-independent: X pixels divided by the GDK
//! scale factor (`GDK_SCALE`, an integer). Tauri/tao report monitors as GDK units times the scale,
//! which is X pixels, and the glue works in those, so every rectangle given to this module is in X
//! pixels. X properties (struts, geometry read back from foreign windows) are also X pixels, so
//! struts need no conversion except for the screen height, which is read from the GDK root window
//! (device-independent) and multiplied by the root window's scale factor.
//!
//! Foreign (other applications') windows are reached through three libgdk-3 functions that gtk-rs
//! does not wrap (`gdk_x11_window_foreign_new_for_display`, `gdk_x11_get_xatom_by_name_for_display`
//! and `gdk_x11_window_get_xid`): the gdkx11 crate is not a dependency of this crate and Cargo.toml
//! is not changed by this module. They are called only when the display is X11.
use std::ffi::{c_int, c_ulong, c_void, CString};
use std::os::raw::c_char;
use std::sync::{mpsc, OnceLock};
use std::time::Duration;

use gtk::gdk;
use gtk::glib::translate::{from_glib_full, ToGlibPtr};
use gtk::glib::{self, prelude::*};
use gtk::prelude::*;
use serde_json::{json, Value};
use tauri::{AppHandle, WebviewWindow};

use super::{Layer, Notify, StripSupport};
use crate::geometry::{MonitorInfo, PRect};

/// The idle trigger stays off until a per-display fullscreen check is verified here (Revision 1).
/// This X11 check is verified on one Xvfb screen under openbox only (acceptance test 4).
pub const IDLE_TRIGGER_VERIFIED: bool = false;

// ------------------------------------------------------------------------------------------------
// Backend detection
// ------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Backend {
    X11,
    Wayland,
    Other,
}

static BACKEND: OnceLock<Backend> = OnceLock::new();

fn classify(type_name: &str) -> Backend {
    match type_name {
        "GdkX11Display" => Backend::X11,
        "GdkWaylandDisplay" => Backend::Wayland,
        _ => Backend::Other,
    }
}

/// What GDK would pick, from the environment. Used only when asked off the main thread before the
/// main thread has recorded the real answer (GDK display calls panic off the main thread).
fn env_backend() -> Backend {
    let get = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
    if let Some(list) = get("GDK_BACKEND") {
        for item in list.split(',') {
            match item.trim() {
                "x11" => return Backend::X11,
                "wayland" => return Backend::Wayland,
                _ => {}
            }
        }
    }
    if get("WAYLAND_DISPLAY").is_some() {
        Backend::Wayland
    } else if get("DISPLAY").is_some() {
        Backend::X11
    } else {
        Backend::Other
    }
}

fn backend() -> Backend {
    if let Some(b) = BACKEND.get() {
        return *b;
    }
    if gtk::is_initialized_main_thread() {
        let b = gdk::Display::default().map(|d| classify(d.type_().name())).unwrap_or(Backend::Other);
        let _ = BACKEND.set(b);
        return b;
    }
    env_backend()
}

fn is_x11() -> bool {
    backend() == Backend::X11
}

/// An X11 display that is really XWayland (a Wayland session with GDK_BACKEND=x11): the compositor
/// ignores struts from X clients, so reserve space is not offered there.
fn is_xwayland() -> bool {
    std::env::var("WAYLAND_DISPLAY").map(|v| !v.is_empty()).unwrap_or(false)
}

// ------------------------------------------------------------------------------------------------
// X11 property helpers (main thread only)
// ------------------------------------------------------------------------------------------------

extern "C" {
    fn gdk_x11_window_foreign_new_for_display(display: *mut gdk::ffi::GdkDisplay, window: c_ulong) -> *mut gdk::ffi::GdkWindow;
    fn gdk_x11_get_xatom_by_name_for_display(display: *mut gdk::ffi::GdkDisplay, name: *const c_char) -> c_ulong;
    fn gdk_x11_window_get_xid(window: *mut gdk::ffi::GdkWindow) -> c_ulong;
}

fn atom(name: &str) -> gdk::Atom {
    gdk::Atom::intern(name)
}

fn xatom(display: &gdk::Display, name: &str) -> c_ulong {
    let c = CString::new(name).unwrap_or_default();
    unsafe { gdk_x11_get_xatom_by_name_for_display(display.to_glib_none().0, c.as_ptr()) }
}

fn xid_of(w: &gdk::Window) -> c_ulong {
    unsafe { gdk_x11_window_get_xid(w.to_glib_none().0) }
}

/// A 32-bit property as a list of values. Xlib hands 32-bit items over as C longs, so GDK returns
/// them as native-endian `long`s; only the low 32 bits carry the value.
fn read_ulongs(w: &gdk::Window, prop: &str) -> Option<Vec<u64>> {
    let (_ty, format, data) = gdk::property_get(w, &atom(prop), &gdk::ATOM_NONE, 0, 65536, 0)?;
    if format != 32 {
        return None;
    }
    let n = std::mem::size_of::<c_ulong>();
    Some(
        data.chunks_exact(n)
            .map(|c| {
                let mut b = [0u8; 8];
                b[..n].copy_from_slice(c);
                u64::from_ne_bytes(b) & 0xFFFF_FFFF
            })
            .collect(),
    )
}

/// Names of the atoms in an ATOM-typed property. GDK converts the X atoms of ATOM properties to
/// its own `GdkAtom` values on the way out, so they are compared with `Atom::value`, not with X
/// atom numbers (those come only from the raw property events in the root filter).
fn read_atom_names(w: &gdk::Window, prop: &str) -> Vec<String> {
    let want = [
        "_NET_WM_WINDOW_TYPE_DOCK",
        "_NET_WM_WINDOW_TYPE_NORMAL",
        "_NET_WM_WINDOW_TYPE_DESKTOP",
        "_NET_WM_WINDOW_TYPE_UTILITY",
        "_NET_WM_STATE_ABOVE",
        "_NET_WM_STATE_BELOW",
        "_NET_WM_STATE_STICKY",
        "_NET_WM_STATE_FULLSCREEN",
        "_NET_WM_STATE_HIDDEN",
        "_NET_WM_STATE_SKIP_TASKBAR",
        "_NET_WM_STATE_SKIP_PAGER",
    ];
    let table: Vec<(u64, &str)> = want.iter().map(|n| (atom(n).value() as u64 & 0xFFFF_FFFF, *n)).collect();
    read_ulongs(w, prop)
        .unwrap_or_default()
        .into_iter()
        .map(|v| table.iter().find(|(id, _)| *id == v).map(|(_, n)| n.to_string()).unwrap_or_else(|| format!("atom#{v}")))
        .collect()
}

fn root_window() -> Option<gdk::Window> {
    gdk::Screen::default()?.root_window()
}

/// The strip's GDK window. Realized in `prepare_strip`.
fn gdk_window_of(w: &WebviewWindow) -> Result<gdk::Window, String> {
    let gw = w.gtk_window().map_err(|e| e.to_string())?;
    gw.window().ok_or_else(|| "strip window is not realized".to_string())
}

fn describe(w: &WebviewWindow) -> Value {
    let Ok(gw) = w.gtk_window() else { return json!({ "error": "no gtk window" }) };
    let Some(win) = gw.window() else { return json!({ "realized": false }) };
    json!({
        "backend": "x11",
        "xwayland": is_xwayland(),
        "xid": xid_of(&win),
        "realized": true,
        "mapped": win.is_visible(),
        "type_hint": format!("{:?}", win.type_hint()),
        "window_type": read_atom_names(&win, "_NET_WM_WINDOW_TYPE"),
        "wm_state": read_atom_names(&win, "_NET_WM_STATE"),
        "gdk_scale_factor": win.scale_factor(),
        "accept_focus": gw.accepts_focus(),
    })
}

// ------------------------------------------------------------------------------------------------
// Interface
// ------------------------------------------------------------------------------------------------

/// Window managers measured to swallow clicks on the strip (acceptance test 2): they wrap every
/// window in a frame window that has no input shape, so clicks on empty strip area never reach the
/// window beneath. A full-width band that swallows clicks is worse than no strip (SPEC Revision 1
/// item 5), so the strip is withheld there. Matched case-insensitively against the WM's name.
const DENIED_WMS: &[(&str, &str)] = &[
    ("openbox", "window manager openbox: clicks do not pass through its frame windows (tested)"),
    ("fluxbox", "window manager fluxbox: clicks do not pass through its frame windows (tested)"),
    ("xfwm4", "window manager xfwm4: clicks do not pass through its frame windows (tested)"),
    ("icewm", "window manager icewm: clicks do not pass through its frame windows (tested)"),
];

static X11_VERDICT: OnceLock<StripSupport> = OnceLock::new();

/// The window manager's name: the root window's `_NET_SUPPORTING_WM_CHECK` names a child window of
/// the WM, whose `_NET_WM_NAME` (UTF8_STRING) is the name; `WM_NAME` is the fallback. Main thread.
fn wm_name() -> Option<String> {
    let root = root_window()?;
    let display = root.display();
    let check = read_ulongs(&root, "_NET_SUPPORTING_WM_CHECK")?.first().copied().filter(|&x| x != 0)?;
    let win = foreign_window(&display, check as c_ulong)?;
    for prop in ["_NET_WM_NAME", "WM_NAME"] {
        if let Some((_ty, 8, data)) = gdk::property_get(&win, &atom(prop), &gdk::ATOM_NONE, 0, 1024, 0) {
            let name = String::from_utf8_lossy(&data).trim_end_matches('\0').trim().to_string();
            if !name.is_empty() {
                return Some(name);
            }
        }
    }
    None
}

fn x11_verdict() -> StripSupport {
    if let Some(v) = X11_VERDICT.get() {
        return *v;
    }
    if std::env::var("BUSYHOLM_STRIP_ANY_WM").map(|v| v == "1").unwrap_or(false) {
        return StripSupport::Supported;
    }
    // GDK is main-thread only. Off the main thread before the verdict is cached, do not deny.
    if !gtk::is_initialized_main_thread() {
        return StripSupport::Supported;
    }
    // No window manager yet, or a name that cannot be read: do not deny, and do not cache.
    let Some(name) = wm_name() else { return StripSupport::Supported };
    let lower = name.to_lowercase();
    let v = match DENIED_WMS.iter().find(|(k, _)| lower.contains(k)) {
        Some((_, why)) => StripSupport::Unsupported(why),
        None => StripSupport::Supported,
    };
    let _ = X11_VERDICT.set(v);
    v
}

pub fn strip_support() -> StripSupport {
    match backend() {
        Backend::X11 => x11_verdict(),
        Backend::Wayland => StripSupport::Unsupported("wayland: no tested layer-shell support"),
        Backend::Other => StripSupport::Unsupported("no X11 or Wayland display"),
    }
}

/// `_NET_WM_STRUT_PARTIAL` is honoured by X11 window managers; an XWayland compositor ignores it.
pub fn reserve_supported() -> bool {
    is_x11() && !is_xwayland()
}

/// The spike's "X11 strip came out 200 px tall instead of 132" bug. A GtkApplicationWindow with no
/// size request has a natural size of 200x200, and when it is first mapped GTK takes that as the
/// height (the width follows the requested size), ignoring `gtk_window_resize` and the default
/// size; tao then freezes the window at that size (`set_resizable(false)` after the first
/// configure). Measured in the VM: a 1x1 size request alone gives a 1x1 window, explicit
/// geometry hints alone still give 200 px, both together give exactly the requested size.
fn fix_height_floor(gw: &gtk::ApplicationWindow) {
    gw.set_size_request(1, 1);
    let g = gdk::Geometry::new(0, 0, 100_000, 100_000, 0, 0, 0, 0, 0.0, 0.0, gdk::Gravity::NorthWest);
    gw.set_geometry_hints(None::<&gtk::Window>, Some(&g), gdk::WindowHints::MIN_SIZE | gdk::WindowHints::MAX_SIZE);
}

/// Main thread. After the strip is built (hidden), before it is first shown.
pub fn prepare_strip(w: &WebviewWindow) -> Result<Value, String> {
    if !is_x11() {
        return Ok(json!({ "backend": format!("{:?}", backend()).to_lowercase(), "note": "strip not supported here" }));
    }
    let gw = w.gtk_window().map_err(|e| e.to_string())?;
    gw.set_type_hint(gdk::WindowTypeHint::Dock);
    gw.set_skip_taskbar_hint(true);
    gw.set_skip_pager_hint(true);
    gw.set_keep_above(true);
    gw.stick();
    gw.set_accept_focus(false);
    gw.set_focus_on_map(false);
    // Create the X window now (without mapping it) so properties can be set and read back before
    // the first show.
    fix_height_floor(&gw);
    gw.realize();
    Ok(describe(w))
}

/// Main thread. On top: keep above, not below. Behind: keep below, not above. The window type stays
/// Dock; under openbox a Dock window with `_NET_WM_STATE_BELOW` is stacked below ordinary windows
/// (measured in the acceptance run, test x).
pub fn apply_layer(w: &WebviewWindow, layer: Layer, _over_fullscreen: bool) -> Result<Value, String> {
    let gw = w.gtk_window().map_err(|e| e.to_string())?;
    match layer {
        Layer::OnTop => {
            gw.set_keep_below(false);
            gw.set_keep_above(true);
        }
        Layer::Behind => {
            gw.set_keep_above(false);
            gw.set_keep_below(true);
        }
    }
    let mut d = describe(w);
    d["layer"] = json!(match layer {
        Layer::OnTop => "on_top",
        Layer::Behind => "behind",
    });
    Ok(d)
}

/// Main thread. Some(rect): set the struts for that strip and return the rect unchanged (the window
/// manager shrinks the work area itself). None: delete the struts.
pub fn reserve_space(w: &WebviewWindow, rect: Option<PRect>, _m: &MonitorInfo) -> Result<Option<PRect>, String> {
    if !is_x11() {
        return Err("unsupported".into());
    }
    let win = gdk_window_of(w)?;
    let strut_partial = atom("_NET_WM_STRUT_PARTIAL");
    let strut = atom("_NET_WM_STRUT");
    let cardinal = atom("CARDINAL");
    match rect {
        Some(r) => {
            // Struts count from the screen edge, in X pixels. The root window reports
            // device-independent units, so multiply by its scale factor to get X pixels.
            let root = root_window().ok_or("no root window")?;
            let (_, _, _rw, rh) = root.geometry();
            let screen_h = rh as i64 * root.scale_factor().max(1) as i64;
            let bottom = (screen_h - r.y as i64).clamp(0, u32::MAX as i64) as c_ulong;
            let x0 = r.x.max(0) as c_ulong;
            let x1 = (r.right() - 1).max(0) as c_ulong;
            let partial: [c_ulong; 12] = [0, 0, 0, bottom, 0, 0, 0, 0, 0, 0, x0, x1];
            gdk::property_change(&win, &strut_partial, &cardinal, 32, gdk::PropMode::Replace, gdk::ChangeData::ULongs(&partial));
            gdk::property_change(&win, &strut, &cardinal, 32, gdk::PropMode::Replace, gdk::ChangeData::ULongs(&partial[..4]));
            Ok(Some(r))
        }
        None => {
            gdk::property_delete(&win, &strut_partial);
            gdk::property_delete(&win, &strut);
            Ok(None)
        }
    }
}

/// Main thread. The strip never takes focus (`accept_focus` false), so a plain show is enough.
pub fn show_inactive(w: &WebviewWindow) -> Result<(), String> {
    w.show().map_err(|e| e.to_string())
}

/// Main thread. The glue sizes the ambient window to the monitor; this keeps it above the rest and
/// on every workspace. It keeps accepting focus because ambient receives keys.
pub fn prepare_ambient(w: &WebviewWindow) -> Result<Value, String> {
    let gw = w.gtk_window().map_err(|e| e.to_string())?;
    gw.set_skip_taskbar_hint(true);
    gw.set_skip_pager_hint(true);
    gw.set_keep_below(false);
    gw.set_keep_above(true);
    gw.stick();
    Ok(json!({ "keep_above": true, "sticky": true }))
}

/// Main thread. Nothing to hand back: X11 has no app activation to undo.
pub fn after_ambient(_app: &AppHandle) {}

/// Any thread. Global cursor in physical (X) pixels; Tauri returns it from the GDK pointer, which
/// works on X11 (it returns 0,0 on Wayland, where the strip is unsupported anyway).
pub fn cursor(app: &AppHandle, _strip_scale: f64) -> Option<(f64, f64)> {
    app.cursor_position().ok().map(|p| (p.x, p.y))
}

/// The idle trigger is off by default and `XScreenSaverQueryInfo` is not linked.
pub fn idle_seconds() -> Option<f64> {
    None
}

/// Any thread. Is another app fullscreen on this monitor? GDK is main-thread only, so the work is
/// handed to the GLib main context and the answer waited for at most 500 ms; None on timeout, when
/// not X11, or when the window manager does not publish `_NET_CLIENT_LIST`.
pub fn other_app_fullscreen(m: &MonitorInfo) -> Option<bool> {
    if !is_x11() {
        return None;
    }
    let m = m.clone();
    let (tx, rx) = mpsc::channel();
    glib::MainContext::default().invoke(move || {
        let _ = tx.send(fullscreen_on_main(&m));
    });
    rx.recv_timeout(Duration::from_millis(500)).ok().flatten()
}

fn foreign_window(display: &gdk::Display, xid: c_ulong) -> Option<gdk::Window> {
    unsafe {
        let p = gdk_x11_window_foreign_new_for_display(display.to_glib_none().0, xid);
        if p.is_null() {
            None
        } else {
            Some(from_glib_full(p))
        }
    }
}

/// Main thread. Walks the window manager's client list: a mapped, not minimised client of another
/// process on the current desktop, with `_NET_WM_STATE_FULLSCREEN`, covering at least half of the
/// strip's monitor.
fn fullscreen_on_main(m: &MonitorInfo) -> Option<bool> {
    let root = root_window()?;
    let display = root.display();
    let clients = read_ulongs(&root, "_NET_CLIENT_LIST")?;
    let current_desktop = read_ulongs(&root, "_NET_CURRENT_DESKTOP").and_then(|v| v.first().copied());
    let fullscreen = atom("_NET_WM_STATE_FULLSCREEN").value() as u64 & 0xFFFF_FFFF;
    let hidden = atom("_NET_WM_STATE_HIDDEN").value() as u64 & 0xFFFF_FFFF;
    let me = std::process::id() as u64;
    let mon_area = m.bounds.w as i64 * m.bounds.h as i64;
    for xid in clients {
        let Some(win) = foreign_window(&display, xid as c_ulong) else { continue };
        if read_ulongs(&win, "_NET_WM_PID").and_then(|v| v.first().copied()) == Some(me) {
            continue;
        }
        let state = read_ulongs(&win, "_NET_WM_STATE").unwrap_or_default();
        if !state.contains(&fullscreen) || state.contains(&hidden) {
            continue;
        }
        // Another desktop: _NET_WM_DESKTOP is a desktop number, or 0xFFFFFFFF for all desktops.
        if let (Some(cur), Some(d)) = (current_desktop, read_ulongs(&win, "_NET_WM_DESKTOP").and_then(|v| v.first().copied())) {
            if d != 0xFFFF_FFFF && d != cur {
                continue;
            }
        }
        // Geometry in X pixels: GDK units times the window's scale factor.
        let s = win.scale_factor().max(1) as i64;
        let (_ok, ox, oy) = win.origin();
        let (_, _, w, h) = win.geometry();
        let (x0, y0, x1, y1) = (ox as i64 * s, oy as i64 * s, (ox as i64 + w as i64) * s, (oy as i64 + h as i64) * s);
        let ix = (x1.min(m.bounds.right() as i64) - x0.max(m.bounds.x as i64)).max(0);
        let iy = (y1.min(m.bounds.bottom() as i64) - y0.max(m.bounds.y as i64)).max(0);
        if mon_area > 0 && ix * iy * 2 >= mon_area {
            return Some(true);
        }
    }
    Some(false)
}

// ------------------------------------------------------------------------------------------------
// Notifications
// ------------------------------------------------------------------------------------------------

/// The head of Xlib's XPropertyEvent (the fields we read), laid out by `repr(C)` exactly as in
/// `<X11/Xlib.h>` for the platform's `long` and pointer widths.
#[repr(C)]
struct XPropertyEvent {
    type_: c_int,
    serial: c_ulong,
    send_event: c_int,
    display: *mut c_void,
    window: c_ulong,
    atom: c_ulong,
}
const X_PROPERTY_NOTIFY: c_int = 28;

struct RootWatch {
    display: Notify,
    focus: Notify,
    work_area: c_ulong,
    focus_atoms: [c_ulong; 4],
}

unsafe extern "C" fn root_filter(xevent: *mut gdk::ffi::GdkXEvent, _event: *mut gdk::ffi::GdkEvent, data: *mut c_void) -> gdk::ffi::GdkFilterReturn {
    if xevent.is_null() || data.is_null() {
        return gdk::ffi::GDK_FILTER_CONTINUE;
    }
    let ev = &*(xevent as *const XPropertyEvent);
    if ev.type_ == X_PROPERTY_NOTIFY {
        let rw = &*(data as *const RootWatch);
        if ev.atom == rw.work_area {
            (rw.display)();
        } else if rw.focus_atoms.contains(&ev.atom) {
            (rw.focus)();
        }
    }
    gdk::ffi::GDK_FILTER_CONTINUE
}

/// Main thread, once. Fire `display` on monitor, size or work-area changes and `focus` when the
/// active window, the current desktop or the client list changes.
pub fn watch(_app: &AppHandle, _strip: &WebviewWindow, display: Notify, focus: Notify) {
    if !is_x11() {
        return;
    }
    let Some(screen) = gdk::Screen::default() else { return };
    let d1 = display.clone();
    screen.connect_monitors_changed(move |_| d1());
    let d2 = display.clone();
    screen.connect_size_changed(move |_| d2());
    let Some(root) = screen.root_window() else { return };
    let disp = root.display();
    let rw = Box::new(RootWatch {
        display,
        focus,
        work_area: xatom(&disp, "_NET_WORKAREA"),
        focus_atoms: [
            xatom(&disp, "_NET_ACTIVE_WINDOW"),
            xatom(&disp, "_NET_CURRENT_DESKTOP"),
            xatom(&disp, "_NET_CLIENT_LIST"),
            xatom(&disp, "_NET_CLIENT_LIST_STACKING"),
        ],
    });
    root.set_events(root.events() | gdk::EventMask::PROPERTY_CHANGE_MASK);
    // The filter and its data live as long as the app: leaked on purpose (called once).
    let data = Box::into_raw(rw) as *mut c_void;
    unsafe {
        gdk::ffi::gdk_window_add_filter(root.to_glib_none().0, Some(root_filter), data);
    }
}

/// Main thread. macOS-only test oracle; the Linux tests use xdotool instead.
pub fn window_at(_x: f64, _y: f64) -> Option<isize> {
    None
}

pub fn window_number(_w: &WebviewWindow) -> Option<isize> {
    None
}
