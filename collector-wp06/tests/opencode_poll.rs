//! WP-06 acceptance test 2: the fixture database yields events and the query plan never
//! scans `message`, `part` or `event` (nor reads any content column).
#![cfg(feature = "opencode-poll")]
mod common;
use busyholm_contracts::{agent_event::{EventKind, EventSource}, common::{Confidence, Tool}};
use collector_wp06::opencode_poll::{ALLOWED_COLUMNS, QUERIES, SESSION_QUERY};
use collector_wp06::{OpenCodePoller, PollConfig, sha256_hex};
use common::*;
use rusqlite::{params, Connection};
use std::path::{Path, PathBuf};

const T0: u64 = 1_791_806_400_000;

fn id_of(raw: &str) -> String { collector_wp06::Identity::instance(&FakeIds, Tool::Opencode, &sha256_hex(raw)) }

struct Row { id: &'static str, parent: Option<&'static str>, created: u64, updated: u64, tokens: i64 }

fn schema() -> String { std::fs::read_to_string(repo_root().join("fixtures/wp06/opencode/schema.sql")).unwrap() }

fn build_db(dir: &Path, rows: &[Row]) -> (PathBuf, Connection) {
    let path = dir.join("opencode.db");
    let conn = Connection::open(&path).unwrap();
    conn.pragma_update(None, "foreign_keys", "OFF").unwrap();
    conn.pragma_update(None, "journal_mode", "WAL").unwrap();
    conn.execute_batch(&schema()).unwrap();
    conn.execute("INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES ('bca1a700-0000-4000-8000-000000000081', '/Users/x/BHCANARY_worktree', 1, 1, '[]')", []).unwrap();
    for r in rows { insert(&conn, r); }
    // Content in the big tables: a scan of any of them would touch these canaries.
    for i in 0..50 {
        conn.execute("INSERT INTO event_sequence (aggregate_id, seq) VALUES (?1, ?2)", params![format!("BHCANARY_agg_{i}"), i]).unwrap();
        conn.execute("INSERT INTO event (id, aggregate_id, seq, type, data) VALUES (?1, ?2, ?3, 'message.part.updated.1', 'BHCANARY_event_data')", params![format!("BHCANARY_ev_{i}"), format!("BHCANARY_agg_{i}"), i]).unwrap();
        conn.execute("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?1, 'bca1a700-0000-4000-8000-00000000007f', 1, 1, '{\"role\":\"user\",\"x\":\"BHCANARY_message_data\"}')", params![format!("BHCANARY_msg_{i}")]).unwrap();
        conn.execute("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?1, ?2, 'bca1a700-0000-4000-8000-00000000007f', 1, 1, '{\"text\":\"BHCANARY_part_text\"}')", params![format!("BHCANARY_part_{i}"), format!("BHCANARY_msg_{i}")]).unwrap();
    }
    (path, conn)
}

fn insert(conn: &Connection, r: &Row) {
    conn.execute(
        "INSERT INTO session (id, project_id, parent_id, slug, directory, path, title, version, summary_diffs, metadata, permission, agent, model, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, time_created, time_updated)
         VALUES (?1, 'bca1a700-0000-4000-8000-000000000081', ?2, 'BHCANARY_slug', '/Users/x/BHCANARY_dir', '/Users/x/BHCANARY_path', 'BHCANARY_title', '1.18.35', 'BHCANARY_diffs', '{\"k\":\"BHCANARY_meta\"}', 'BHCANARY_perm', 'BHCANARY_agent', 'BHCANARY_model', 1.5, ?3, 0, 0, 0, 0, ?4, ?5)",
        params![r.id, r.parent, r.tokens, r.created as i64, r.updated as i64],
    ).unwrap();
}
fn touch(conn: &Connection, id: &str, updated: u64, tokens: i64) {
    conn.execute("UPDATE session SET time_updated = ?2, tokens_input = ?3 WHERE id = ?1", params![id, updated as i64, tokens]).unwrap();
}
fn cfg(path: &Path) -> PollConfig { PollConfig::new(path.to_path_buf()) }
fn fresh() -> (tempfile::TempDir, PathBuf, Connection, OpenCodePoller) {
    let dir = tempfile::tempdir().unwrap();
    let rows = [
        Row { id: "A", parent: None, created: T0 - 600_000, updated: T0 - 5_000, tokens: 100 },
        Row { id: "B", parent: None, created: T0 - 900_000, updated: T0 - 400_000, tokens: 10 },
        Row { id: "C", parent: None, created: T0 - 9_000_000, updated: T0 - 7_200_000, tokens: 10 },
        Row { id: "S", parent: Some("A"), created: T0 - 60_000, updated: T0 - 3_000, tokens: 5 },
    ];
    let (path, conn) = build_db(dir.path(), &rows);
    let poller = OpenCodePoller::new(cfg(&path));
    (dir, path, conn, poller)
}

