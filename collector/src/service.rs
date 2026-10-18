use std::{io,path::{Path,PathBuf},sync::Arc,time::Duration};
use busyholm_contracts::{Ledger,Validate,pending_alerts::PendingAlerts};
use crate::{CoverageFile,AdapterContext,AdapterRouter,Clock,Collector,CollectorInput,CollectorOutput,EventBus,HookMapper,IdentityHasher,Receiver,ReceiverCredentials,private_io,
    ledger::{Calendar,LocalCalendar}};

pub struct ServiceConfig {
    pub data_dir:PathBuf,pub seed:u32,
    /// Adapters to rebuild from at start and to poll while running. Hook bodies reach them through the
    /// `mapper` argument of `run_service`: pass the SAME router there (it is also a `HookMapper`).
    pub router:Option<Arc<AdapterRouter>>,
    /// How often the router is polled, in monotonic milliseconds (one wakeup per period; SPEC 6.7 allows 10/s).
    /// An adapter's file notice (`Waker`) polls earlier, at most once per `WAKE_MIN_MS`.
    pub poll_ms:u64,
}
impl ServiceConfig {
    pub fn new(data_dir:PathBuf)->Self {Self{data_dir,seed:0,router:None,poll_ms:1000}}
}

/// The adapter context the service uses: the shared clock plus the per-install salt stored in the data folder.
/// Build the `AdapterRouter` from this BEFORE calling `run_service`, so hook-derived and log-derived ids match.
pub fn adapter_context(data_dir:&Path,clock:Arc<dyn Clock>)->io::Result<AdapterContext> {
    private_io::private_dir(data_dir)?;
    Ok(AdapterContext{clock,identities:IdentityHasher::new(private_io::load_salt(data_dir)?)})
}

/// A stored file that cannot be read or validated is moved aside (one `.corrupt` copy is kept) so the service
/// starts instead of failing forever; the next write creates a fresh file.
fn quarantine(path:&Path) {
    let mut name=path.file_name().map(|n|n.to_os_string()).unwrap_or_default();name.push(".corrupt");
    let _=std::fs::rename(path,path.with_file_name(name));
    eprintln!("collector: stored_file_quarantined");
}

/// Woken polls are at least this far apart, so a burst of file notices (a busy rollout) cannot poll per line.
pub const WAKE_MIN_MS:u64=25;

/// Daily rolling copies of the ledger (SPEC 6.8): `backups/ledger-YYYY-MM-DD.json`, the newest 14 kept.
const BACKUPS:usize=14;
fn backup_name(name:&str)->bool {
    let b=name.as_bytes();
    name.len()==22&&name.starts_with("ledger-")&&name.ends_with(".json")
        &&[7,8,9,10,12,13,15,16].iter().all(|&i|b[i].is_ascii_digit())&&b[11]==b'-'&&b[14]==b'-'
}
/// Our own backup files, newest first (the names sort by date).
fn backup_names(dir:&Path)->Vec<String> {
    let mut names:Vec<String>=std::fs::read_dir(dir).map(|d|d.flatten().filter_map(|e|e.file_name().to_str().map(str::to_owned)).filter(|n|backup_name(n)).collect()).unwrap_or_default();
    names.sort_unstable_by(|a,b|b.cmp(a));names
}
/// Loads the newest backup that reads and validates. False when none does.
fn restore_backup(core:&mut Collector,dir:&Path)->bool {
    backup_names(dir).iter().any(|name|private_io::read_json::<Ledger>(&dir.join(name),32*1024*1024).ok().is_some_and(|l|core.load_ledger(l).is_ok()))
}
/// Writes today's copy once (the first valid ledger of the day) and prunes to the newest 14. A failed backup
/// never stops the service; the next day tries again.
fn roll_backup(data_dir:&Path,clock:&dyn Clock,ledger:&Ledger,done:&mut Option<String>) {
    let day=LocalCalendar.day(clock.now_ms());
    if done.as_deref()==Some(day.as_str()) {return;}
    let dir=data_dir.join("backups");
    let path=dir.join(format!("ledger-{day}.json"));
    let written=private_io::private_dir(&dir).and_then(|_|if std::fs::symlink_metadata(&path).is_ok() {Ok(())} else {private_io::atomic_json(&path,ledger)});
    if written.is_ok() {
        for old in backup_names(&dir).into_iter().skip(BACKUPS) {let _=std::fs::remove_file(dir.join(old));}
        *done=Some(day);
    }
}

