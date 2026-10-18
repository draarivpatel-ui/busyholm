//! World v1: the output of the pure function `world = grow(seed, ledger, choices)` (SPEC 4.5).
//!
//! Never saved: it is always re-derived.

use serde::{Deserialize, Serialize};

use crate::check;
use crate::validate::{ContractError, Validate};
use crate::common::{
    nullable, present, Day, MilestoneId, StructureId, Tool, Version,
};

/// Settlement size tier: camp under 6 progression structures, hamlet at 6, village at all 12.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Tier {
    Camp,
    Hamlet,
    Village,
}

/// A structure's build status.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StructureStatus {
    /// Not started.
    Planned,
    /// Affordable but held by an extra condition (a number of active days).
    Waiting,
    /// In progress.
    Building,
    Complete,
}

/// A structure variant: a tool (workshops), `guest_house` (workshop_2) or
/// `footbridge` / `jetty` (crossing).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StructureVariant {
    Claude,
    Codex,
    Opencode,
    Antigravity,
    Gemini,
    Cursor,
    Aider,
    Other,
    GuestHouse,
    Footbridge,
    Jetty,
}

/// Resource balances. May be fractional (planks earn 0.5 each past turn 20).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Resources {
    pub planks: f64,
    pub stone: f64,
    pub seeds: f64,
}

/// What a waiting structure is held by.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WaitingFor {
    /// Active days still needed (1 to 3650).
    pub active_days: u16,
}

/// One structure slot.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorldStructure {
    pub id: StructureId,
    /// Only workshop_1, workshop_2 and crossing have a variant. Omitted while undecided.
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
    pub variant: Option<StructureVariant>,
    pub status: StructureStatus,
    /// Visible build stage (0 to 3); 3 exactly when complete.
    pub stage: u8,
    /// Fraction of the cost delivered (0 to 1); 1 exactly when complete.
    pub progress: f64,
    /// Present exactly when status is `waiting`.
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
    pub waiting_for: Option<WaitingFor>,
    /// Present exactly when status is `complete`.
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
    pub completed_day: Option<Day>,
}

/// An owned decoration with its seeded slot.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorldDecoration {
    /// Decoration id from the economy config.
    pub id: String,
    /// Seeded decoration slot within the decoration zones (0 to 255).
    pub slot: u8,
    /// False means put away.
    pub shown: bool,
}

/// A milestone and the day it was reached.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MilestoneReached {
    pub id: MilestoneId,
    pub day: Day,
}

/// Lifetime statistics.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Stats {
    pub lifetime_turns: u32,
    pub active_days: u32,
    /// Current streak as of `as_of_day` (up to 2 rest days per calendar week do not break it).
    pub streak_days: u32,
    /// At most 8 unique tools.
    pub tools_seen: Vec<Tool>,
}

/// Engraved historical counts from the backfill.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FoundersStone {
    /// 1 to 31.
    pub days: u8,
    pub turns: u32,
    pub sessions: u32,
    pub working_hours: f64,
}

/// The derived world.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct World {
    /// Schema version, always 1.
    pub schema_version: Version<1>,
    pub seed: u32,
    /// The last local day the ledger and choices were folded through.
    pub as_of_day: Day,
    pub tier: Tier,
    /// Balances available to spend now.
    pub resources: Resources,
    /// Lifetime totals earned, including the founding crate and the capped backfill.
    pub earned: Resources,
    /// In the effective build order (at most 16, unique by id).
    pub structures: Vec<WorldStructure>,
    /// Owned decorations (at most 64, unique by id and by slot).
    pub decorations: Vec<WorldDecoration>,
    /// At most 7, unique by id.
    pub milestones: Vec<MilestoneReached>,
    pub stats: Stats,
    /// Engraved counts from the backfill; null when there was no backfill.
    #[serde(deserialize_with = "nullable")]
    pub founders_stone: Option<FoundersStone>,
    /// True when the Steam demo cap stopped building.
    pub demo_capped: bool,
}

fn validate_resources(path: &str, r: &Resources) -> Result<(), ContractError> {
    for (name, v) in [("planks", r.planks), ("stone", r.stone), ("seeds", r.seeds)] {
        check::num_range(&check::child(path, name), v, 0.0, 1_000_000_000.0)?;
    }
    Ok(())
}

/// True when `variant` is a tool (not guest_house, footbridge or jetty).
fn is_tool_variant(v: StructureVariant) -> bool {
    !matches!(
        v,
        StructureVariant::GuestHouse | StructureVariant::Footbridge | StructureVariant::Jetty
    )
}

