//! Choices v1: `choices.json` in the app data folder (SPEC 6.8).
//!
//! An append-only log of the user's build-order and decoration choices, the
//! third input of `world = grow(seed, ledger, choices)`.

use serde::{Deserialize, Serialize};

use crate::check;
use crate::validate::{ContractError, Validate};
use crate::common::{Day, Ms, Privacy, ProgressionStructureId, Version};

/// One logged choice. Internally tagged on `kind`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ChoiceEntry {
    /// The user set a build priority order.
    BuildOrder {
        t: Ms,
        /// Local day when the choice was made.
        day: Day,
        /// The priority order (1 to 12 unique entries); unlisted structures keep default order after.
        order: Vec<ProgressionStructureId>,
    },
    /// The user placed or put away a decoration.
    Decoration {
        t: Ms,
        /// Local day when the choice was made.
        day: Day,
        /// Decoration id from the economy config.
        decoration: String,
        /// True to place it (buying it if not yet owned), false to put it away.
        on: bool,
    },
}

/// The choices file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Choices {
    /// Schema version, always 1.
    pub schema_version: Version<1>,
    pub privacy: Privacy,
    /// Oldest first, at most 10000 entries.
    pub log: Vec<ChoiceEntry>,
}

impl Validate for Choices {
    fn validate(&self) -> Result<(), ContractError> {
        check::max_items("/log", self.log.len(), 10_000)?;
        for (i, entry) in self.log.iter().enumerate() {
            let p = check::at("/log", i);
            match entry {
                ChoiceEntry::BuildOrder { t, day, order } => {
                    check::ms(&check::child(&p, "t"), *t)?;
                    check::day(&check::child(&p, "day"), day)?;
                    let op = check::child(&p, "order");
                    check::items_range(&op, order.len(), 1, 12)?;
                    check::unique_items(&op, order)?;
                }
                ChoiceEntry::Decoration { t, day, decoration, .. } => {
                    check::ms(&check::child(&p, "t"), *t)?;
                    check::day(&check::child(&p, "day"), day)?;
                    check::pattern(
                        &check::child(&p, "decoration"),
                        decoration,
                        check::is_decoration_id,
                        "^[a-z][a-z0-9_]{1,31}$",
                    )?;
                }
            }
        }
        Ok(())
    }
}
