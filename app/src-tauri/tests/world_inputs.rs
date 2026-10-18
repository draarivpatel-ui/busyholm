//! World inputs for pages: { seed, ledger, choices } from the data folder, validated, never written.
mod common;

use busyholm_app::world_inputs::*;
use busyholm_contracts::{Choices, Ledger, Validate};

fn fixture(contract: &str, name: &str) -> String {
    std::fs::read_to_string(common::fixtures_dir().join(contract).join("valid").join(name)).unwrap()
}

#[test]
fn empty_choices_are_valid_and_empty() {
    let c = empty_choices();
    assert!(c.validate().is_ok());
    assert!(c.log.is_empty());
    let v = serde_json::to_value(&c).unwrap();
    assert_eq!(v["privacy"]["containsText"], false);
}

#[test]
fn loads_valid_files_and_derives_the_seed_from_the_ledger() {
    let dir = common::temp_dir("world-ok");
    std::fs::write(dir.join("ledger.json"), fixture("ledger.v1", "002-one-claude-day.json")).unwrap();
    std::fs::write(dir.join("choices.json"), fixture("choices.v1", "002-order-only-noticeboard.json")).unwrap();
    let ledger = load_ledger(&dir).expect("valid ledger loads");
    let choices = load_choices(&dir);
    assert!(!choices.log.is_empty(), "the choices file is used");
    let w = inputs(Some(ledger.clone()), choices.clone()).expect("inputs once a ledger exists");
    assert_eq!(w.seed, ledger.seed);
    let v = serde_json::to_value(&w).unwrap();
    let mut keys: Vec<_> = v.as_object().unwrap().keys().cloned().collect();
    keys.sort();
    assert_eq!(keys, vec!["choices", "ledger", "seed"]);
    assert!(serde_json::from_value::<Ledger>(v["ledger"].clone()).is_ok());
    assert!(serde_json::from_value::<Choices>(v["choices"].clone()).is_ok());
}

#[test]
fn missing_or_invalid_files_never_reach_pages() {
    let dir = common::temp_dir("world-bad");
    assert!(load_ledger(&dir).is_none(), "no ledger yet");
    assert!(load_choices(&dir).log.is_empty(), "no choices file means no choices");
    std::fs::write(dir.join("ledger.json"), b"{ \"schema_version\": 1 }").unwrap();
    std::fs::write(dir.join("choices.json"), b"not json").unwrap();
    assert!(load_ledger(&dir).is_none(), "invalid ledger is ignored");
    assert!(load_choices(&dir).log.is_empty(), "invalid choices fall back to empty");
    assert!(inputs(None, empty_choices()).is_none(), "no world inputs before the first ledger");
}

#[test]
fn tracker_sends_only_changes_and_notices_rewritten_files() {
    let dir = common::temp_dir("world-tracker");
    let mut t = Tracker::new(dir.clone());
    assert!(t.current().is_none());
    assert!(t.take_if_changed().is_none(), "nothing to send before a ledger");
    let l1: Ledger = busyholm_contracts::from_json(&fixture("ledger.v1", "002-one-claude-day.json")).unwrap();
    t.set_ledger(l1.clone());
    let first = t.take_if_changed().expect("first ledger is sent");
    assert_eq!(first.seed, l1.seed);
    assert!(t.take_if_changed().is_none(), "unchanged inputs are not sent again");
    t.set_ledger(l1.clone());
    assert!(t.take_if_changed().is_none(), "the same ledger again is not a change");
    // The collector rewrites ledger.json; a user choice lands in choices.json.
    std::fs::write(dir.join("choices.json"), fixture("choices.v1", "002-order-only-noticeboard.json")).unwrap();
    assert!(t.refresh_files(), "a new choices file is noticed");
    let next = t.take_if_changed().expect("changed choices are sent");
    assert!(!next.choices.log.is_empty());
    assert!(!t.refresh_files(), "no change, no reload");
}
