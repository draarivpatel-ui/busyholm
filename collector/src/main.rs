use std::{io::{self,Write},path::PathBuf,sync::Arc,thread};
use collector::{Clock,EventBus,HookMapper,NormalizedMapper,SystemClock,ServiceConfig,stdio};

fn run()->io::Result<()> {
    let mut args=std::env::args_os().skip(1);let mut dir=None;let mut seed=0;
    while let Some(arg)=args.next(){match arg.to_str(){Some("--data-dir")=>dir=args.next().map(PathBuf::from),Some("--seed")=>{seed=args.next().and_then(|v|v.to_str().and_then(|s|s.parse::<u32>().ok())).ok_or(io::ErrorKind::InvalidInput)?;},_=>return Err(io::ErrorKind::InvalidInput.into())}}
    let dir=dir.map_or_else(stdio::default_data_dir,Ok)?;
    let clock:Arc<dyn Clock>=Arc::new(SystemClock);let mapper:Arc<dyn HookMapper>=Arc::new(NormalizedMapper{clock:clock.clone()});
    let bus=EventBus::bounded(4096);let sender=bus.sender();let reader_mapper=mapper.clone();
    thread::spawn(move||stdio::input(io::stdin().lock(),sender,reader_mapper));
    let mut stdout=io::BufWriter::new(io::stdout().lock());let mut config=ServiceConfig::new(dir);config.seed=seed;
    collector::run_service(config,bus,clock,mapper,|output| {
        serde_json::to_writer(&mut stdout,&output).map_err(|_|io::ErrorKind::InvalidData)?;stdout.write_all(b"\n")?;stdout.flush()
    })
}
fn main(){if run().is_err(){eprintln!("collector: service_failed");std::process::exit(1);}}
