//! macOS (objc2 + CoreGraphics), cleaned up from the spike's main.rs.
//!
//! - Strip: floating level 3, Spaces flags (all Spaces, stationary, not in the window cycle; the
//!   fullscreen-auxiliary flag only when the user allows the strip over fullscreen apps), shown
//!   with orderFrontRegardless so the app is never activated.
//! - Non-activating: the strip's NSWindow is turned into a non-activating NSPanel (the tauri-nspanel
//!   technique: object_setClass to an NSPanel subclass, then the NonactivatingPanel style bit) so a
//!   click on a resident never makes Busyholm the active app (SPEC 6.3 Focus, Revision 1 item 8).
//!   Guarded: done only when the panel class fits in the allocated object, and skipped when
//!   `BUSYHOLM_NO_PANEL=1`. After the swap nothing may call tao's `set_focusable` on the strip (it
//!   reads an ivar of tao's own class).
//! - Ambient: screen-saver level 1000.
//! - Fullscreen check: CGWindowListCopyWindowInfo (bounds and layers need no Screen Recording
//!   permission): another app's normal-layer window covering the whole display.
//! - Notifications, not polling: NSApplicationDidChangeScreenParametersNotification (displays,
//!   scale, Dock), NSWorkspaceActiveSpaceDidChangeNotification and
//!   NSWorkspaceDidActivateApplicationNotification (fullscreen re-check).
use std::ffi::c_void;
use std::ptr::NonNull;
use std::sync::OnceLock;

use block2::RcBlock;
use objc2::runtime::{AnyClass, AnyObject, Bool, ClassBuilder, Sel};
use objc2::{msg_send, sel};
use objc2_foundation::NSString;
use serde_json::{json, Value};
use tauri::{AppHandle, WebviewWindow};

use super::{Layer, Notify, StripSupport};
use crate::fullscreen::{mac_display_fullscreen, FRect, MacDisplay, MacWindow};
use crate::geometry::{MonitorInfo, PRect};

/// The idle trigger stays off until a per-display fullscreen check is verified here (Revision 1).
/// The check below is verified for a native fullscreen Space on one display only.
pub const IDLE_TRIGGER_VERIFIED: bool = false;

#[repr(C)]
#[derive(Clone, Copy, Debug)]
struct CGPoint {
    x: f64,
    y: f64,
}
#[repr(C)]
#[derive(Clone, Copy, Debug)]
struct CGSize {
    width: f64,
    height: f64,
}
#[repr(C)]
#[derive(Clone, Copy, Debug)]
struct CGRect {
    origin: CGPoint,
    size: CGSize,
}

unsafe impl objc2::encode::Encode for CGPoint {
    const ENCODING: objc2::encode::Encoding = objc2::encode::Encoding::Struct("CGPoint", &[f64::ENCODING, f64::ENCODING]);
}

const K_CG_NORMAL_WINDOW_LEVEL_KEY: i32 = 4;
const K_CG_FLOATING_WINDOW_LEVEL_KEY: i32 = 5;
const K_CG_SCREENSAVER_WINDOW_LEVEL_KEY: i32 = 13;
// NSWindowCollectionBehavior
const CAN_JOIN_ALL_SPACES: usize = 1 << 0;
const STATIONARY: usize = 1 << 4;
const IGNORES_CYCLE: usize = 1 << 6;
const FULLSCREEN_AUXILIARY: usize = 1 << 8;
// NSWindowStyleMask
const NONACTIVATING_PANEL: usize = 1 << 7;
// CGWindowListOption
const ON_SCREEN_ONLY: u32 = 1 << 0;
const EXCLUDE_DESKTOP: u32 = 1 << 4;

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGWindowLevelForKey(key: i32) -> i32;
    fn CGMainDisplayID() -> u32;
    fn CGDisplayBounds(display: u32) -> CGRect;
    fn CGEventSourceSecondsSinceLastEventType(state: i32, event_type: u32) -> f64;
    fn CGEventCreate(source: *const c_void) -> *const c_void;
    fn CGEventGetLocation(event: *const c_void) -> CGPoint;
    fn CGWindowListCopyWindowInfo(option: u32, relative_to: u32) -> *const c_void;
}
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRelease(p: *const c_void);
}

fn ns_window(w: &WebviewWindow) -> Result<*mut AnyObject, String> {
    w.ns_window().map(|p| p as *mut AnyObject).map_err(|e| e.to_string())
}

unsafe fn set_level(win: *mut AnyObject, level: isize, behavior: usize) {
    let w = &*win;
    let _: () = msg_send![w, setLevel: level];
    let _: () = msg_send![w, setCollectionBehavior: behavior];
}

