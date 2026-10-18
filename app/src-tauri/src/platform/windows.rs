//! Windows (windows-rs). Written on macOS and compile-checked only (`cargo xwin check`); the
//! acceptance script `app/tests/windows/acceptance.ps1` is what proves it on a real desktop.
//!
//! - Strip: topmost, never activating, kept out of Alt+Tab with `WS_EX_TOOLWINDOW`, on top of the
//!   `WS_EX_NOACTIVATE` that Tauri sets for `focusable(false)`.
//! - tao rewrites the whole extended style (`SetWindowLongW(GWL_EXSTYLE, ...)`) from its own flag
//!   set whenever any flag changes (for example every click-through toggle), which would silently
//!   drop `WS_EX_TOOLWINDOW`. So the strip HWND is subclassed (comctl32 `SetWindowSubclass`) and
//!   `WM_STYLECHANGING` puts `TOOLWINDOW | NOACTIVATE` back before the change lands. The same
//!   subclass adds `SWP_NOACTIVATE` to every `WM_WINDOWPOSCHANGING` (so `ShowWindow(SW_SHOW)` from
//!   tao cannot activate the strip; tao's `focused(false)` handling is not reliable on its own),
//!   answers `WM_MOUSEACTIVATE` with `MA_NOACTIVATE`, and receives the display-change messages.
//! - Reserve space: a real AppBar (`SHAppBarMessage`, SPEC 6.3 [S43]) on the bottom edge.
//! - Fullscreen check: `SHQueryUserNotificationState` plus a foreground-window-covers-the-monitor
//!   test. Notifications, not polling: `WM_DISPLAYCHANGE`, `WM_DPICHANGED`, `WM_SETTINGCHANGE`
//!   (`SPI_SETWORKAREA`), the AppBar callback message and a foreground-change WinEvent hook.
//! - The process is per-monitor DPI aware v2 (tao's manifest), so every coordinate here is physical
//!   pixels in the global desktop space, the same space as Tauri's `Monitor` rectangles.
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, MutexGuard, Once};

use serde_json::{json, Value};
use tauri::{AppHandle, WebviewWindow};
use std::ffi::c_void;

use windows::core::BOOL;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST};
use windows::Win32::System::SystemInformation::GetTickCount;
use windows::Win32::UI::Accessibility::{SetWinEventHook, HWINEVENTHOOK};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
use windows::Win32::UI::Shell::{
    DefSubclassProc, RemoveWindowSubclass, SHAppBarMessage, SHQueryUserNotificationState, SetWindowSubclass, ABE_BOTTOM,
    ABM_ACTIVATE, ABM_NEW, ABM_QUERYPOS, ABM_REMOVE, ABM_SETPOS, ABM_WINDOWPOSCHANGED, ABN_FULLSCREENAPP, ABN_POSCHANGED,
    ABN_STATECHANGE, ABN_WINDOWARRANGE, APPBARDATA, QUNS_BUSY, QUNS_PRESENTATION_MODE, QUNS_RUNNING_D3D_FULL_SCREEN,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetClassNameW, GetCursorPos, GetForegroundWindow, GetWindowLongPtrW, GetWindowRect, GetWindowThreadProcessId, IsIconic, IsWindowVisible,
    SetWindowLongPtrW, SetWindowPos, ShowWindow, GWL_EXSTYLE, HWND_BOTTOM, HWND_TOPMOST, MA_NOACTIVATE, SPI_SETWORKAREA,
    STYLESTRUCT, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SW_SHOWNOACTIVATE, WINDOWPOS,
    WINEVENT_OUTOFCONTEXT, WINEVENT_SKIPOWNPROCESS, WM_ACTIVATE, WM_APP, WM_DISPLAYCHANGE, WM_DPICHANGED, WM_MOUSEACTIVATE,
    WM_NCDESTROY, WM_SETTINGCHANGE, WM_STYLECHANGING, WM_WINDOWPOSCHANGED, WM_WINDOWPOSCHANGING, WS_EX_APPWINDOW,
    WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_EX_TRANSPARENT,
};

use super::{Layer, Notify, StripSupport};
use crate::fullscreen::{windows_display_fullscreen, IRect, Notification, WinWindow};
use crate::geometry::{MonitorInfo, PRect};

/// The idle trigger stays off until a per-display fullscreen check is verified here (Revision 1).
/// The check below is written from the documentation and has not run on a real Windows desktop.
pub const IDLE_TRIGGER_VERIFIED: bool = false;

