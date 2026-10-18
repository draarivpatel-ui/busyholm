//! WP-06 acceptance test 4 (static half): the scanner never reads another process's argument
//! list. Also: nothing in this crate opens the network or a never-open path.
use std::path::Path;

fn src_files() -> Vec<(String, String)> {
    let mut out = Vec::new();
    fn walk(dir: &Path, out: &mut Vec<(String, String)>) {
        for e in std::fs::read_dir(dir).unwrap() {
            let p = e.unwrap().path();
            if p.is_dir() { walk(&p, out); }
            else if p.extension().map_or(false, |x| x == "rs") {
                out.push((p.display().to_string(), std::fs::read_to_string(&p).unwrap()));
            }
        }
    }
    walk(&Path::new(env!("CARGO_MANIFEST_DIR")).join("src"), &mut out);
    out
}

/// Source with comments removed (line and doc comments); string literals stay, so a banned
/// word in a string still fails.
fn code_only(s: &str) -> String {
    s.lines().map(|l| match l.find("//") { Some(i) if !l[..i].contains('"') => &l[..i], _ => l }).collect::<Vec<_>>().join("\n")
}

fn assert_absent(files: &[(String, String)], needles: &[&str], scope: &str) {
    for (name, text) in files {
        let code = code_only(text).to_lowercase();
        for n in needles {
            assert!(!code.contains(&n.to_lowercase()), "{scope}: {name} contains {n}");
        }
    }
}

#[test]
fn the_process_scanner_has_no_code_path_that_reads_argument_lists() {
    let files: Vec<_> = src_files().into_iter().filter(|(n, _)| n.replace('\\', "/").contains("procscan")).collect();
    assert!(files.len() >= 4, "mod, mac, linux, windows: {}", files.len());
    assert_absent(&files, &[
        "KERN_PROCARGS", "PROCARGS", "cmdline", "CommandLine", "argv", "Win32_Process", "wmic", "ReadProcessMemory",
        "NtQueryInformationProcess", "ProcessEnvironmentBlock", "std::env::args", "Command::new", "std::process", "PROC_PIDARGS", "sysctl",
    ], "procscan");
    // positive control: the strong form of the check actually looks at the code
    let all: String = files.iter().map(|(_, t)| code_only(t)).collect();
    assert!(all.contains("proc_pidpath") && all.contains("PROC_PIDTBSDINFO"), "macOS path uses libproc path and start-time info only");
    assert!(all.contains("/stat") || all.contains("stat"), "Linux path reads stat");
    assert!(all.contains("CreateToolhelp32Snapshot") && all.contains("GetProcessTimes"), "Windows path uses the toolhelp snapshot and process times");
}

#[test]
fn the_check_would_catch_a_violation() {
    let bad = vec![("x.rs".to_string(), "fn f(){ let c = std::fs::read(\"/proc/1/cmdline\"); }".to_string())];
    let r = std::panic::catch_unwind(|| assert_absent(&bad, &["cmdline"], "t"));
    assert!(r.is_err());
    let commented = vec![("x.rs".to_string(), "// we never read cmdline\nfn f(){}".to_string())];
    assert_absent(&commented, &["cmdline"], "t");
}

#[test]
fn nothing_in_the_crate_touches_the_network() {
    assert_absent(&src_files(), &["std::net", "TcpStream", "TcpListener", "UdpSocket", "reqwest", "hyper", "ureq", "http://", "https://"], "no network");
}

#[test]
fn the_readers_name_no_never_open_path() {
    let files: Vec<_> = src_files().into_iter().filter(|(n, _)| { let n = n.replace('\\', "/"); n.ends_with("agy.rs") || n.ends_with("opencode_poll.rs") || n.ends_with("procscan/mod.rs") }).collect();
    assert_eq!(files.len(), 3);
    assert_absent(&files, &["oauth", "history.jsonl", "auth.json", "credential", ".credentials", "conversations", "keychain", "tool-results"], "never-open");
}

#[test]
fn the_sqlite_poller_never_opens_read_write() {
    let (_, text) = src_files().into_iter().find(|(n, _)| n.ends_with("opencode_poll.rs")).unwrap();
    let code = code_only(&text);
    assert!(code.contains("SQLITE_OPEN_READ_ONLY"));
    assert!(code.contains("query_only"));
    for banned in ["SQLITE_OPEN_READ_WRITE", "SQLITE_OPEN_CREATE", "execute_batch", "INSERT", "UPDATE", "DELETE", "journal_mode", "wal_checkpoint"] {
        assert!(!code.contains(banned), "poller contains {banned}");
    }
}
