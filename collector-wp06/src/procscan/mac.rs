//! macOS: libproc. The process list, each process's executable path, and its start time from
//! the BSD info record. No argument-list API is used.
use std::ffi::c_void;
use std::mem;

use collector::AdapterError;

use super::{normalize_name, ProcInfo, ProcessSource};

#[derive(Default)]
pub struct MacSource;

impl ProcessSource for MacSource {
    fn snapshot(&mut self) -> Result<Vec<ProcInfo>, AdapterError> {
        // SAFETY: plain libproc calls with buffers we own and correct sizes.
        unsafe {
            let wanted = libc::proc_listallpids(std::ptr::null_mut(), 0);
            if wanted <= 0 {
                return Err(AdapterError::Io);
            }
            let mut pids = vec![0 as libc::pid_t; wanted as usize + 64];
            let got = libc::proc_listallpids(pids.as_mut_ptr() as *mut c_void, (pids.len() * mem::size_of::<libc::pid_t>()) as libc::c_int);
            if got <= 0 {
                return Err(AdapterError::Io);
            }
            pids.truncate(got as usize);
            let mut out = Vec::with_capacity(pids.len());
            let mut path_buf = vec![0u8; 4096];
            for pid in pids {
                if pid <= 0 {
                    continue;
                }
                let mut info: libc::proc_bsdinfo = mem::zeroed();
                let size = mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
                let n = libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, &mut info as *mut _ as *mut c_void, size);
                if n != size {
                    continue; // exited meanwhile, or not ours to see
                }
                let start_ms = info.pbi_start_tvsec.saturating_mul(1000) + info.pbi_start_tvusec / 1000;
                let plen = libc::proc_pidpath(pid, path_buf.as_mut_ptr() as *mut c_void, path_buf.len() as u32);
                let path = (plen > 0).then(|| String::from_utf8_lossy(&path_buf[..plen as usize]).into_owned());
                let name = match &path {
                    Some(p) => normalize_name(p.rsplit('/').next().unwrap_or(p)),
                    None => {
                        let comm: Vec<u8> = info.pbi_comm.iter().take_while(|&&c| c != 0).map(|&c| c as u8).collect();
                        normalize_name(&String::from_utf8_lossy(&comm))
                    }
                };
                out.push(ProcInfo { pid: pid as u32, start_ms, name, path });
            }
            Ok(out)
        }
    }
}