/// Blocking worker entry point for a Tauri-owned thread or the stdio sidecar.
/// The app owns the callback and forwards validated outputs to its windows.
pub fn run_service(
    config:ServiceConfig,bus:EventBus,clock:Arc<dyn Clock>,mapper:Arc<dyn HookMapper>,
    mut output:impl FnMut(CollectorOutput)->io::Result<()>,
)->io::Result<()> {
    private_io::private_dir(&config.data_dir)?;
    private_io::remove_stale_temp_files(&config.data_dir);
    private_io::remove_stale_temp_files(&config.data_dir.join("backups"));
    let keys=ReceiverCredentials::load_or_create(&config.data_dir)?;
    let _salt=private_io::load_salt(&config.data_dir)?;
    let receiver=Receiver::start(&config.data_dir.join("runtime.json"),keys,mapper,bus.sender())?;
    let mut core=Collector::new(clock.clone(),config.seed);
    let ledger_path=config.data_dir.join("ledger.json");
    let loaded=if std::fs::symlink_metadata(&ledger_path).is_ok() {
        let ok=private_io::read_json::<Ledger>(&ledger_path,32*1024*1024).ok().and_then(|l|core.load_ledger(l).ok());
        if ok.is_none() {quarantine(&ledger_path);}
        ok
    } else {
        None
    };
    if loaded.is_none()&&restore_backup(&mut core,&config.data_dir.join("backups")) {
        // SPEC 6.8: a corrupt or missing ledger is replaced by the newest valid backup, written back at once so the
        // restore survives a kill (review r1 H7, review r2 P2-2). With no valid backup the service starts fresh.
        core.ledger().validate().map_err(|_|io::ErrorKind::InvalidData)?;
        private_io::atomic_json(&ledger_path,core.ledger())?;
        eprintln!("collector: stored_file_restored_from_backup");
    }
    let mut backed_up=None;
    roll_backup(&config.data_dir,clock.as_ref(),core.ledger(),&mut backed_up);
    let pending_path=config.data_dir.join("pending-alerts.json");
    if std::fs::symlink_metadata(&pending_path).is_ok() {
        let loaded=private_io::read_json::<PendingAlerts>(&pending_path,256*1024).ok().and_then(|p|core.restore_pending(p).ok());
        if loaded.is_none() {quarantine(&pending_path);}
    }
    // The proof that hooks deliver survives a restart (INT-1); a bad file is set aside like the others.
    let coverage_path=config.data_dir.join("coverage.json");
    if let Some(router)=&config.router {core.set_adapters(router.registered());}
    if std::fs::symlink_metadata(&coverage_path).is_ok() {
        let loaded=private_io::read_json::<CoverageFile>(&coverage_path,64*1024).ok().and_then(|f|core.restore_coverage(f).ok());
        if loaded.is_none() {quarantine(&coverage_path);}
    }
    if let Some(router)=&config.router {
        router.set_waker(bus.sender().waker());
        // Observations from the registry, recent transcripts and the process list; never earned history.
        let events=router.rebuild().unwrap_or_default();
        if !events.is_empty() {for o in core.rebuild(events).unwrap_or_default(){output(o)?;}}
    }
    for o in core.tick(){output(o)?;}
    // The loaded ledger goes out at once, so a window does not wait for the first flush.
    output(CollectorOutput::Ledger(core.ledger().clone()))?;
    let mut pending=core.pending_alerts();pending.validate().map_err(|_|io::ErrorKind::InvalidData)?;
    private_io::atomic_json(&pending_path,&pending)?;
    let mut coverage=core.coverage_record();
    private_io::atomic_json(&coverage_path,&coverage)?;
    let sender=bus.sender();
    let mut flushed=clock.monotonic_ms();let mut polled=flushed;let mut persisted=core.ledger().clone();
    // A wake that arrived less than WAKE_MIN_MS after the last poll waits for that gap, then polls.
    let mut woken=false;
    let mut flush_on_exit=true;
    loop {
        let now=clock.monotonic_ms();
        let mut wait=core.next_wake_ms().min(30000u64.saturating_sub(now.saturating_sub(flushed)));
        if config.router.is_some() {
            let period=if woken {WAKE_MIN_MS.min(config.poll_ms)} else {config.poll_ms};
            wait=wait.min(period.saturating_sub(now.saturating_sub(polled)));
        }
        let input=bus.receiver.recv_timeout(Duration::from_millis(wait.max(1)));
        let outputs=match input {
            Ok(CollectorInput::Event(e))=>core.ingest(e).unwrap_or_default(),
            Ok(CollectorInput::Rebuild(events))=>core.rebuild(events).unwrap_or_default(),
            Ok(CollectorInput::Hooks{tool,status})=>{core.set_hooks(tool,status);core.tick()},
            Ok(CollectorInput::Wake)=>{woken=true;Vec::new()},
            Ok(CollectorInput::ShutdownWithoutFlush)=>{flush_on_exit=false;break;},
            Ok(CollectorInput::Shutdown)|Err(std::sync::mpsc::RecvTimeoutError::Disconnected)=>break,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)=>core.tick(),
        };
        let changed=!outputs.is_empty();
        if let Some(router)=&config.router {
            let since=clock.monotonic_ms().saturating_sub(polled);
            if since>=config.poll_ms||(woken&&since>=WAKE_MIN_MS) {let _=router.poll(&sender);polled=clock.monotonic_ms();woken=false;}
        }
        // Persist BEFORE announcing: whatever a window has been shown (an alert, a counted turn) is already on
        // disk, so a kill right after the announcement loses nothing. Counts are written as soon as an event
        // changes them; pure time accrual is flushed every 30 s.
        let mut flushed_now=false;
        if config.data_dir.is_dir() {
            let current=core.pending_alerts();
            if current.alerts!=pending.alerts {private_io::atomic_json(&pending_path,&current)?;pending=current;}
            let current=core.coverage_record();
            if current!=coverage {private_io::atomic_json(&coverage_path,&current)?;coverage=current;}
            if changed||clock.monotonic_ms().saturating_sub(flushed)>=30000 {
                if core.ledger()!=&persisted {core.ledger().validate().map_err(|_|io::ErrorKind::InvalidData)?;private_io::atomic_json(&ledger_path,core.ledger())?;persisted=core.ledger().clone();flushed_now=true;
                    roll_backup(&config.data_dir,clock.as_ref(),core.ledger(),&mut backed_up);}
                if !changed {flushed=clock.monotonic_ms();}
            }
        }
        for o in outputs {output(o)?;}
        if flushed_now {output(CollectorOutput::Ledger(core.ledger().clone()))?;}
    }
    if flush_on_exit && config.data_dir.is_dir() {
        let outputs=core.tick();
        core.ledger().validate().map_err(|_|io::ErrorKind::InvalidData)?;
        private_io::atomic_json(&ledger_path,core.ledger())?;
        roll_backup(&config.data_dir,clock.as_ref(),core.ledger(),&mut backed_up);
        private_io::atomic_json(&pending_path,&core.pending_alerts())?;
        private_io::atomic_json(&coverage_path,&core.coverage_record())?;
        for o in outputs {let _=output(o);}
        let _=output(CollectorOutput::Ledger(core.ledger().clone()));
    }
    drop(receiver);Ok(())
}