unsafe fn describe(win: *mut AnyObject) -> Value {
    let w = &*win;
    let level: isize = msg_send![w, level];
    let number: isize = msg_send![w, windowNumber];
    let behavior: usize = msg_send![w, collectionBehavior];
    let style: usize = msg_send![w, styleMask];
    let can_key: Bool = msg_send![w, canBecomeKeyWindow];
    let panel_cls = AnyClass::get(c"NSPanel");
    let is_panel: Bool = match panel_cls {
        Some(c) => msg_send![w, isKindOfClass: c],
        None => Bool::NO,
    };
    json!({ "ns_level": level, "window_number": number, "collection_behavior": behavior, "style_mask": style,
            "panel": is_panel.as_bool(), "nonactivating": is_panel.as_bool() && style & NONACTIVATING_PANEL != 0,
            "can_become_key": can_key.as_bool() })
}

extern "C-unwind" fn no(_this: *mut AnyObject, _sel: Sel) -> Bool {
    Bool::NO
}

/// A plain NSPanel subclass whose instances never become key or main.
fn panel_class() -> Option<&'static AnyClass> {
    static CLS: OnceLock<Option<usize>> = OnceLock::new();
    let p = CLS.get_or_init(|| {
        let sup = AnyClass::get(c"NSPanel")?;
        let mut b = ClassBuilder::new(c"BusyholmStripPanel", sup)?;
        unsafe {
            b.add_method(sel!(canBecomeKeyWindow), no as extern "C-unwind" fn(*mut AnyObject, Sel) -> Bool);
            b.add_method(sel!(canBecomeMainWindow), no as extern "C-unwind" fn(*mut AnyObject, Sel) -> Bool);
        }
        Some(b.register() as *const AnyClass as usize)
    });
    p.map(|a| unsafe { &*(a as *const AnyClass) })
}

/// Turns the strip into a non-activating panel. Returns a note for the test log.
unsafe fn make_nonactivating_panel(win: *mut AnyObject) -> &'static str {
    if std::env::var_os("BUSYHOLM_NO_PANEL").map(|v| v == "1").unwrap_or(false) {
        return "disabled by BUSYHOLM_NO_PANEL";
    }
    let Some(panel) = panel_class() else { return "no NSPanel class" };
    let current = objc2::ffi::object_getClass(win as *const AnyObject);
    if current.is_null() {
        return "no class";
    }
    // Never swap to a class whose instances are larger than the object we have.
    if panel.instance_size() > (*current).instance_size() {
        return "panel larger than window object";
    }
    objc2::ffi::object_setClass(win, panel as *const AnyClass);
    let w = &*win;
    let style: usize = msg_send![w, styleMask];
    let _: () = msg_send![w, setStyleMask: style | NONACTIVATING_PANEL];
    let _: () = msg_send![w, setHidesOnDeactivate: Bool::NO];
    let _: () = msg_send![w, setBecomesKeyOnlyIfNeeded: Bool::YES];
    "converted"
}

fn activation_policy() -> isize {
    unsafe {
        let Some(cls) = AnyClass::get(c"NSApplication") else { return -1 };
        let app: *mut AnyObject = msg_send![cls, sharedApplication];
        if app.is_null() {
            return -1;
        }
        msg_send![&*app, activationPolicy]
    }
}

pub fn strip_support() -> StripSupport {
    StripSupport::Supported
}

/// macOS has no public API to reserve screen space (SPEC 6.3); reserve mode falls back to on top.
pub fn reserve_supported() -> bool {
    false
}

/// Main thread. After the strip is built (hidden), before it is first shown.
pub fn prepare_strip(w: &WebviewWindow) -> Result<Value, String> {
    let win = ns_window(w)?;
    unsafe {
        let note = make_nonactivating_panel(win);
        let mut d = describe(win);
        d["panel_conversion"] = json!(note);
        d["activation_policy"] = json!(activation_policy());
        Ok(d)
    }
}

/// Main thread.
pub fn apply_layer(w: &WebviewWindow, layer: Layer, over_fullscreen: bool) -> Result<Value, String> {
    let win = ns_window(w)?;
    let level = unsafe {
        match layer {
            Layer::OnTop => CGWindowLevelForKey(K_CG_FLOATING_WINDOW_LEVEL_KEY) as isize,
            Layer::Behind => CGWindowLevelForKey(K_CG_NORMAL_WINDOW_LEVEL_KEY) as isize - 1,
        }
    };
    let mut behavior = CAN_JOIN_ALL_SPACES | STATIONARY | IGNORES_CYCLE;
    if over_fullscreen {
        behavior |= FULLSCREEN_AUXILIARY;
    }
    unsafe {
        set_level(win, level, behavior);
        Ok(describe(win))
    }
}

