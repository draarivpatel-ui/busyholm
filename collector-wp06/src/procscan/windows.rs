//! Windows: a toolhelp snapshot lists processes; each is asked for its image path and creation
//! time. Nothing else about a process is queried.
use collector::AdapterError;
use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::Threading::{
    GetProcessTimes, OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
};

use super::{filetime_to_unix_ms, normalize_name, ProcInfo, ProcessSource};

#[derive(Default)]
pub struct WindowsSource;

fn filetime_ms(ft: &FILETIME) -> u64 {
    filetime_to_unix_ms((u64::from(ft.dwHighDateTime) << 32) | u64::from(ft.dwLowDateTime))
}

fn wide_to_string(w: &[u16]) -> String {
    let end = w.iter().position(|&c| c == 0).unwrap_or(w.len());
    String::from_utf16_lossy(&w[..end])
}

impl ProcessSource for WindowsSource {
    fn snapshot(&mut self) -> Result<Vec<ProcInfo>, AdapterError> {
        // SAFETY: documented Win32 calls with correctly sized, owned buffers; every handle opened is closed.
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snap == INVALID_HANDLE_VALUE {
                return Err(AdapterError::Io);
            }
            let mut entry: PROCESSENTRY32W = std::mem::zeroed();
            entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            let mut out = Vec::new();
            let mut ok = Process32FirstW(snap, &mut entry);
            while ok != 0 {
                let pid = entry.th32ProcessID;
                let exe_name = wide_to_string(&entry.szExeFile);
                let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
                let (mut start_ms, mut path) = (0u64, None);
                if !handle.is_null() {
                    let (mut c, mut e, mut k, mut u): (FILETIME, FILETIME, FILETIME, FILETIME) = std::mem::zeroed();
                    if GetProcessTimes(handle, &mut c, &mut e, &mut k, &mut u) != 0 {
                        start_ms = filetime_ms(&c);
                    }
                    let mut buf = vec![0u16; 1024];
                    let mut len = buf.len() as u32;
                    if QueryFullProcessImageNameW(handle, 0, buf.as_mut_ptr(), &mut len) != 0 {
                        path = Some(String::from_utf16_lossy(&buf[..len as usize]));
                    }
                    CloseHandle(handle);
                }
                // A process we may not open (other users, protected) has no start time and cannot be an agent of ours.
                if start_ms > 0 {
                    out.push(ProcInfo { pid, start_ms, name: normalize_name(&exe_name), path });
                }
                ok = Process32NextW(snap, &mut entry);
            }
            CloseHandle(snap);
            Ok(out)
        }
    }
}
