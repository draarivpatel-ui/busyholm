//! Shared enums, type aliases and serde helpers used by several contracts.

use std::fmt;

use serde::de::{Deserializer, Error as DeError};
use serde::{Deserialize, Serialize, Serializer};

/// Milliseconds since the Unix epoch (UTC), always an integer.
pub type Ms = u64;
/// A local calendar day, `YYYY-MM-DD`.
pub type Day = String;
/// Salted hash of a session or thread id: 32 lowercase hex characters.
pub type InstanceId = String;
/// Lowercase hex SHA-256 digest (64 characters).
pub type Sha256Hex = String;
/// A local time of day, `HH:MM` (24 hour clock).
pub type Hhmm = String;

/// Deserializer for a required property whose value may be `null`.
///
/// Used with `#[serde(deserialize_with = "crate::common::nullable")]` on an
/// `Option<T>` field. Because `deserialize_with` is present, serde no longer
/// defaults a missing field to `None`: a missing field is an error and an
/// explicit `null` is accepted.
pub fn nullable<'de, D, T>(d: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(d)
}

/// Deserializer for an optional property that must never be `null`.
///
/// Used together with `#[serde(default, skip_serializing_if = "Option::is_none")]`.
/// A missing field is `None`; an explicit `null` is an error because `T` is
/// deserialized directly and wrapped in `Some`.
pub fn present<'de, D, T>(d: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(d).map(Some)
}

/// A `const` version field: serializes as the integer `N` and rejects any other value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub struct Version<const N: u8>;

impl<const N: u8> Serialize for Version<N> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_u8(N)
    }
}

impl<'de, const N: u8> Deserialize<'de> for Version<N> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let n = u64::deserialize(d)?;
        if n == u64::from(N) {
            Ok(Version)
        } else {
            Err(D::Error::custom(format!("expected version {N}, got {n}")))
        }
    }
}

/// A `const: false` field (`privacy.containsText`): only `false` deserializes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub struct ContainsTextFalse;

impl Serialize for ContainsTextFalse {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_bool(false)
    }
}

impl<'de> Deserialize<'de> for ContainsTextFalse {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl serde::de::Visitor<'_> for V {
            type Value = ContainsTextFalse;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("the boolean false")
            }
            fn visit_bool<E: DeError>(self, v: bool) -> Result<Self::Value, E> {
                if v {
                    Err(E::custom("containsText must be false"))
                } else {
                    Ok(ContainsTextFalse)
                }
            }
        }
        d.deserialize_bool(V)
    }
}

/// The `privacy` object of the ledger and choices files: `{ "containsText": false }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Privacy {
    /// Always `false`: the file never holds text.
    #[serde(rename = "containsText")]
    pub contains_text: ContainsTextFalse,
}

impl Default for Privacy {
    fn default() -> Self {
        Privacy { contains_text: ContainsTextFalse }
    }
}

/// The agent tools Busyholm knows about.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Tool {
    Claude,
    Codex,
    Opencode,
    Antigravity,
    Gemini,
    Cursor,
    Aider,
    Other,
}

/// Where the agent runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Host {
    Cli,
    Desktop,
    Vscode,
    Sdk,
    Ide,
    Other,
}

/// Whether a fact was reported by the source or inferred.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Confidence {
    Exact,
    Inferred,
}

/// A provider that reports usage limits (only Claude and Codex in v0.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Provider {
    Claude,
    Codex,
}

/// A usage window.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub enum Window {
    #[serde(rename = "5h")]
    FiveHour,
    #[serde(rename = "weekly")]
    Weekly,
}

/// A usage window as reported by a limit hit, where it may be unknown.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub enum LimitWindow {
    #[serde(rename = "5h")]
    FiveHour,
    #[serde(rename = "weekly")]
    Weekly,
    #[serde(rename = "unknown")]
    Unknown,
}

/// What a working agent is doing, derived from the tool NAME only.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Activity {
    Shell,
    Edit,
    Read,
    Web,
    Delegate,
    Other,
}

/// Why an agent needs the user.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NeedsYouReason {
    Permission,
    Question,
}

/// Structure slots (SPEC 4.5). The 12 progression structures are `noticeboard`
/// through `market_hall`; `campfire` and `tent` are free on day 1; `bell_post`
/// arrives with the hooks; `founders_stone` comes from the history backfill.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub enum StructureId {
    #[serde(rename = "campfire")]
    Campfire,
    #[serde(rename = "tent")]
    Tent,
    #[serde(rename = "bell_post")]
    BellPost,
    #[serde(rename = "noticeboard")]
    Noticeboard,
    #[serde(rename = "workshop_1")]
    Workshop1,
    #[serde(rename = "well")]
    Well,
    #[serde(rename = "cottage_1")]
    Cottage1,
    #[serde(rename = "garden_plots")]
    GardenPlots,
    #[serde(rename = "crossing")]
    Crossing,
    #[serde(rename = "watermill")]
    Watermill,
    #[serde(rename = "workshop_2")]
    Workshop2,
    #[serde(rename = "cottage_2")]
    Cottage2,
    #[serde(rename = "bell_tower")]
    BellTower,
    #[serde(rename = "bakery")]
    Bakery,
    #[serde(rename = "market_hall")]
    MarketHall,
    #[serde(rename = "founders_stone")]
    FoundersStone,
}

/// The 12 progression structures (`noticeboard` through `market_hall`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub enum ProgressionStructureId {
    #[serde(rename = "noticeboard")]
    Noticeboard,
    #[serde(rename = "workshop_1")]
    Workshop1,
    #[serde(rename = "well")]
    Well,
    #[serde(rename = "cottage_1")]
    Cottage1,
    #[serde(rename = "garden_plots")]
    GardenPlots,
    #[serde(rename = "crossing")]
    Crossing,
    #[serde(rename = "watermill")]
    Watermill,
    #[serde(rename = "workshop_2")]
    Workshop2,
    #[serde(rename = "cottage_2")]
    Cottage2,
    #[serde(rename = "bell_tower")]
    BellTower,
    #[serde(rename = "bakery")]
    Bakery,
    #[serde(rename = "market_hall")]
    MarketHall,
}

/// SPEC 4.5 milestones: first plank ceremony, ribbon on the bell, helpers
/// appear, bridge festival, fireworks, kite day, statue.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub enum MilestoneId {
    #[serde(rename = "first_turn")]
    FirstTurn,
    #[serde(rename = "first_answer")]
    FirstAnswer,
    #[serde(rename = "first_subagent")]
    FirstSubagent,
    #[serde(rename = "two_tools_day")]
    TwoToolsDay,
    #[serde(rename = "turns_100")]
    Turns100,
    #[serde(rename = "streak_7")]
    Streak7,
    #[serde(rename = "turns_1000")]
    Turns1000,
}

/// Resident species (per-tool overrides in settings).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Species {
    Beaver,
    Otter,
    Frog,
    Hare,
    Mole,
    Heron,
    Hedgehog,
}