fn plan(conn: &Connection, sql: &str) -> Vec<String> {
    let mut st = conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
    let n = st.parameter_count();
    let params: Vec<i64> = vec![0; n];
    st.query_map(rusqlite::params_from_iter(params), |r| r.get::<_, String>(3)).unwrap().map(|r| r.unwrap()).collect()
}

#[test]
fn query_plan_touches_only_the_session_table() {
    let (_d, _p, conn, _poller) = fresh();
    assert!(!QUERIES.is_empty());
    for q in QUERIES {
        let rows = plan(&conn, q);
        assert!(!rows.is_empty());
        println!("PLAN for poller query:\n  {}", rows.join("\n  "));
        for r in &rows {
            let low = r.to_lowercase();
            for banned in ["message", "part", "event", "session_message", "todo", "permission", "project", "credential", "account"] {
                assert!(!low.split(|c: char| !c.is_alphanumeric() && c != '_').any(|w| w == banned), "plan row touches {banned}: {r}");
            }
            assert!(low.contains("session") || low.starts_with("use temp b-tree"), "plan row not on session: {r}");
        }
    }
}

#[test]
fn the_sql_text_names_no_content_column_and_no_other_table() {
    assert!(QUERIES.contains(&SESSION_QUERY));
    let content = ["title", "directory", "slug", "summary_diffs", "summary_files", "metadata", "path", "share_url", "revert", "permission", "agent", "model", "workspace_id", "project_id", "cost", "data", "*"];
    let from_other = ["message", "part", "event", "credential", "account", "project", "todo", "join"];
    for q in QUERIES {
        let low = q.to_lowercase();
        let words: Vec<&str> = low.split(|c: char| !c.is_alphanumeric() && c != '_' && c != '*').filter(|w| !w.is_empty()).collect();
        for c in content { assert!(!words.contains(&c), "query names content column {c}: {q}"); }
        for t in from_other { assert!(!words.contains(&t), "query names {t}: {q}"); }
        assert!(words.contains(&"session"));
    }
    for c in ALLOWED_COLUMNS {
        assert!(!["title", "directory", "slug", "summary_diffs", "metadata", "path", "permission"].contains(c));
    }
}

#[test]
fn first_look_reports_recent_sessions_as_observations() {
    let (_d, _p, _c, mut poller) = fresh();
    let evs = poller.rebuild_at(&FakeIds, T0).unwrap();
    check_events(&evs);
    let summary: Vec<(String, EventKind)> = evs.iter().map(|e| (e.instance.clone(), e.kind)).collect();
    // ascending time_updated: B (T0-400s), A (T0-5s), S (T0-3s); C is outside the 10 minute window
    assert_eq!(summary, vec![
        (id_of("B"), EventKind::SessionStart),
        (id_of("A"), EventKind::SessionStart), (id_of("A"), EventKind::TurnStart),
        (id_of("S"), EventKind::SessionStart), (id_of("S"), EventKind::TurnStart),
    ]);
    for e in &evs {
        assert_eq!((e.source, e.confidence, e.agent), (EventSource::Poll, Confidence::Inferred, Tool::Opencode));
        assert_eq!(e.t, T0);
    }
    let s_start = evs.iter().find(|e| e.instance == id_of("S") && e.kind == EventKind::SessionStart).unwrap();
    assert_eq!(s_start.parent, Some(id_of("A")));
    assert_eq!(s_start.et, Some(T0 - 60_000));
    let a_turn = evs.iter().find(|e| e.instance == id_of("A") && e.kind == EventKind::TurnStart).unwrap();
    assert_eq!(a_turn.et, Some(T0 - 5_000));
    assert!(evs.iter().all(|e| e.tokens_delta.is_none()), "history never earns tokens");
}

