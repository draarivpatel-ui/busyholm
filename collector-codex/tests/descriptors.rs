//! Lead 5 (descriptor half). Own test binary so no other test's open files disturb the count.
#![cfg(unix)]
use std::{fs, path::Path, sync::Arc};
use collector::{Adapter, AdapterContext, FakeClock, IdentityHasher};
use collector_codex::CodexAdapter;

fn open_descriptors() -> usize { fs::read_dir("/dev/fd").map(|d| d.count()).unwrap_or(0) }

#[test]
fn date_tree_scan_keeps_few_directories_open_at_once() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap()
        .join(format!("target/wp05-tests/fds-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    for month in 1..=12 { for day in 1..=31 { fs::create_dir_all(root.join(format!("2025/{month:02}/{day:02}"))).unwrap(); } }
    let ctx = AdapterContext { clock: Arc::new(FakeClock::new(1_791_806_400_000)), identities: IdentityHasher::new([37; 32]) };
    let mut adapter = CodexAdapter::watch(&root).unwrap();
    let base = open_descriptors();
    let mut peak = base;
    for _ in 0..40 { adapter.poll(&ctx).unwrap(); peak = peak.max(open_descriptors()); }
    let _ = fs::remove_dir_all(&root);
    assert!(peak <= base + 8, "scan held {} extra directory descriptors open", peak - base);
}
