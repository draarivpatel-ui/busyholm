//! Command-line flags (development and acceptance tests; none is needed in normal use).
use std::path::PathBuf;

#[derive(Debug, Clone, Default)]
pub struct Opts {
    pub data_dir: Option<PathBuf>,
    pub test_log: Option<PathBuf>,
    /// `Some(dir)`: replay contract fixtures from `dir`.
    pub mock: Option<PathBuf>,
    pub mock_static: bool,
    /// With `--mock-static`: the snapshot fixture whose file name contains this text.
    pub mock_fixture: Option<String>,
    /// Test hook: close the ambient window this many seconds after it opens.
    pub test_close_ambient_after: Option<f64>,
    pub strip_page: Option<String>,
    pub test_freeze: bool,
    pub test_fixed_rect: bool,
    pub layer: Option<String>,
    pub open: Vec<String>,
    pub oracle: bool,
    pub exit_after: Option<f64>,
    /// Force the single-instance guard on even with a data-folder override (tests).
    pub single_instance: bool,
}

/// The repo's contract fixtures, for the mock collector in development builds.
pub fn repo_fixtures() -> PathBuf {
    #[cfg(debug_assertions)]
    {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("fixtures").join("contracts")
    }
    #[cfg(not(debug_assertions))]
    {
        PathBuf::from("fixtures").join("contracts")
    }
}

pub fn parse<I: IntoIterator<Item = String>>(args: I) -> Opts {
    let args: Vec<String> = args.into_iter().collect();
    let mut o = Opts::default();
    let mut i = 1;
    while i < args.len() {
        let next = args.get(i + 1).cloned();
        let takes = |n: &Option<String>| n.as_ref().map(|v| !v.starts_with("--")).unwrap_or(false);
        match args[i].as_str() {
            "--data-dir" if takes(&next) => { o.data_dir = next.map(PathBuf::from); i += 1; }
            "--test-log" if takes(&next) => { o.test_log = next.map(PathBuf::from); i += 1; }
            "--mock-collector" => {
                if takes(&next) { o.mock = next.map(PathBuf::from); i += 1; } else { o.mock = Some(repo_fixtures()); }
            }
            "--mock-static" => o.mock_static = true,
            "--mock-fixture" if takes(&next) => { o.mock_fixture = next; o.mock_static = true; i += 1; }
            "--test-close-ambient-after" if takes(&next) => { o.test_close_ambient_after = next.and_then(|v| v.parse().ok()); i += 1; }
            "--strip-page" if takes(&next) => { o.strip_page = next; i += 1; }
            "--test-freeze" => o.test_freeze = true,
            "--test-fixed-rect" => o.test_fixed_rect = true,
            "--layer" if takes(&next) => { o.layer = next; i += 1; }
            "--open" if takes(&next) => { o.open.extend(next); i += 1; }
            "--oracle" => o.oracle = true,
            "--single-instance" => o.single_instance = true,
            "--exit-after" if takes(&next) => { o.exit_after = next.and_then(|v| v.parse().ok()); i += 1; }
            _ => {} // unknown flags (and the macOS -psn_ argument) are ignored
        }
        i += 1;
    }
    o
}