pub fn reserve_space(_w: &WebviewWindow, _rect: Option<PRect>, _m: &MonitorInfo) -> Result<Option<PRect>, String> {
    Err("unsupported".into())
}

/// Main thread. Order the strip in without activating Busyholm.
pub fn show_inactive(w: &WebviewWindow) -> Result<(), String> {
    let win = ns_window(w)?;
    unsafe {
        let _: () = msg_send![&*win, orderFrontRegardless];
    }
    Ok(())
}

/// The app that was frontmost before ambient mode, retained (0 when none), so activation can be
/// handed back when ambient closes.
static PREV_FRONT: std::sync::Mutex<usize> = std::sync::Mutex::new(0);

/// Main thread. Screen-saver level (1000) on every Space, including fullscreen Spaces. Called
/// before the ambient window takes focus, so it also remembers the frontmost app.
pub fn prepare_ambient(w: &WebviewWindow) -> Result<Value, String> {
    let win = ns_window(w)?;
    unsafe {
        if let Some(ws) = AnyClass::get(c"NSWorkspace") {
            let shared: *mut AnyObject = msg_send![ws, sharedWorkspace];
            if !shared.is_null() {
                let front: *mut AnyObject = msg_send![&*shared, frontmostApplication];
                if !front.is_null() {
                    let pid: i32 = msg_send![&*front, processIdentifier];
                    if pid != std::process::id() as i32 {
                        let _: *mut AnyObject = msg_send![&*front, retain];
                        let mut g = PREV_FRONT.lock().unwrap();
                        if *g != 0 {
                            let _: () = msg_send![&*(*g as *mut AnyObject), release];
                        }
                        *g = front as usize;
                    }
                }
            }
        }
        let level = CGWindowLevelForKey(K_CG_SCREENSAVER_WINDOW_LEVEL_KEY) as isize;
        set_level(win, level, CAN_JOIN_ALL_SPACES | FULLSCREEN_AUXILIARY | STATIONARY);
        Ok(describe(win))
    }
}

/// Main thread. The ambient window activated Busyholm to receive keys; hand activation back to
/// the app that was frontmost before (macOS 14+ cooperative activation: yield, then activate it).
pub fn after_ambient(_app: &AppHandle) {
    unsafe {
        let prev = std::mem::take(&mut *PREV_FRONT.lock().unwrap()) as *mut AnyObject;
        let Some(cls) = AnyClass::get(c"NSApplication") else { return };
        let app: *mut AnyObject = msg_send![cls, sharedApplication];
        if app.is_null() {
            return;
        }
        if !prev.is_null() {
            let can_yield: Bool = msg_send![&*app, respondsToSelector: sel!(yieldActivationToApplication:)];
            if can_yield.as_bool() {
                let _: () = msg_send![&*app, yieldActivationToApplication: &*prev];
            }
            let _: Bool = msg_send![&*prev, activateWithOptions: 0usize];
            let _: () = msg_send![&*prev, release];
        } else {
            let active: Bool = msg_send![&*app, isActive];
            if active.as_bool() {
                let _: () = msg_send![&*app, deactivate];
            }
        }
    }
}

/// Any thread. The cursor in points (top-left origin of the main display) times the strip
/// monitor's scale, which is how tao reports that monitor's "physical" rectangles.
pub fn cursor(_app: &AppHandle, strip_scale: f64) -> Option<(f64, f64)> {
    unsafe {
        let ev = CGEventCreate(std::ptr::null());
        if ev.is_null() {
            return None;
        }
        let p = CGEventGetLocation(ev);
        CFRelease(ev);
        Some((p.x * strip_scale, p.y * strip_scale))
    }
}

/// Any thread. Seconds since the last input in this login session (no permission needed).
pub fn idle_seconds() -> Option<f64> {
    Some(unsafe { CGEventSourceSecondsSinceLastEventType(0, u32::MAX) })
}

unsafe fn dict_get(d: *mut AnyObject, key: &str) -> *mut AnyObject {
    let k = NSString::from_str(key);
    msg_send![&*d, objectForKey: &*k]
}
unsafe fn num_f64(n: *mut AnyObject) -> Option<f64> {
    if n.is_null() {
        return None;
    }
    let v: f64 = msg_send![&*n, doubleValue];
    Some(v)
}

