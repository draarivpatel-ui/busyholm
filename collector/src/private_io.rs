use std::{fs::{self,File,OpenOptions},io::{self,Read,Write},path::Path};
use serde::{Serialize,de::DeserializeOwned};

fn error()->io::Error {io::Error::from(io::ErrorKind::InvalidData)}
pub fn random<const N:usize>()->io::Result<[u8;N]> {
    let mut bytes=[0;N];getrandom::getrandom(&mut bytes).map_err(|_|io::Error::from(io::ErrorKind::Other))?;Ok(bytes)
}
pub fn hex(bytes:&[u8])->String {bytes.iter().map(|b|format!("{b:02x}")).collect()}
pub fn private_dir(path:&Path)->io::Result<()> {
    if fs::symlink_metadata(path).is_ok_and(|m|m.file_type().is_symlink()) {return Err(error());}
    fs::create_dir_all(path)?;
    #[cfg(unix)] {use std::os::unix::fs::PermissionsExt;fs::set_permissions(path,fs::Permissions::from_mode(0o700))?;}
    Ok(())
}
fn open_new(path:&Path)->io::Result<File> {
    let mut options=OpenOptions::new();options.write(true).create_new(true);
    #[cfg(unix)] {use std::os::unix::fs::OpenOptionsExt;options.mode(0o600).custom_flags(libc::O_NOFOLLOW);}
    options.open(path)
}
pub fn read_bytes(path:&Path,max:usize)->io::Result<Vec<u8>> {
    let meta=fs::symlink_metadata(path)?;
    if !meta.is_file()||meta.file_type().is_symlink()||meta.len()>max as u64 {return Err(error());}
    let mut options=OpenOptions::new();options.read(true);
    #[cfg(unix)] {use std::os::unix::fs::OpenOptionsExt;options.custom_flags(libc::O_NOFOLLOW);}
    let mut bytes=Vec::new();options.open(path)?.take((max+1) as u64).read_to_end(&mut bytes)?;
    if bytes.len()>max{return Err(error());}Ok(bytes)
}
pub fn read_json<T:DeserializeOwned>(path:&Path,max:usize)->io::Result<T> {
    serde_json::from_slice(&read_bytes(path,max)?).map_err(|_|error())
}
pub fn create_private(path:&Path,bytes:&[u8])->io::Result<()> {
    private_dir(path.parent().ok_or_else(error)?)?;let mut file=open_new(path)?;file.write_all(bytes)?;file.sync_all()
}
pub fn atomic_bytes(path:&Path,bytes:&[u8])->io::Result<()> {
    let parent=path.parent().ok_or_else(error)?;private_dir(parent)?;
    if fs::symlink_metadata(path).is_ok_and(|m|m.file_type().is_symlink()||!m.is_file()){return Err(error());}
    let tmp=parent.join(format!(".busyholm-{}-{}.tmp",std::process::id(),hex(&random::<8>()?)));
    let result=(||{let mut file=open_new(&tmp)?;file.write_all(bytes)?;file.sync_all()?;drop(file);fs::rename(&tmp,path)?;
        #[cfg(unix)] {File::open(parent)?.sync_all()?;}
        Ok(())})();if result.is_err(){let _=fs::remove_file(tmp);}result
}
pub fn atomic_json<T:Serialize>(path:&Path,value:&T)->io::Result<()> {
    let bytes=serde_json::to_vec(value).map_err(|_|error())?;atomic_bytes(path,&bytes)
}
pub fn load_salt(dir:&Path)->io::Result<[u8;32]> {
    let path=dir.join("salt");if !path.exists(){let salt=random::<32>()?;match create_private(&path,&salt){Ok(())=>return Ok(salt),Err(e)if e.kind()==io::ErrorKind::AlreadyExists=>{},Err(e)=>return Err(e)}}
    read_bytes(&path,32)?.try_into().map_err(|_|error())
}
/// Removes temp files left by a write that was killed before its rename. Only our own naming pattern, only
/// regular files, only when older than a minute (a live write in another process is never touched).
pub fn remove_stale_temp_files(dir:&Path) {
    let Ok(entries)=fs::read_dir(dir) else {return};
    for entry in entries.flatten() {
        let name=entry.file_name();let Some(name)=name.to_str() else {continue};
        if !(name.starts_with(".busyholm-")&&name.ends_with(".tmp")) {continue;}
        let Ok(meta)=fs::symlink_metadata(entry.path()) else {continue};
        let old=meta.modified().ok().and_then(|m|m.elapsed().ok()).is_some_and(|age|age>std::time::Duration::from_secs(60));
        if meta.is_file()&&old {let _=fs::remove_file(entry.path());}
    }
}
