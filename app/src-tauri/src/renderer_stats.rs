//! Counts-only renderer health for opt-in acceptance logs. No free-form strings or payloads.
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Mode {
    Calm,
    Burst,
    Hidden,
    Reduced,
    AmbientMoving,
    AmbientStill,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RendererStats {
    pub t: f64,
    pub drawn: u64,
    pub ticks: u64,
    pub mode: Mode,
    pub errors: u32,
    pub agents: u8,
    pub working: u8,
    pub visible: bool,
    pub w: f64,
    pub h: f64,
}

impl RendererStats {
    pub fn valid(&self) -> bool {
        self.t.is_finite() && self.t >= 0.0 && self.drawn <= self.ticks &&
            self.working <= self.agents && self.agents <= 64 &&
            self.w.is_finite() && self.h.is_finite() && self.w > 0.0 && self.h > 0.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample() -> serde_json::Value {
        json!({ "t": 2000, "drawn": 2, "ticks": 3, "mode": "calm", "errors": 0, "agents": 3, "working": 3,
            "visible": true, "w": 1440, "h": 112 })
    }

    #[test]
    fn accepts_counts_but_rejects_content_and_unknown_modes() {
        assert!(serde_json::from_value::<RendererStats>(sample()).unwrap().valid());
        let mut v = sample();
        v["prompt"] = json!("BHCANARY_stats_content");
        assert!(serde_json::from_value::<RendererStats>(v).is_err());
        let mut v = sample();
        v["errors"] = json!(["BHCANARY_error_text"]);
        assert!(serde_json::from_value::<RendererStats>(v).is_err());
        let mut v = sample();
        v["mode"] = json!("BHCANARY_mode_text");
        assert!(serde_json::from_value::<RendererStats>(v).is_err());
    }

    #[test]
    fn rejects_invalid_geometry_time_and_counters() {
        let mut stats: RendererStats = serde_json::from_value(sample()).unwrap();
        stats.t = f64::NAN;
        assert!(!stats.valid());
        stats.t = -1.0;
        assert!(!stats.valid());
        stats.t = 2000.0;
        stats.w = 0.0;
        assert!(!stats.valid());
        stats.w = 1440.0;
        stats.drawn = stats.ticks + 1;
        assert!(!stats.valid());
        stats.drawn = stats.ticks;
        stats.working = stats.agents + 1;
        assert!(!stats.valid());
        stats.working = 0;
        stats.agents = 65;
        assert!(!stats.valid());
    }
}
