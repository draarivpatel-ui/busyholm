//! macOS skip probes (read-only: Busyholm never creates a power assertion).
//!
//! - Call or video: another process holds a display-sleep assertion (`PreventUserIdleDisplaySleep`
//!   or the older `NoDisplaySleepAssertion`/`PreventDisplaySleep`). Browsers, video players,
//!   FaceTime and conferencing apps take one while a video or call is on screen. `IOPMCopyAssertionsByProcess`
//!   is public and needs no permission. Apps that hold one all day (a keep-awake utility) also
//!   count, which is the safe direction: the idle trigger stays quiet and the user can still start
//!   ambient by hand.
//! - Battery saver: `NSProcessInfo.isLowPowerModeEnabled`.
use std::ffi::c_void;

use objc2::runtime::{AnyClass, AnyObject, Bool};
use objc2::msg_send;
use objc2_foundation::NSString;

#[link(name = "IOKit", kind = "framework")]
extern "C" {
    fn IOPMCopyAssertionsByProcess(out: *mut *mut c_void) -> i32;
}
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRelease(cf: *const c_void);
}

const DISPLAY_TYPES: [&str; 3] = ["PreventUserIdleDisplaySleep", "NoDisplaySleepAssertion", "PreventDisplaySleep"];

/// One display-sleep assertion held by another process (diagnostics for the test log).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Held {
    pub pid: i64,
    pub kind: String,
}

/// Display-sleep assertions held by processes other than this one; `None` when the call fails.
pub fn display_assertions() -> Option<Vec<Held>> {
    let me = std::process::id() as i64;
    let mut out: Vec<Held> = Vec::new();
    unsafe {
        let mut dict: *mut c_void = std::ptr::null_mut();
        if IOPMCopyAssertionsByProcess(&mut dict) != 0 || dict.is_null() {
            return None;
        }
        let d = dict as *mut AnyObject;
        let keys: *mut AnyObject = msg_send![&*d, allKeys];
        let n: usize = msg_send![&*keys, count];
        let type_key = NSString::from_str("AssertType");
        for i in 0..n {
            let k: *mut AnyObject = msg_send![&*keys, objectAtIndex: i];
            let pid: i64 = msg_send![&*k, longLongValue];
            if pid == me {
                continue;
            }
            let arr: *mut AnyObject = msg_send![&*d, objectForKey: &*k];
            if arr.is_null() {
                continue;
            }
            let m: usize = msg_send![&*arr, count];
            for j in 0..m {
                let a: *mut AnyObject = msg_send![&*arr, objectAtIndex: j];
                let t: *mut AnyObject = msg_send![&*a, objectForKey: &*type_key];
                if t.is_null() {
                    continue;
                }
                let s = nsstring(t);
                if DISPLAY_TYPES.contains(&s.as_str()) {
                    out.push(Held { pid, kind: s });
                }
            }
        }
        CFRelease(dict);
    }
    Some(out)
}

unsafe fn nsstring(o: *mut AnyObject) -> String {
    let utf8: *const std::ffi::c_char = msg_send![&*o, UTF8String];
    if utf8.is_null() {
        String::new()
    } else {
        std::ffi::CStr::from_ptr(utf8).to_string_lossy().into_owned()
    }
}

pub fn media_or_call_active() -> Option<bool> {
    display_assertions().map(|v| !v.is_empty())
}

pub fn battery_saver() -> Option<bool> {
    unsafe {
        let cls = AnyClass::get(c"NSProcessInfo")?;
        let pi: *mut AnyObject = msg_send![cls, processInfo];
        if pi.is_null() {
            return None;
        }
        let ok: Bool = msg_send![&*pi, respondsToSelector: objc2::sel!(isLowPowerModeEnabled)];
        if !ok.as_bool() {
            return None;
        }
        let on: Bool = msg_send![&*pi, isLowPowerModeEnabled];
        Some(on.as_bool())
    }
}

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn CGEventSourceButtonState(state_id: i32, button: u32) -> bool;
    fn CGEventSourceKeyState(state_id: i32, key: u16) -> bool;
}

/// Is any mouse button or key physically down right now? Used so a click or key that ended the
/// scene is not completed (key-up, mouse-up) on the app underneath.
pub fn input_held() -> bool {
    const HID: i32 = 1; // kCGEventSourceStateHIDSystemState
    unsafe {
        (0..3).any(|b| CGEventSourceButtonState(HID, b)) || (0u16..128).any(|k| CGEventSourceKeyState(HID, k))
    }
}

pub fn idle_seconds() -> Option<f64> {
    crate::platform::idle_seconds()
}
