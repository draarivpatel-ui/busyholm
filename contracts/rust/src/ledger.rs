//! Ledger v1: `ledger.json` and `demo-ledger.json` in the app data folder (SPEC 6.8).
//!
//! Counts only: raw per-day, per-tool counters that `grow()` turns into resources.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::check;
use crate::validate::{ContractError, Validate};
use crate::common::{nullable, present, Day, Ms, Privacy, Tool, Version};

/// Raw counters for one tool on one day.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Counts {
    /// Completed main-session turns (`turn_end`).
    pub turns: u32,
    pub interrupted_turns: u32,
    /// Main sessions started.
    pub sessions: u32,
    /// Wall-clock seconds during which at least one main session of this tool was
    /// working; concurrent sessions are not summed (max 90000).
    pub working_seconds: u32,
    /// `needs_you` episodes (informational only).
    pub needs_you: u32,
    pub errors: u32,
    /// Turns started after an error.
    pub recovered: u32,
    pub limit_hits: u32,
    pub subagent_turns: u32,
}

/// Counts keyed by local day, then by tool.
pub type LedgerDays = BTreeMap<Day, BTreeMap<Tool, Counts>>;

/// The day-level union of working time across tools (optional `day_totals`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DayTotals {
    /// Wall-clock seconds during which at least one main session of ANY tool was
    /// working (max 90000).
    pub working_seconds: u32,
}

/// Day totals keyed by local day.
pub type LedgerDayTotals = BTreeMap<Day, DayTotals>;

/// The opt-in history import (SPEC 4.5), kept apart from live days.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Backfill {
    pub imported_at: Ms,
    /// At most 31 days.
    pub days: LedgerDays,
}

/// The persistent counts file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Ledger {
    /// Schema version, always 1.
    pub schema_version: Version<1>,
    pub privacy: Privacy,
    /// World seed, an unsigned 32-bit integer.
    pub seed: u32,
    /// Local day of first launch: the founding crate arrives on it.
    pub founded_day: Day,
    /// Local day the first agent's hooks were connected; null until it happens.
    #[serde(deserialize_with = "nullable")]
    pub hooks_first_connected_day: Option<Day>,
    /// A day appears only once something was counted on it.
    pub days: LedgerDays,
    /// Optional per-day union of working time across tools; absent means the older
    /// v1 shape (never null).
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
    pub day_totals: Option<LedgerDayTotals>,
    /// The history import; null when never imported.
    #[serde(deserialize_with = "nullable")]
    pub backfill: Option<Backfill>,
}

fn validate_days(path: &str, days: &LedgerDays, max_days: usize) -> Result<(), ContractError> {
    check::ensure(
        days.len() <= max_days,
        path,
        format!("must have at most {max_days} days, got {}", days.len()),
    )?;
    for (day, tools) in days {
        let dp = check::child(path, day);
        check::day(&dp, day)?;
        check::ensure(!tools.is_empty(), &dp, "must list at least 1 tool")?;
        for (tool, c) in tools {
            let tp = check::child(&dp, &format!("{tool:?}").to_lowercase());
            let count = |name: &str, v: u32| check::int_range(&check::child(&tp, name), u64::from(v), 0, 1_000_000);
            count("turns", c.turns)?;
            count("interrupted_turns", c.interrupted_turns)?;
            count("sessions", c.sessions)?;
            check::int_range(&check::child(&tp, "working_seconds"), u64::from(c.working_seconds), 0, 90_000)?;
            count("needs_you", c.needs_you)?;
            count("errors", c.errors)?;
            count("recovered", c.recovered)?;
            count("limit_hits", c.limit_hits)?;
            count("subagent_turns", c.subagent_turns)?;
        }
    }
    Ok(())
}

fn validate_day_totals(path: &str, totals: &LedgerDayTotals) -> Result<(), ContractError> {
    check::ensure(
        totals.len() <= 40_000,
        path,
        format!("must have at most 40000 days, got {}", totals.len()),
    )?;
    for (day, t) in totals {
        let dp = check::child(path, day);
        check::day(&dp, day)?;
        check::int_range(&check::child(&dp, "working_seconds"), u64::from(t.working_seconds), 0, 90_000)?;
    }
    Ok(())
}

impl Validate for Ledger {
    fn validate(&self) -> Result<(), ContractError> {
        check::day("/founded_day", &self.founded_day)?;
        if let Some(d) = &self.hooks_first_connected_day {
            check::day("/hooks_first_connected_day", d)?;
        }
        validate_days("/days", &self.days, 40_000)?;
        if let Some(t) = &self.day_totals {
            validate_day_totals("/day_totals", t)?;
        }
        if let Some(b) = &self.backfill {
            check::ms("/backfill/imported_at", b.imported_at)?;
            validate_days("/backfill/days", &b.days, 31)?;
        }
        Ok(())
    }
}
