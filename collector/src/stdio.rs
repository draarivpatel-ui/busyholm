//! Pieces shared by the stdio sidecar binaries (`collector` and `busyholm-sidecar`).
use std::{io::{self,BufRead},path::PathBuf,sync::Arc,thread,time::Duration};
use crate::{HookMapper,SendError};

/// The per-user data folder of SPEC 6.8.
pub fn default_data_dir()->io::Result<PathBuf> {
    #[cfg(target_os="windows")] {return std::env::var_os("APPDATA").map(|p|PathBuf::from(p).join("Busyholm")).ok_or_else(||io::ErrorKind::NotFound.into());}
    #[cfg(target_os="macos")] {return std::env::var_os("HOME").map(|p|PathBuf::from(p).join("Library/Application Support/Busyholm")).ok_or_else(||io::ErrorKind::NotFound.into());}
    #[cfg(not(any(target_os="windows",target_os="macos")))] {
        let root=std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).or_else(||std::env::var_os("HOME").map(|p|PathBuf::from(p).join(".local/share")));
        root.map(|p|p.join("busyholm")).ok_or_else(||io::ErrorKind::NotFound.into())
    }
}
pub fn input(mut reader:impl BufRead,sender:crate::EventSender,mapper:Arc<dyn HookMapper>) {
    let mut line=Vec::new();let mut oversized=false;
    loop {
        let buffer=match reader.fill_buf(){Ok(b)=>b,Err(_)=>break};
        if buffer.is_empty(){break;}
        let end=buffer.iter().position(|b|*b==b'\n');let n=end.map_or(buffer.len(),|i|i+1);
        if !oversized {if line.len()+n>crate::receiver::MAX_BODY+1 {oversized=true;line.clear();}else{line.extend_from_slice(&buffer[..n]);}}
        reader.consume(n);
        if end.is_some() {
            if !oversized&&!line.is_empty() {
                while matches!(line.last(),Some(b'\n'|b'\r')) {line.pop();}
                match mapper.map(None,&line) {
                    Ok(events)=>loop {match sender.send_batch(events.clone()){Ok(())=>break,Err(SendError::Full)=>thread::sleep(Duration::from_millis(1)),Err(_)=>return}},
                    Err(_)=>eprintln!("collector: invalid_input"),
                }
            }else if oversized {eprintln!("collector: oversized_input");}
            line.clear();oversized=false;
        }
    }
    loop {match sender.shutdown(){Ok(())|Err(SendError::Closed)=>break,Err(SendError::Full)=>thread::sleep(Duration::from_millis(1)),Err(_)=>break}}
}