fn validate_structure(s: &WorldStructure, path: &str) -> Result<(), ContractError> {
    check::int_range(&check::child(path, "stage"), u64::from(s.stage), 0, 3)?;
    check::num_range(&check::child(path, "progress"), s.progress, 0.0, 1.0)?;
    if let Some(w) = &s.waiting_for {
        check::int_range(
            &check::child(&check::child(path, "waiting_for"), "active_days"),
            u64::from(w.active_days),
            1,
            3650,
        )?;
    }
    if let Some(d) = &s.completed_day {
        check::day(&check::child(path, "completed_day"), d)?;
    }

    // complete: completed_day, stage 3, progress 1. Otherwise none of these.
    if s.status == StructureStatus::Complete {
        check::presence(path, "completed_day", s.completed_day.is_some(), true, "status is complete")?;
        check::ensure(s.stage == 3, &check::child(path, "stage"), "must be 3 when status is complete")?;
        check::ensure(s.progress == 1.0, &check::child(path, "progress"), "must be 1 when status is complete")?;
    } else {
        check::ensure(s.completed_day.is_none(), &check::child(path, "completed_day"), "only allowed when status is complete")?;
        check::ensure(s.stage <= 2, &check::child(path, "stage"), "must be at most 2 unless status is complete")?;
        check::ensure(s.progress < 1.0, &check::child(path, "progress"), "must be below 1 unless status is complete")?;
    }
    check::presence(
        path,
        "waiting_for",
        s.waiting_for.is_some(),
        s.status == StructureStatus::Waiting,
        "status is waiting",
    )?;

    // Variant sets per structure id.
    let vp = check::child(path, "variant");
    match s.id {
        StructureId::Workshop1 => {
            if let Some(v) = s.variant {
                check::ensure(is_tool_variant(v), &vp, "workshop_1 takes a tool variant")?;
            }
        }
        StructureId::Workshop2 => {
            if let Some(v) = s.variant {
                check::ensure(
                    is_tool_variant(v) || v == StructureVariant::GuestHouse,
                    &vp,
                    "workshop_2 takes a tool or guest_house",
                )?;
            }
        }
        StructureId::Crossing => {
            if let Some(v) = s.variant {
                check::ensure(
                    matches!(v, StructureVariant::Footbridge | StructureVariant::Jetty),
                    &vp,
                    "crossing takes footbridge or jetty",
                )?;
            }
        }
        _ => check::ensure(s.variant.is_none(), &vp, "only workshop_1, workshop_2 and crossing have a variant")?,
    }
    Ok(())
}

impl Validate for World {
    fn validate(&self) -> Result<(), ContractError> {
        check::day("/as_of_day", &self.as_of_day)?;
        validate_resources("/resources", &self.resources)?;
        validate_resources("/earned", &self.earned)?;

        check::max_items("/structures", self.structures.len(), 16)?;
        for (i, s) in self.structures.iter().enumerate() {
            validate_structure(s, &check::at("/structures", i))?;
        }
        check::unique_by("/structures", &self.structures, "id", |s| s.id)?;

        check::max_items("/decorations", self.decorations.len(), 64)?;
        for (i, d) in self.decorations.iter().enumerate() {
            check::pattern(
                &check::child(&check::at("/decorations", i), "id"),
                &d.id,
                check::is_decoration_id,
                "^[a-z][a-z0-9_]{1,31}$",
            )?;
        }
        check::unique_by("/decorations", &self.decorations, "id", |d| d.id.as_str())?;
        check::unique_by("/decorations", &self.decorations, "slot", |d| d.slot)?;

        check::max_items("/milestones", self.milestones.len(), 7)?;
        for (i, m) in self.milestones.iter().enumerate() {
            check::day(&check::child(&check::at("/milestones", i), "day"), &m.day)?;
        }
        check::unique_by("/milestones", &self.milestones, "id", |m| m.id)?;

        let st = &self.stats;
        for (name, v) in [
            ("lifetime_turns", st.lifetime_turns),
            ("active_days", st.active_days),
            ("streak_days", st.streak_days),
        ] {
            check::int_range(&check::child("/stats", name), u64::from(v), 0, 1_000_000_000)?;
        }
        check::max_items("/stats/tools_seen", st.tools_seen.len(), 8)?;
        check::unique_items("/stats/tools_seen", &st.tools_seen)?;

        if let Some(f) = &self.founders_stone {
            check::int_range("/founders_stone/days", u64::from(f.days), 1, 31)?;
            check::int_range("/founders_stone/turns", u64::from(f.turns), 0, 1_000_000_000)?;
            check::int_range("/founders_stone/sessions", u64::from(f.sessions), 0, 1_000_000_000)?;
            check::num_range("/founders_stone/working_hours", f.working_hours, 0.0, 1_000_000.0)?;
        }
        Ok(())
    }
}
