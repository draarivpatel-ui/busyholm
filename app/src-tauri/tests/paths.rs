//! App data folder per SPEC 6.8, with a test override.
use std::path::PathBuf;

use busyholm_app::geometry::Os;
use busyholm_app::paths::*;

#[test]
fn spec_folders_per_os() {
    let home = Some(PathBuf::from("/Users/u"));
    assert_eq!(data_dir_for(Os::MacOs, home.clone(), None, None), Some(PathBuf::from("/Users/u/Library/Application Support/Busyholm")));
    assert_eq!(data_dir_for(Os::Windows, None, Some(PathBuf::from(r"C:\Users\u\AppData\Roaming")), None),
        Some(PathBuf::from(r"C:\Users\u\AppData\Roaming").join("Busyholm")));
    assert_eq!(data_dir_for(Os::Linux, Some(PathBuf::from("/home/u")), None, Some(PathBuf::from("/x/data"))), Some(PathBuf::from("/x/data/busyholm")));
    assert_eq!(data_dir_for(Os::Linux, Some(PathBuf::from("/home/u")), None, None), Some(PathBuf::from("/home/u/.local/share/busyholm")));
    assert_eq!(data_dir_for(Os::Linux, None, None, None), None);
}

#[test]
fn explicit_override_wins() {
    assert_eq!(data_dir(Some(PathBuf::from("/tmp/bh-test"))), Some(PathBuf::from("/tmp/bh-test")));
}