/// Private AppBar callback message (`WM_APP + 0x42`), sent to the strip HWND by the shell.
const APPBAR_CALLBACK: u32 = WM_APP + 0x42;
/// Subclass id of the strip subclass (must differ from tao's own id).
const SUBCLASS_ID: usize = 0x4255_5359;
/// Event id of `EVENT_SYSTEM_FOREGROUND`.
const EVENT_SYSTEM_FOREGROUND: u32 = 0x0003;

/// HWNDs (as integers) that are registered as an AppBar.
static APPBARS: Mutex<Vec<isize>> = Mutex::new(Vec::new());
/// Callbacks from `watch`. Cheap closures: the glue debounces and does its work on its own threads.
static DISPLAY: Mutex<Option<Notify>> = Mutex::new(None);
static FOCUS: Mutex<Option<Notify>> = Mutex::new(None);
/// How many times the foreground hook has fired (kept for the test log and cheap diagnostics).
static FOREGROUND_EVENTS: AtomicUsize = AtomicUsize::new(0);
static HOOK_ONCE: Once = Once::new();

/// A poisoned lock must never take the shell down: take the data anyway.
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

fn hwnd_of(w: &WebviewWindow) -> Result<HWND, String> {
    w.hwnd().map_err(|e| e.to_string())
}

fn is_registered(h: HWND) -> bool {
    lock(&APPBARS).contains(&(h.0 as isize))
}

/// Runs a stored callback without holding the lock and without letting a panic cross the FFI edge.
fn fire(slot: &Mutex<Option<Notify>>) {
    let cb = lock(slot).clone();
    if let Some(cb) = cb {
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| cb()));
    }
}

fn appbar_data(h: HWND) -> APPBARDATA {
    APPBARDATA {
        cbSize: std::mem::size_of::<APPBARDATA>() as u32,
        hWnd: h,
        uCallbackMessage: APPBAR_CALLBACK,
        uEdge: ABE_BOTTOM,
        rc: RECT::default(),
        lParam: LPARAM(0),
    }
}

/// The strip's window procedure layer (comctl32 subclass). Runs on the thread that owns the HWND.
unsafe extern "system" fn strip_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM, _id: usize, _data: usize) -> LRESULT {
    match msg {
        WM_DISPLAYCHANGE | WM_DPICHANGED => fire(&DISPLAY),
        WM_SETTINGCHANGE if wparam.0 as u32 == SPI_SETWORKAREA.0 => fire(&DISPLAY),
        APPBAR_CALLBACK => {
            match wparam.0 as u32 {
                ABN_POSCHANGED | ABN_STATECHANGE | ABN_WINDOWARRANGE => fire(&DISPLAY),
                ABN_FULLSCREENAPP => fire(&FOCUS),
                _ => {}
            }
            return LRESULT(0);
        }
        // tao rewrites the extended style from its own flags; keep the two bits we depend on.
        WM_STYLECHANGING if (wparam.0 as i32) == GWL_EXSTYLE.0 && lparam.0 != 0 => {
            // SAFETY: for WM_STYLECHANGING lParam points to a live STYLESTRUCT owned by the system for this call.
            let ss = unsafe { &mut *(lparam.0 as *mut STYLESTRUCT) };
            ss.styleNew |= WS_EX_TOOLWINDOW.0 | WS_EX_NOACTIVATE.0;
        }
        // Nothing the strip does may activate it.
        WM_WINDOWPOSCHANGING if lparam.0 != 0 => {
            // SAFETY: for WM_WINDOWPOSCHANGING lParam points to a live WINDOWPOS owned by the system for this call.
            let wp = unsafe { &mut *(lparam.0 as *mut WINDOWPOS) };
            wp.flags |= SWP_NOACTIVATE;
        }
        WM_MOUSEACTIVATE => return LRESULT(MA_NOACTIVATE as isize),
        // AppBar housekeeping the shell expects from a registered appbar.
        WM_ACTIVATE if is_registered(hwnd) => {
            let mut d = appbar_data(hwnd);
            // SAFETY: `d` is a fully initialised APPBARDATA that lives for the call.
            unsafe { SHAppBarMessage(ABM_ACTIVATE, &mut d) };
        }
        WM_WINDOWPOSCHANGED if is_registered(hwnd) => {
            let mut d = appbar_data(hwnd);
            // SAFETY: `d` is a fully initialised APPBARDATA that lives for the call.
            unsafe { SHAppBarMessage(ABM_WINDOWPOSCHANGED, &mut d) };
        }
        WM_NCDESTROY => {
            lock(&APPBARS).retain(|h| *h != hwnd.0 as isize);
            // SAFETY: removing our own subclass from the window being destroyed, on its own thread.
            unsafe {
                let _ = RemoveWindowSubclass(hwnd, Some(strip_proc), SUBCLASS_ID);
            }
        }
        _ => {}
    }
    // SAFETY: forwards the untouched message to the next procedure in the subclass chain.
    unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
}

