//! Settings v1 store: defaults on first run (SPEC 6.9 and Revision 1), atomic round trip, invalid
//! values refused, a corrupt file replaced but kept for inspection.
mod common;

use busyholm_app::settings::*;
use busyholm_contracts::settings::{LayerMode, StripDisplay};
use busyholm_contracts::Validate;

#[test]
fn first_run_writes_the_defaults() {
    let dir = common::temp_dir("settings-first");
    let (store, note) = SettingsStore::load(&dir).unwrap();
    assert_eq!(note, LoadNote::Created);
    assert!(dir.join("settings.json").exists());
    let s = store.get();
    assert!(s.validate().is_ok());
    assert_eq!(*s, defaults());
    assert!(s.strip.enabled);
    assert_eq!(s.strip.height, 112);
    assert_eq!(s.strip.layer_mode, LayerMode::OnTop);
    assert_eq!(s.strip.display, StripDisplay::Auto {});
    assert!(s.strip.hover_fade);
    assert!(!s.strip.show_over_fullscreen);
    assert_eq!(s.ambient.idle_minutes, None, "ambient is manual by default (Revision 1)");
    assert!(!s.other.launch_at_login, "autostart is off by default");
    let (again, note) = SettingsStore::load(&dir).unwrap();
    assert_eq!(note, LoadNote::Loaded);
    assert_eq!(again.get(), store.get());
}

#[test]
fn set_round_trips_atomically() {
    let dir = common::temp_dir("settings-rt");
    let (mut store, _) = SettingsStore::load(&dir).unwrap();
    let mut s = store.get().clone();
    s.strip.layer_mode = LayerMode::BehindWindows;
    s.strip.height = 96;
    s.other.launch_at_login = true;
    store.set(s.clone()).unwrap();
    assert_eq!(store.get(), &s);
    let (reloaded, _) = SettingsStore::load(&dir).unwrap();
    assert_eq!(reloaded.get(), &s);
    let leftovers: Vec<_> = std::fs::read_dir(&dir).unwrap().filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().to_string()).filter(|n| n != "settings.json").collect();
    assert!(leftovers.is_empty(), "no temp files left: {leftovers:?}");
}

#[test]
fn invalid_settings_are_refused_and_the_file_is_untouched() {
    let dir = common::temp_dir("settings-bad");
    let (mut store, _) = SettingsStore::load(&dir).unwrap();
    let before = std::fs::read(dir.join("settings.json")).unwrap();
    let mut s = store.get().clone();
    s.strip.height = 250;
    assert!(store.set(s).is_err());
    assert_eq!(std::fs::read(dir.join("settings.json")).unwrap(), before);
    assert_eq!(store.get().strip.height, 112);
}

#[test]
fn a_corrupt_file_is_replaced_by_defaults_and_kept_aside() {
    let dir = common::temp_dir("settings-corrupt");
    std::fs::write(dir.join("settings.json"), b"{ not json").unwrap();
    let (store, note) = SettingsStore::load(&dir).unwrap();
    assert_eq!(note, LoadNote::ReplacedCorrupt);
    assert_eq!(*store.get(), defaults());
    let kept = std::fs::read_dir(&dir).unwrap().filter_map(|e| e.ok())
        .any(|e| e.file_name().to_string_lossy().starts_with("settings.json.corrupt"));
    assert!(kept, "the corrupt file is kept for inspection");
}
