//! World inputs for the pages (WP-10 runs `grow(seed, ledger, choices)` in the page; the core cannot
//! run TypeScript). The core reads `ledger.json` (written by the collector) and `choices.json` from
//! the SPEC 6.8 data folder, validates both against the contracts and hands pages
//! `{ seed, ledger, choices }`. It never writes either file.
use std::path::{Path, PathBuf};

use busyholm_contracts::{Choices, Ledger};
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct WorldInputs {
    pub seed: u32,
    pub ledger: Ledger,
    pub choices: Choices,
}

/// Choices v1 with an empty log (no build-order or decoration choices made yet).
pub fn empty_choices() -> Choices {
    Choices { schema_version: Default::default(), privacy: Default::default(), log: Vec::new() }
}

/// Files are read with a size cap (the collector caps the ledger at 32 MiB itself).
const MAX_BYTES: u64 = 32 * 1024 * 1024;

fn read_valid<T: serde::de::DeserializeOwned + busyholm_contracts::Validate>(path: &Path) -> Option<T> {
    if std::fs::metadata(path).ok()?.len() > MAX_BYTES {
        return None;
    }
    busyholm_contracts::from_json::<T>(&std::fs::read_to_string(path).ok()?).ok()
}

/// `ledger.json` if present and valid against Ledger v1; otherwise None.
pub fn load_ledger(dir: &Path) -> Option<Ledger> {
    read_valid(&dir.join("ledger.json"))
}

/// `choices.json` if present and valid against Choices v1; otherwise the empty log.
pub fn load_choices(dir: &Path) -> Choices {
    read_valid(&dir.join("choices.json")).unwrap_or_else(empty_choices)
}

/// None until a ledger exists (the seed lives in the ledger).
pub fn inputs(ledger: Option<Ledger>, choices: Choices) -> Option<WorldInputs> {
    ledger.map(|l| WorldInputs { seed: l.seed, ledger: l, choices })
}

/// Modification stamp of a file (time and length), to notice a rewrite without reading it.
pub fn stamp(path: &Path) -> Option<(std::time::SystemTime, u64)> {
    let m = std::fs::metadata(path).ok()?;
    Some((m.modified().ok()?, m.len()))
}

type Stamp = Option<(std::time::SystemTime, u64)>;

/// What the core last knew and last sent. Ledgers arrive from the collector (its output, or its
/// periodic rewrite of `ledger.json`); choices from `choices.json`.
pub struct Tracker {
    dir: PathBuf,
    ledger: Option<Ledger>,
    choices: Choices,
    stamps: (Stamp, Stamp),
    last_sent: Option<String>,
}

impl Tracker {
    pub fn new(dir: PathBuf) -> Self {
        let stamps = (stamp(&dir.join("ledger.json")), stamp(&dir.join("choices.json")));
        Tracker { ledger: load_ledger(&dir), choices: load_choices(&dir), stamps, last_sent: None, dir }
    }

    pub fn current(&self) -> Option<WorldInputs> {
        inputs(self.ledger.clone(), self.choices.clone())
    }

    pub fn set_ledger(&mut self, l: Ledger) {
        self.ledger = Some(l);
    }

    pub fn clear(&mut self) {
        self.ledger = None;
        self.choices = empty_choices();
        self.stamps = (None, None);
        self.last_sent = None;
    }

    /// Re-reads a file whose stamp changed. True when something was reloaded.
    pub fn refresh_files(&mut self) -> bool {
        let (ls, cs) = (stamp(&self.dir.join("ledger.json")), stamp(&self.dir.join("choices.json")));
        let mut changed = false;
        if ls != self.stamps.0 {
            self.stamps.0 = ls;
            let next = load_ledger(&self.dir);
            if next != self.ledger {
                self.ledger = next;
                changed = true;
            }
        }
        if cs != self.stamps.1 {
            self.stamps.1 = cs;
            self.choices = load_choices(&self.dir);
            changed = true;
        }
        changed
    }

    /// The inputs to send, when they differ from what was sent last.
    pub fn take_if_changed(&mut self) -> Option<WorldInputs> {
        let w = self.current()?;
        let key = serde_json::to_string(&w).ok()?;
        if self.last_sent.as_deref() == Some(key.as_str()) {
            return None;
        }
        self.last_sent = Some(key);
        Some(w)
    }
}