/// Idempotent: installing the same procedure and id again just updates it.
fn install_subclass(h: HWND) -> Result<(), String> {
    // SAFETY: `h` is the strip's HWND, we are on its owning (main) thread, and `strip_proc` has the SUBCLASSPROC signature.
    let ok = unsafe { SetWindowSubclass(h, Some(strip_proc), SUBCLASS_ID, 0) };
    if ok.as_bool() {
        Ok(())
    } else {
        Err("SetWindowSubclass failed".into())
    }
}

fn ex_style(h: HWND) -> u32 {
    // SAFETY: reading a window long of a window handle is sound for any HWND value (a bad one returns 0).
    unsafe { GetWindowLongPtrW(h, GWL_EXSTYLE) as u32 }
}

fn describe(h: HWND) -> Value {
    let ex = ex_style(h);
    let has = |f: u32| ex & f != 0;
    json!({ "noactivate": has(WS_EX_NOACTIVATE.0), "toolwindow": has(WS_EX_TOOLWINDOW.0), "topmost": has(WS_EX_TOPMOST.0),
            "layered": has(WS_EX_LAYERED.0), "transparent": has(WS_EX_TRANSPARENT.0), "ex_style": format!("0x{ex:08x}"),
            "hwnd": h.0 as isize })
}

pub fn strip_support() -> StripSupport {
    StripSupport::Supported
}

/// Windows has an AppBar API (SPEC 6.3).
pub fn reserve_supported() -> bool {
    true
}