#[test]
fn live_changes_become_events_and_quiet_ends_the_turn() {
    let (_d, _p, writer, mut poller) = fresh();
    poller.rebuild_at(&FakeIds, T0).unwrap();

    // A keeps working: heartbeat plus the token growth
    touch(&writer, "A", T0 + 1_500, 150);
    let evs = poller.poll_at(&FakeIds, T0 + 2_000).unwrap();
    check_events(&evs);
    assert_eq!(kinds(&evs), vec!["heartbeat"]);
    assert_eq!(evs[0].instance, id_of("A"));
    assert_eq!(evs[0].tokens_delta, Some(50));
    assert_eq!(evs[0].et, Some(T0 + 1_500));

    // nothing changed: nothing emitted (also inside the min interval)
    assert!(poller.poll_at(&FakeIds, T0 + 2_100).unwrap().is_empty());
    assert!(poller.poll_at(&FakeIds, T0 + 3_500).unwrap().is_empty());

    // S has been quiet 90 s (row clock T0-3000): its turn ends, A's does not
    let evs = poller.poll_at(&FakeIds, T0 + 87_000).unwrap();
    assert_eq!((kinds(&evs), evs[0].instance.clone(), evs[0].confidence), (vec!["turn_end".to_string()], id_of("S"), Confidence::Inferred));
    assert!(poller.poll_at(&FakeIds, T0 + 90_499).unwrap().is_empty());
    let evs = poller.poll_at(&FakeIds, T0 + 91_500).unwrap();
    assert_eq!((kinds(&evs), evs[0].instance.clone()), (vec!["turn_end".to_string()], id_of("A")));
    // and it ends only once
    assert!(poller.poll_at(&FakeIds, T0 + 120_000).unwrap().is_empty());

    // activity after a quiet period starts a new turn
    touch(&writer, "A", T0 + 130_000, 160);
    let evs = poller.poll_at(&FakeIds, T0 + 131_000).unwrap();
    assert_eq!(kinds(&evs), vec!["turn_start"]);
    assert_eq!(evs[0].tokens_delta, Some(10));
}

#[test]
fn new_sessions_and_archival() {
    let (_d, _p, writer, mut poller) = fresh();
    poller.rebuild_at(&FakeIds, T0).unwrap();
    insert(&writer, &Row { id: "N", parent: None, created: T0 + 10_000, updated: T0 + 10_000, tokens: 0 });
    let evs = poller.poll_at(&FakeIds, T0 + 11_000).unwrap();
    assert_eq!((kinds(&evs), evs[0].instance.clone()), (vec!["session_start".to_string()], id_of("N")), "a brand new row is not yet a turn");
    touch(&writer, "N", T0 + 15_000, 20);
    let evs = poller.poll_at(&FakeIds, T0 + 16_000).unwrap();
    assert_eq!(kinds(&evs), vec!["turn_start"]);
    assert_eq!(evs[0].tokens_delta, Some(20));
    writer.execute("UPDATE session SET time_archived = ?2, time_updated = ?2 WHERE id = ?1", params!["N", (T0 + 20_000) as i64]).unwrap();
    let evs = poller.poll_at(&FakeIds, T0 + 21_000).unwrap();
    assert_eq!(kinds(&evs), vec!["session_end"]);
    assert!(poller.poll_at(&FakeIds, T0 + 23_000).unwrap().is_empty());
    check_events(&evs);
}

#[test]
fn only_session_id_and_clock_columns_are_ever_read_and_content_is_refused_by_the_authorizer() {
    let (_d, _p, writer, mut poller) = fresh();
    poller.rebuild_at(&FakeIds, T0).unwrap();
    touch(&writer, "A", T0 + 1_500, 150);
    poller.poll_at(&FakeIds, T0 + 2_000).unwrap();
    let read = poller.columns_read();
    assert!(!read.is_empty());
    for (t, c) in &read {
        assert_eq!(t, "session", "table {t} was read");
        assert!(ALLOWED_COLUMNS.contains(&c.as_str()) || c.is_empty(), "column {c} is not allowlisted");
    }
    // Column reads are what the authorizer sees. SQLite does not report reads that never
    // surface a column (count(*), length(col)); those are excluded by the fixed SQL text and
    // the query plan tests above, not by this guard.
    for refused in [
        "SELECT title FROM session", "SELECT directory FROM session", "SELECT summary_diffs FROM session", "SELECT * FROM session",
        "SELECT data FROM message", "SELECT data FROM part", "SELECT data FROM event",
        "SELECT seq FROM event_sequence", "SELECT worktree FROM project", "SELECT resource FROM permission",
    ] {
        assert!(poller.authorizer_refuses(refused), "authorizer allowed: {refused}");
    }
    assert!(!poller.authorizer_refuses("SELECT id, time_updated FROM session WHERE time_updated > 1"));

}

