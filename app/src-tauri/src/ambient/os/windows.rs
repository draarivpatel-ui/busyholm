//! Windows skip probes and helpers. Declared by hand (no extra `windows` crate features), all
//! read-only: Busyholm never calls SetThreadExecutionState or PowerCreateRequest.
//!
//! Written from the documentation and compile-checked with `cargo xwin check`; not yet run on a
//! real Windows desktop (see app/README.md).
//! - Call or video: `CallNtPowerInformation(SystemExecutionState)` returns the OR of every thread's
//!   execution state; `ES_DISPLAY_REQUIRED` is set while a video or call keeps the display on.
//!   Busyholm sets none, so any display request is another app's.
//! - Battery saver: `SYSTEM_POWER_STATUS.SystemStatusFlag == 1`.
use std::ffi::c_void;

#[link(name = "powrprof")]
extern "system" {
    fn CallNtPowerInformation(level: i32, input: *const c_void, input_len: u32, output: *mut c_void, output_len: u32) -> i32;
}
#[link(name = "kernel32")]
extern "system" {
    fn GetSystemPowerStatus(status: *mut SystemPowerStatus) -> i32;
}
#[link(name = "user32")]
extern "system" {
    fn GetAsyncKeyState(vk: i32) -> i16;
}

#[repr(C)]
#[derive(Default)]
struct SystemPowerStatus {
    ac_line_status: u8,
    battery_flag: u8,
    battery_life_percent: u8,
    system_status_flag: u8,
    battery_life_time: u32,
    battery_full_life_time: u32,
}

const SYSTEM_EXECUTION_STATE: i32 = 16;
const ES_DISPLAY_REQUIRED: u32 = 0x0000_0002;

pub fn media_or_call_active() -> Option<bool> {
    let mut state: u32 = 0;
    // SAFETY: `state` is a valid 4-byte out buffer for this information level.
    let status = unsafe { CallNtPowerInformation(SYSTEM_EXECUTION_STATE, std::ptr::null(), 0, &mut state as *mut u32 as *mut c_void, 4) };
    (status == 0).then(|| state & ES_DISPLAY_REQUIRED != 0)
}

pub fn battery_saver() -> Option<bool> {
    let mut s = SystemPowerStatus::default();
    // SAFETY: `s` has the layout of SYSTEM_POWER_STATUS (12 bytes).
    let ok = unsafe { GetSystemPowerStatus(&mut s) };
    (ok != 0).then(|| s.system_status_flag == 1)
}

/// Is any key or mouse button physically down? (VK 1 to 6 are the mouse buttons.)
pub fn input_held() -> bool {
    // SAFETY: plain value call.
    (1..=254).any(|vk| unsafe { GetAsyncKeyState(vk) } < 0)
}

pub fn idle_seconds() -> Option<f64> {
    crate::platform::idle_seconds()
}
