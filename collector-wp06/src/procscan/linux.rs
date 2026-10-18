//! Linux: `/proc/<pid>/stat` for the start time, the `exe` link for the path. Other files
//! under `/proc/<pid>` are not opened.
use std::fs;

use collector::AdapterError;

use super::{normalize_name, parse_proc_stat, ProcInfo, ProcessSource};

#[derive(Default)]
pub struct LinuxSource;

fn boot_time_s() -> Option<u64> {
    let text = fs::read_to_string("/proc/stat").ok()?;
    text.lines().find_map(|l| l.strip_prefix("btime ")).and_then(|v| v.trim().parse().ok())
}

impl ProcessSource for LinuxSource {
    fn snapshot(&mut self) -> Result<Vec<ProcInfo>, AdapterError> {
        let btime = boot_time_s().ok_or(AdapterError::Io)?;
        // SAFETY: sysconf has no preconditions.
        let hz = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
        let hz = if hz > 0 { hz as u64 } else { 100 };
        let mut out = Vec::new();
        for entry in fs::read_dir("/proc").map_err(|_| AdapterError::Io)?.flatten() {
            let name = entry.file_name();
            let Some(pid) = name.to_str().and_then(|s| s.parse::<u32>().ok()) else { continue };
            let Ok(stat) = fs::read_to_string(format!("/proc/{pid}/stat")) else { continue };
            let Some((comm, ticks)) = parse_proc_stat(&stat) else { continue };
            let start_ms = btime * 1000 + ticks * 1000 / hz;
            let path = fs::read_link(format!("/proc/{pid}/exe"))
                .ok()
                .map(|p| p.to_string_lossy().trim_end_matches(" (deleted)").to_string());
            let nm = match &path {
                Some(p) => normalize_name(p.rsplit('/').next().unwrap_or(p)),
                None => normalize_name(&comm),
            };
            out.push(ProcInfo { pid, start_ms, name: nm, path });
        }
        Ok(out)
    }
}