#[test]
fn no_canary_in_any_emitted_event() {
    let (_d, _p, writer, mut poller) = fresh();
    let mut all = poller.rebuild_at(&FakeIds, T0).unwrap();
    touch(&writer, "A", T0 + 1_500, 150);
    all.extend(poller.poll_at(&FakeIds, T0 + 2_000).unwrap());
    all.extend(poller.poll_at(&FakeIds, T0 + 100_000).unwrap());
    assert!(all.len() > 5);
    check_events(&all);
}

#[test]
fn the_database_file_is_never_modified_even_when_read_only() {
    let (_d, path, writer, mut poller) = fresh();
    writer.pragma_update(None, "wal_checkpoint", "TRUNCATE").unwrap();
    drop(writer);
    let before = std::fs::read(&path).unwrap();
    let mut perms = std::fs::metadata(&path).unwrap().permissions();
    perms.set_readonly(true);
    std::fs::set_permissions(&path, perms.clone()).unwrap();
    let evs = poller.rebuild_at(&FakeIds, T0).unwrap();
    assert!(!evs.is_empty(), "works on a read-only file");
    poller.poll_at(&FakeIds, T0 + 5_000).unwrap();
    perms.set_readonly(false);
    std::fs::set_permissions(&path, perms).unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), before);
}

#[test]
fn missing_corrupt_and_late_databases_do_not_panic_or_block() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("opencode.db");
    let mut poller = OpenCodePoller::new(cfg(&path));
    assert!(poller.poll_at(&FakeIds, T0).unwrap().is_empty(), "no OpenCode installed is not an error");
    std::fs::write(&path, b"this is not sqlite BHCANARY").unwrap();
    assert!(poller.poll_at(&FakeIds, T0 + 2_000).is_err());
    std::fs::remove_file(&path).unwrap();
    let rows = [Row { id: "A", parent: None, created: T0, updated: T0 + 3_000, tokens: 1 }];
    let (_p, _c) = build_db(dir.path(), &rows);
    let evs = poller.poll_at(&FakeIds, T0 + 5_000).unwrap();
    assert!(!evs.is_empty(), "recovers once the database appears");
}

#[test]
fn a_large_session_table_polls_fast() {
    let dir = tempfile::tempdir().unwrap();
    let (path, conn) = build_db(dir.path(), &[]);
    conn.execute_batch("BEGIN").unwrap();
    for i in 0..3600u64 {
        let id: &'static str = Box::leak(format!("s{i}").into_boxed_str());
        insert(&conn, &Row { id, parent: None, created: T0 - 90_000_000 - i, updated: T0 - 80_000_000 - i, tokens: 1 });
    }
    insert(&conn, &Row { id: "live", parent: None, created: T0 - 60_000, updated: T0 - 1_000, tokens: 1 });
    conn.execute_batch("COMMIT").unwrap();
    let mut poller = OpenCodePoller::new(cfg(&path));
    let t = std::time::Instant::now();
    let evs = poller.rebuild_at(&FakeIds, T0).unwrap();
    let first = t.elapsed();
    assert_eq!(kinds(&evs), vec!["session_start", "turn_start"]);
    let t = std::time::Instant::now();
    poller.poll_at(&FakeIds, T0 + 2_000).unwrap();
    println!("rebuild {first:?}, poll {:?} over 3601 sessions", t.elapsed());
    assert!(t.elapsed() < std::time::Duration::from_millis(100));
}

/// Optional smoke run against a real OpenCode database, structure only (counts and timings,
/// nothing else is printed). `BUSYHOLM_REAL_OPENCODE_DB=/path/opencode.db cargo test -- --ignored real_database`.
#[test]
#[ignore]
fn real_database_smoke() {
    let Ok(path) = std::env::var("BUSYHOLM_REAL_OPENCODE_DB") else { return };
    let before = std::fs::metadata(&path).unwrap().modified().unwrap();
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
    let mut poller = OpenCodePoller::new(PollConfig::new(PathBuf::from(&path)));
    let t = std::time::Instant::now();
    let evs = poller.rebuild_at(&FakeIds, now).unwrap();
    let first = t.elapsed();
    check_events(&evs);
    let mut counts = std::collections::BTreeMap::new();
    for k in kinds(&evs) { *counts.entry(k).or_insert(0) += 1; }
    let t = std::time::Instant::now();
    poller.poll_at(&FakeIds, now + 2_000).unwrap();
    println!("REAL DB: first look {first:?}, next poll {:?}, events by kind {counts:?}", t.elapsed());
    println!("REAL DB: tables read {:?}", poller.columns_read().iter().map(|(t, _)| t.clone()).collect::<std::collections::BTreeSet<_>>());
    assert_eq!(std::fs::metadata(&path).unwrap().modified().unwrap(), before, "main database file untouched");
}