/// Any thread. True when another app's normal-layer window covers the display (a native
/// fullscreen Space, a borderless fullscreen game, a presentation). Uses only bounds, layers and
/// owner pids, which need no Screen Recording permission. The decision is `crate::fullscreen`
/// (per display; a window that merely equals the work area is ambiguous and is settled by whether the
/// Dock's layer-20 window is still on screen).
pub fn other_app_fullscreen(m: &MonitorInfo) -> Option<bool> {
    let s = m.scale;
    let pts = |r: &PRect| FRect { x: r.x as f64 / s, y: r.y as f64 / s, w: r.w as f64 / s, h: r.h as f64 / s };
    let display = MacDisplay { bounds: pts(&m.bounds), work: pts(&m.work) };
    unsafe {
        let arr = CGWindowListCopyWindowInfo(ON_SCREEN_ONLY | EXCLUDE_DESKTOP, 0) as *mut AnyObject;
        if arr.is_null() {
            return None;
        }
        let n: usize = msg_send![&*arr, count];
        let mut windows = Vec::with_capacity(n);
        let mut dock_window_present = false;
        for i in 0..n {
            let d: *mut AnyObject = msg_send![&*arr, objectAtIndex: i];
            if d.is_null() {
                continue;
            }
            let layer = num_f64(dict_get(d, "kCGWindowLayer")).unwrap_or(-1.0);
            if layer == 20.0 {
                dock_window_present = true;
            }
            let pid = num_f64(dict_get(d, "kCGWindowOwnerPID")).unwrap_or(-1.0);
            let alpha = num_f64(dict_get(d, "kCGWindowAlpha")).unwrap_or(1.0);
            let b = dict_get(d, "kCGWindowBounds");
            if b.is_null() {
                continue;
            }
            let rect = FRect {
                x: num_f64(dict_get(b, "X")).unwrap_or(0.0),
                y: num_f64(dict_get(b, "Y")).unwrap_or(0.0),
                w: num_f64(dict_get(b, "Width")).unwrap_or(0.0),
                h: num_f64(dict_get(b, "Height")).unwrap_or(0.0),
            };
            windows.push(MacWindow { rect, layer: layer as i32, pid: pid as u32, alpha });
        }
        CFRelease(arr as *const c_void);
        Some(mac_display_fullscreen(&display, &windows, std::process::id(), dock_window_present))
    }
}

fn observe(center: *mut AnyObject, name: &str, f: Notify) {
    unsafe {
        let n = NSString::from_str(name);
        let block = RcBlock::new(move |_note: NonNull<AnyObject>| f());
        let nil: *const AnyObject = std::ptr::null();
        let token: *mut AnyObject = msg_send![&*center, addObserverForName: &*n, object: nil, queue: nil, usingBlock: &*block];
        // Observers live as long as the app: keep the token and the block alive on purpose.
        if !token.is_null() {
            let _: *mut AnyObject = msg_send![&*token, retain];
        }
        std::mem::forget(block);
    }
}

/// Main thread, once.
pub fn watch(_app: &AppHandle, _strip: &WebviewWindow, display: Notify, focus: Notify) {
    unsafe {
        if let Some(nc) = AnyClass::get(c"NSNotificationCenter") {
            let center: *mut AnyObject = msg_send![nc, defaultCenter];
            if !center.is_null() {
                observe(center, "NSApplicationDidChangeScreenParametersNotification", display);
            }
        }
        if let Some(ws) = AnyClass::get(c"NSWorkspace") {
            let shared: *mut AnyObject = msg_send![ws, sharedWorkspace];
            if !shared.is_null() {
                let center: *mut AnyObject = msg_send![&*shared, notificationCenter];
                if !center.is_null() {
                    observe(center, "NSWorkspaceActiveSpaceDidChangeNotification", focus.clone());
                    observe(center, "NSWorkspaceDidActivateApplicationNotification", focus);
                }
            }
        }
    }
}

/// Main thread. Test oracle: the window number the window server would give a mouse-down at this
/// point (points, top-left origin of the main display).
pub fn window_at(x: f64, y: f64) -> Option<isize> {
    unsafe {
        let h = CGDisplayBounds(CGMainDisplayID()).size.height;
        let cls = AnyClass::get(c"NSWindow")?;
        let n: isize = msg_send![cls, windowNumberAtPoint: CGPoint { x, y: h - y }, belowWindowWithWindowNumber: 0isize];
        Some(n)
    }
}

pub fn window_number(w: &WebviewWindow) -> Option<isize> {
    let win = ns_window(w).ok()?;
    unsafe { Some(msg_send![&*win, windowNumber]) }
}
