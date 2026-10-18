//! HitRects v1: sent by the strip webview to the core when interactive objects move (SPEC 6.2, 6.3).
//!
//! The core makes the strip click-through everywhere except inside these rectangles.

use serde::{Deserialize, Serialize};

use crate::check;
use crate::validate::{ContractError, Validate};
use crate::common::{present, InstanceId, Ms, Version};

/// Which surface sent the rectangles. Only the strip is partly click-through in v0.1.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Surface {
    Strip,
}

/// Diagnostic kind of a rectangle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RectKind {
    Resident,
    Building,
    Bell,
    Card,
    Ui,
    Other,
}

/// The webview's content size in logical (CSS) pixels when the rects were measured.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Viewport {
    /// Width, greater than 0 and at most 16384.
    pub w: f64,
    /// Height, greater than 0 and at most 16384.
    pub h: f64,
}

/// One interactive rectangle in logical (CSS) pixels, origin at the top-left of the content area.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    /// Optional diagnostic.
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
    pub kind: Option<RectKind>,
    /// Snapshot agent id when the rect is a resident or its card.
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
    pub agent: Option<InstanceId>,
}

/// A full replacement set of hit rectangles. An empty list makes the whole strip click-through.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HitRects {
    /// Schema version, always 1.
    pub schema_version: Version<1>,
    pub t: Ms,
    pub surface: Surface,
    pub viewport: Viewport,
    /// The webview's devicePixelRatio (0.5 to 8).
    pub scale: f64,
    /// At most 64 rectangles.
    pub rects: Vec<Rect>,
}

impl Validate for HitRects {
    fn validate(&self) -> Result<(), ContractError> {
        check::ms("/t", self.t)?;
        check::num_pos_max("/viewport/w", self.viewport.w, 0.0, 16384.0)?;
        check::num_pos_max("/viewport/h", self.viewport.h, 0.0, 16384.0)?;
        check::num_range("/scale", self.scale, 0.5, 8.0)?;
        check::max_items("/rects", self.rects.len(), 64)?;
        for (i, r) in self.rects.iter().enumerate() {
            let p = check::at("/rects", i);
            check::num_range(&check::child(&p, "x"), r.x, 0.0, 16384.0)?;
            check::num_range(&check::child(&p, "y"), r.y, 0.0, 16384.0)?;
            check::num_pos_max(&check::child(&p, "w"), r.w, 0.0, 16384.0)?;
            check::num_pos_max(&check::child(&p, "h"), r.h, 0.0, 16384.0)?;
            check::opt_instance(&check::child(&p, "agent"), r.agent.as_ref())?;
        }
        Ok(())
    }
}