/// Main thread. After the strip is built (hidden), before it is first shown.
pub fn prepare_strip(w: &WebviewWindow) -> Result<Value, String> {
    let h = hwnd_of(w)?;
    install_subclass(h)?;
    let ex = ex_style(h);
    let want = (ex | WS_EX_TOOLWINDOW.0 | WS_EX_NOACTIVATE.0) & !WS_EX_APPWINDOW.0;
    if want != ex {
        // SAFETY: changing the extended style of our own, still hidden window on its owning thread; the
        // follow-up SetWindowPos only makes the system re-read the frame and changes no position, size, z-order or activation.
        unsafe {
            SetWindowLongPtrW(h, GWL_EXSTYLE, want as isize);
            let _ = SetWindowPos(h, None, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
        }
    }
    Ok(describe(h))
}

/// Main thread. `over_fullscreen` has no Windows meaning beyond the hide logic in the shell.
pub fn apply_layer(w: &WebviewWindow, layer: Layer, _over_fullscreen: bool) -> Result<Value, String> {
    let h = hwnd_of(w)?;
    // Keep tao's own flag state truthful first: a later tao style rewrite must not undo our choice.
    let tao = match layer {
        Layer::OnTop => w.set_always_on_bottom(false).and_then(|_| w.set_always_on_top(true)),
        Layer::Behind => w.set_always_on_top(false).and_then(|_| w.set_always_on_bottom(true)),
    };
    tao.map_err(|e| e.to_string())?;
    let after = match layer {
        Layer::OnTop => HWND_TOPMOST,
        Layer::Behind => HWND_BOTTOM,
    };
    // SAFETY: repositions our own window in the z-order only (no move, size or activation), on its owning thread.
    unsafe { SetWindowPos(h, Some(after), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE) }.map_err(|e| e.to_string())?;
    let mut d = describe(h);
    d["layer"] = json!(match layer {
        Layer::OnTop => "on_top",
        Layer::Behind => "behind",
    });
    Ok(d)
}

/// Main thread. Some(rect): reserve that strip of the screen as an AppBar on the bottom edge of the
/// monitor and return the rect the system granted (above the taskbar). None: release it (idempotent).
pub fn reserve_space(w: &WebviewWindow, rect: Option<PRect>, m: &MonitorInfo) -> Result<Option<PRect>, String> {
    let h = hwnd_of(w)?;
    let key = h.0 as isize;
    let Some(rect) = rect else {
        let was = {
            let mut g = lock(&APPBARS);
            let had = g.contains(&key);
            g.retain(|k| *k != key);
            had
        };
        if was {
            let mut d = appbar_data(h);
            // SAFETY: `d` is a fully initialised APPBARDATA that lives for the call.
            unsafe { SHAppBarMessage(ABM_REMOVE, &mut d) };
        }
        return Ok(None);
    };
    if !is_registered(h) {
        let mut d = appbar_data(h);
        // SAFETY: `d` is a fully initialised APPBARDATA that lives for the call.
        let ok = unsafe { SHAppBarMessage(ABM_NEW, &mut d) };
        if ok == 0 {
            return Err("ABM_NEW failed".into());
        }
        lock(&APPBARS).push(key);
    }
    let b = m.bounds;
    let height = rect.h as i32;
    let mut d = appbar_data(h);
    d.rc = RECT { left: b.x, top: b.bottom() - height, right: b.right(), bottom: b.bottom() };
    // SAFETY: `d` is a fully initialised APPBARDATA that lives for these calls.
    unsafe {
        // Let the system move the rectangle clear of the taskbar and other appbars, then keep our height.
        SHAppBarMessage(ABM_QUERYPOS, &mut d);
        d.rc.top = d.rc.bottom - height;
        SHAppBarMessage(ABM_SETPOS, &mut d);
    }
    let (l, t, r, bt) = (d.rc.left, d.rc.top, d.rc.right, d.rc.bottom);
    if r <= l || bt <= t {
        return Err(format!("AppBar granted an empty rectangle ({l},{t},{r},{bt})"));
    }
    Ok(Some(PRect { x: l, y: t, w: (r - l) as u32, h: (bt - t) as u32 }))
}

/// Main thread. Show without activating the app or taking focus.
pub fn show_inactive(w: &WebviewWindow) -> Result<(), String> {
    let h = hwnd_of(w)?;
    // tao first, so its own visible flag matches (otherwise its next style rewrite would hide the window
    // again); the subclass keeps that show from activating. Then the explicit no-activate show.
    w.show().map_err(|e| e.to_string())?;
    // SAFETY: shows our own window without activating it, on its owning thread.
    unsafe {
        let _ = ShowWindow(h, SW_SHOWNOACTIVATE);
    }
    Ok(())
}

/// Main thread. Topmost; the window is already borderless and sized to the monitor by the shell.
pub fn prepare_ambient(w: &WebviewWindow) -> Result<Value, String> {
    let h = hwnd_of(w)?;
    // SAFETY: z-order change of our own window only (no move, size or activation; the shell calls set_focus itself).
    unsafe { SetWindowPos(h, Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE) }.map_err(|e| e.to_string())?;
    Ok(describe(h))
}

/// Main thread. Nothing to hand back on Windows: there is no app-level activation state (macOS needs
/// `deactivate`). When the ambient window is destroyed, Windows gives the foreground to the next window
/// in z-order, which is the app the user was in.
pub fn after_ambient(_app: &AppHandle) {}

/// Any thread. Global cursor in physical pixels (the process is per-monitor DPI aware v2), the same
/// space as Tauri's monitor rectangles, so `strip_scale` is not needed.
pub fn cursor(_app: &AppHandle, _strip_scale: f64) -> Option<(f64, f64)> {
    let mut p = POINT::default();
    // SAFETY: `p` is a valid out-pointer for the duration of the call.
    unsafe { GetCursorPos(&mut p) }.ok()?;
    Some((p.x as f64, p.y as f64))
}

/// Any thread. Seconds since the last input in this session (`GetLastInputInfo`, SPEC 6.4 [S44]).
pub fn idle_seconds() -> Option<f64> {
    let mut li = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
    // SAFETY: `li` is initialised with its size and is a valid out-pointer for the call.
    unsafe {
        if GetLastInputInfo(&mut li).as_bool() {
            // Both values are 32-bit tick counts that wrap together.
            Some(GetTickCount().wrapping_sub(li.dwTime) as f64 / 1000.0)
        } else {
            None
        }
    }
}

fn class_name(h: HWND) -> String {
    let mut buf = [0u16; 128];
    // SAFETY: `buf` is a valid writable slice; the call reports how many UTF-16 units it wrote.
    let n = unsafe { GetClassNameW(h, &mut buf) };
    String::from_utf16_lossy(&buf[..n.max(0) as usize])
}

/// `EnumWindows` callback: appends every visible top-level window (with the facts `crate::fullscreen` needs).
unsafe extern "system" fn collect_window(hwnd: HWND, lparam: LPARAM) -> BOOL {
    // SAFETY: `lparam` is the `&mut Vec<WinWindow>` that `top_level_windows` passed, alive for the whole call.
    let out = unsafe { &mut *(lparam.0 as *mut Vec<WinWindow>) };
    // SAFETY: plain queries on a window handle the system just handed us.
    unsafe {
        if !IsWindowVisible(hwnd).as_bool() {
            return BOOL::from(true);
        }
        let mut r = RECT::default();
        if GetWindowRect(hwnd, &mut r).is_err() {
            return BOOL::from(true);
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        let mut cloaked = 0u32;
        let got = DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &mut cloaked as *mut u32 as *mut c_void, std::mem::size_of::<u32>() as u32);
        out.push(WinWindow {
            rect: IRect { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top },
            class: class_name(hwnd),
            pid,
            visible: true,
            minimized: IsIconic(hwnd).as_bool(),
            cloaked: got.is_ok() && cloaked != 0,
        });
    }
    BOOL::from(true)
}

/// Every visible top-level window, any monitor.
fn top_level_windows() -> Vec<WinWindow> {
    let mut out: Vec<WinWindow> = Vec::new();
    // SAFETY: the callback only runs during this call and `out` outlives it.
    let _ = unsafe { EnumWindows(Some(collect_window), LPARAM(&mut out as *mut Vec<WinWindow> as isize)) };
    out
}

/// The monitor holding the foreground window, when there is one.
fn foreground_monitor() -> Option<IRect> {
    // SAFETY: GetForegroundWindow has no preconditions; a null result means no foreground window.
    let fg = unsafe { GetForegroundWindow() };
    if fg.0.is_null() {
        return None;
    }
    // SAFETY: `fg` is a window handle; the nearest monitor always exists.
    let mon = unsafe { MonitorFromWindow(fg, MONITOR_DEFAULTTONEAREST) };
    let mut mi = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
    // SAFETY: `mi` is initialised with its size and is a valid out-pointer.
    if unsafe { GetMonitorInfoW(mon, &mut mi) }.as_bool() {
        let r = mi.rcMonitor;
        Some(IRect { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top })
    } else {
        None
    }
}

/// Any thread. True when another app is fullscreen on THIS monitor: a visible, uncloaked window of another
/// process that exactly covers it (foreground or not), or the shell's busy / Direct3D fullscreen /
/// presentation state while the foreground window is on this monitor (the state is global, so it says
/// nothing about other monitors). The rules are `crate::fullscreen::windows_display_fullscreen`.
pub fn other_app_fullscreen(m: &MonitorInfo) -> Option<bool> {
    // SAFETY: SHQueryUserNotificationState has no preconditions; it reports through its return value.
    let busy = unsafe { SHQueryUserNotificationState() }
        .map(|s| s == QUNS_BUSY || s == QUNS_RUNNING_D3D_FULL_SCREEN || s == QUNS_PRESENTATION_MODE)
        .unwrap_or(false);
    let n = Notification { busy, foreground_monitor: foreground_monitor() };
    let b = m.bounds;
    let monitor = IRect { x: b.x, y: b.y, w: b.w as i32, h: b.h as i32 };
    Some(windows_display_fullscreen(monitor, &n, &top_level_windows(), std::process::id()))
}

/// Called by Windows (out of context, on the thread that installed the hook) when the foreground window changes.
unsafe extern "system" fn on_foreground(_hook: HWINEVENTHOOK, _event: u32, _hwnd: HWND, _object: i32, _child: i32, _thread: u32, _time: u32) {
    FOREGROUND_EVENTS.fetch_add(1, Ordering::Relaxed);
    fire(&FOCUS);
}

/// Main thread, once. Fire `display` on display, scale, taskbar or work-area changes and `focus`
/// when the foreground app may have changed (so fullscreen is re-checked).
pub fn watch(_app: &AppHandle, strip: &WebviewWindow, display: Notify, focus: Notify) {
    *lock(&DISPLAY) = Some(display);
    *lock(&FOCUS) = Some(focus);
    if let Ok(h) = strip.hwnd() {
        let _ = install_subclass(h);
    }
    HOOK_ONCE.call_once(|| {
        // SAFETY: out-of-context hook with a valid callback; this is the main thread, which runs the
        // message loop that delivers the events. The hook lives as long as the process (never unhooked).
        let hook = unsafe {
            SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, None, Some(on_foreground), 0, 0, WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS)
        };
        if hook.is_invalid() {
            crate::testlog::log("watch_error", json!({ "error": "SetWinEventHook failed" }));
        }
    });
}

/// The macOS-only test oracle has no Windows counterpart (the Windows tests click for real).
pub fn window_at(_x: f64, _y: f64) -> Option<isize> {
    None
}
pub fn window_number(_w: &WebviewWindow) -> Option<isize> {
    None
}
