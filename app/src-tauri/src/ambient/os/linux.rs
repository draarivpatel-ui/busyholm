//! Linux idle sources. No new crate dependencies: libX11 and libXss are opened at run time with
//! `dlopen` (absent on a machine without them: no idle source, ambient stays manual).
//!
//! - X11 session: `XScreenSaverQueryInfo(...).idle` in milliseconds [SPEC S58].
//! - GNOME (X11 or Wayland): `org.gnome.Mutter.IdleMonitor.GetIdletime` through `gdbus`, if the
//!   session allows a third-party caller (SPEC lists this as unverified [S51]; the result is cached
//!   as "unavailable" after the first failure, so a refusal costs one process once).
//! - Other Wayland compositors (`ext-idle-notify-v1` on KDE, Sway, Hyprland, COSMIC, niri): NOT
//!   implemented (needs the Wayland client protocol crates); ambient is manual there.
//! Call or video and battery saver are not exposed on Linux without more dependencies: `None`.
use std::ffi::{c_char, c_int, c_ulong, c_void, CString};
use std::sync::atomic::{AtomicBool, Ordering::SeqCst};
use std::sync::Mutex;

extern "C" {
    fn dlopen(file: *const c_char, flags: c_int) -> *mut c_void;
    fn dlsym(handle: *mut c_void, name: *const c_char) -> *mut c_void;
}
const RTLD_NOW: c_int = 2;

struct Xss {
    dpy: *mut c_void,
    root: c_ulong,
    info: *mut u8,
    query: unsafe extern "C" fn(*mut c_void, c_ulong, *mut u8) -> c_int,
}
// SAFETY: only used behind the `X` mutex.
unsafe impl Send for Xss {}

static X: Mutex<Option<Option<Xss>>> = Mutex::new(None);
static MUTTER_FAILED: AtomicBool = AtomicBool::new(false);

unsafe fn sym<T>(h: *mut c_void, name: &str) -> Option<T> {
    let c = CString::new(name).ok()?;
    let p = dlsym(h, c.as_ptr());
    (!p.is_null()).then(|| std::mem::transmute_copy::<*mut c_void, T>(&p))
}

unsafe fn open_xss() -> Option<Xss> {
    let x11 = dlopen(c"libX11.so.6".as_ptr(), RTLD_NOW);
    let xss = dlopen(c"libXss.so.1".as_ptr(), RTLD_NOW);
    if x11.is_null() || xss.is_null() {
        return None;
    }
    let open: unsafe extern "C" fn(*const c_char) -> *mut c_void = sym(x11, "XOpenDisplay")?;
    let default_root: unsafe extern "C" fn(*mut c_void) -> c_ulong = sym(x11, "XDefaultRootWindow")?;
    let alloc: unsafe extern "C" fn() -> *mut u8 = sym(xss, "XScreenSaverAllocInfo")?;
    let query = sym(xss, "XScreenSaverQueryInfo")?;
    let dpy = open(std::ptr::null());
    if dpy.is_null() {
        return None;
    }
    let info = alloc();
    (!info.is_null()).then(|| Xss { dpy, root: default_root(dpy), info, query })
}

fn x11_idle() -> Option<f64> {
    let mut g = X.lock().ok()?;
    let x = g.get_or_insert_with(|| unsafe { open_xss() }).as_ref()?;
    // SAFETY: `info` is an XScreenSaverInfo from XScreenSaverAllocInfo: { Window window; int state;
    // int kind; unsigned long til_or_since; unsigned long idle; unsigned long eventMask; } so `idle`
    // sits at byte 24 on LP64.
    unsafe {
        if (x.query)(x.dpy, x.root, x.info) == 0 {
            return None;
        }
        let ms = std::ptr::read_unaligned(x.info.add(24) as *const c_ulong);
        Some(ms as f64 / 1000.0)
    }
}

fn mutter_idle() -> Option<f64> {
    if MUTTER_FAILED.load(SeqCst) {
        return None;
    }
    let out = std::process::Command::new("gdbus")
        .args(["call", "--session", "--timeout", "2", "--dest", "org.gnome.Mutter.IdleMonitor", "--object-path", "/org/gnome/Mutter/IdleMonitor/Core", "--method", "org.gnome.Mutter.IdleMonitor.GetIdletime"])
        .output();
    let ms = out.ok().filter(|o| o.status.success()).and_then(|o| parse_gdbus_uint(&String::from_utf8_lossy(&o.stdout)));
    if ms.is_none() {
        MUTTER_FAILED.store(true, SeqCst);
    }
    ms.map(|ms| ms as f64 / 1000.0)
}

/// `(uint64 12345,)` or `(12345,)` to 12345 (the last run of digits: "uint64" has digits of its own).
pub fn parse_gdbus_uint(s: &str) -> Option<u64> {
    s.split(|c: char| !c.is_ascii_digit()).filter(|r| !r.is_empty()).last()?.parse().ok()
}

pub fn idle_seconds() -> Option<f64> {
    let wayland = std::env::var("XDG_SESSION_TYPE").map(|v| v == "wayland").unwrap_or(false);
    if !wayland {
        if let Some(s) = x11_idle() {
            return Some(s);
        }
    }
    mutter_idle()
}

pub fn media_or_call_active() -> Option<bool> {
    None
}

pub fn battery_saver() -> Option<bool> {
    None
}

pub fn input_held() -> bool {
    false
}
