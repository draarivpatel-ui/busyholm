//! The pieces against the real WP-03 collector: the plugin posting to the real receiver, and
//! all three adapters registered in the real AdapterRouter.
mod common;
use busyholm_contracts::common::Tool;
use collector::{Adapter, AdapterContext, AdapterRouter, CollectorInput, EventBus, FakeClock, IdentityHasher, Receiver, ReceiverCredentials};
use collector_wp06::{AgyAdapter, AgyConfig, OpenCodeAdapter, ProcInfo, ProcessScanner, ProcessSource};
use common::*;
use std::sync::Arc;
use std::time::{Duration, UNIX_EPOCH};

const T0: u64 = 1_791_806_400_000;

fn ctx(clock: Arc<FakeClock>) -> AdapterContext {
    AdapterContext { clock, identities: IdentityHasher::new([7u8; 32]) }
}

fn drain(bus: &EventBus, want: usize, wait: Duration) -> Vec<busyholm_contracts::AgentEvent> {
    let mut out = Vec::new();
    let deadline = std::time::Instant::now() + wait;
    while out.len() < want && std::time::Instant::now() < deadline {
        if let Ok(CollectorInput::Event(e)) = bus.receiver.recv_timeout(Duration::from_millis(100)) {
            out.push(e);
        }
    }
    out
}

#[test]
fn the_real_plugin_posts_to_the_real_receiver_and_the_opencode_adapter_maps_it() {
    if std::process::Command::new("node").arg("--version").output().is_err() {
        eprintln!("node not found: skipping");
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let clock = Arc::new(FakeClock::new(T0));
    let context = ctx(clock);
    let mut router = AdapterRouter::new(context.clone());
    router.register(Box::new(OpenCodeAdapter::new("/Users/u/.local/share/opencode".into()))).unwrap();
    let bus = EventBus::bounded(256);
    let keys = ReceiverCredentials { secret: "a".repeat(64), token: "b".repeat(64) };
    let runtime = dir.path().join("runtime.json");
    let _receiver = Receiver::start(&runtime, keys, Arc::new(router), bus.sender()).unwrap();

    let script = repo_root().join("collector-wp06/plugin/tools/run-against.mjs");
    let out = std::process::Command::new("node").arg(&script).arg(&runtime).output().unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));

    let events = drain(&bus, 16, Duration::from_secs(3));
    assert_eq!(events.len(), 16, "8 + 8 mapped fixtures, noise dropped by the plugin");
    check_events(&events);
    let ks = kinds(&events);
    for want in ["session_start", "turn_start", "turn_end", "needs_permission", "answered", "needs_answer", "tool_end", "error", "turn_interrupted", "heartbeat", "session_end"] {
        assert!(ks.iter().any(|k| k == want), "no {want} in {ks:?}");
    }
    assert!(events.iter().all(|e| e.agent == Tool::Opencode));
    let perm = events.iter().find(|e| serde_json::to_value(e.kind).unwrap() == "needs_permission").unwrap();
    assert!(perm.request_id.is_some());
    let wire_sid = collector_wp06::sha256_hex("bca1a700-0000-4000-8000-00000000007f");
    assert_eq!(perm.instance, context.instance(Tool::Opencode, &wire_sid));
}

struct Fake(Vec<ProcInfo>);
impl ProcessSource for Fake {
    fn snapshot(&mut self) -> Result<Vec<ProcInfo>, collector::AdapterError> { Ok(self.0.clone()) }
}

#[test]
fn all_three_adapters_register_in_the_router_and_rebuild_and_poll_through_the_bus() {
    let dir = tempfile::tempdir().unwrap();
    // OpenCode database: one session updated 5 s ago, with the real table layout
    let db = dir.path().join("opencode.db");
    {
        let c = rusqlite::Connection::open(&db).unwrap();
        c.pragma_update(None, "foreign_keys", "OFF").unwrap();
        c.execute_batch(&std::fs::read_to_string(repo_root().join("fixtures/wp06/opencode/schema.sql")).unwrap()).unwrap();
        c.execute("INSERT INTO session (id, project_id, slug, directory, title, version, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, time_created, time_updated) VALUES ('bca1a700-0000-4000-8000-00000000007f', 'p', 'BHCANARY_slug', 'BHCANARY_dir', 'BHCANARY_title', '1', 0, 5, 0, 0, 0, 0, ?1, ?2)",
            rusqlite::params![(T0 - 60_000) as i64, (T0 - 5_000) as i64]).unwrap();
    }
    // agy log: active, 3 s lines
    let root = dir.path().join("antigravity-cli");
    std::fs::create_dir_all(root.join("log")).unwrap();
    let log = root.join("log/cli-20261012_120000.log");
    let mut text = String::from("I1012 12:00:00.250000 4242 server.go:41] ready\n");
    for i in 0..5 { text += &format!("I1012 12:00:{:02}.000000 4242 http_helpers.go:88] URL: https://example.invalid/x\n", 3 + 3 * i); }
    text += "I1012 12:00:16.000000 4242 cli.go:310] submitted prompt BHCANARY_antigravity_prompt_1\n";
    std::fs::write(&log, &text).unwrap();
    std::fs::OpenOptions::new().write(true).open(&log).unwrap().set_modified(UNIX_EPOCH + Duration::from_millis(T0)).unwrap();

    let clock = Arc::new(FakeClock::new(T0));
    let context = ctx(clock.clone());
    let poller = collector_wp06::OpenCodePoller::new(collector_wp06::PollConfig::new(db));
    let mut router = AdapterRouter::new(context);
    router.register(Box::new(OpenCodeAdapter::with_poller(poller))).unwrap();
    router.register(Box::new(AgyAdapter::new(AgyConfig::new(root)))).unwrap();
    let scanner = ProcessScanner::new(Box::new(Fake(vec![ProcInfo { pid: 4242, start_ms: T0 - 120_000, name: "agy".into(), path: Some("/u/agy".into()) }])));
    router.register(Box::new(scanner)).unwrap();

    let rebuilt = router.rebuild().unwrap();
    check_events(&rebuilt);
    let tools: std::collections::BTreeSet<_> = rebuilt.iter().map(|e| format!("{:?}", e.agent)).collect();
    assert_eq!(tools.into_iter().collect::<Vec<_>>(), vec!["Antigravity", "Opencode"]);
    let k = kinds(&rebuilt);
    assert!(k.contains(&"process_up".to_string()) && k.contains(&"turn_start".to_string()) && k.contains(&"session_start".to_string()), "{k:?}");

    // a later poll is incremental: nothing new, nothing lost
    clock.advance(2_000);
    let bus = EventBus::bounded(256);
    router.poll(&bus.sender()).unwrap();
    let later = drain(&bus, 1, Duration::from_millis(300));
    check_events(&later);
    assert!(later.iter().all(|e| serde_json::to_value(e.kind).unwrap() != "process_up"), "no repeat of the baseline");
    let _ = (Adapter::tool(&OpenCodeAdapter::new(String::new())),);
}
