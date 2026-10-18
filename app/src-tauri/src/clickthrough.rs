//! Pure click-through and hover-fade state machine (SPEC 6.3). The cursor poll feeds samples in
//! strip-local CSS pixels; the machine says when to toggle the OS click-through flag and the fade.
//!
//! Rules:
//! - The strip starts click-through. It becomes clickable only while the cursor is inside a HitRect.
//! - Hover-fade: after 400 ms continuously over the strip but not over any rect, the scenery fades
//!   and the strip stays click-through (even over residents) until the cursor leaves the strip.
//! - Poll fast (30 Hz) within 48 px of the strip, slowly (4 Hz) otherwise.
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HitRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Config {
    pub hover_fade: bool,
    pub fade_after: Duration,
    pub near_px: f64,
    pub fast: Duration,
    pub slow: Duration,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            hover_fade: true,
            fade_after: Duration::from_millis(400),
            near_px: 48.0,
            fast: Duration::from_micros(33_333),
            slow: Duration::from_millis(250),
        }
    }
}

/// One poll: time since an arbitrary origin, the cursor in strip-local CSS px (`None` when unknown)
/// and the strip's CSS size.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Sample {
    pub now: Duration,
    pub cursor: Option<(f64, f64)>,
    pub size: (f64, f64),
}

impl Sample {
    fn inside(&self) -> Option<(f64, f64)> {
        self.cursor.filter(|&(x, y)| x >= 0.0 && y >= 0.0 && x < self.size.0 && y < self.size.1)
    }
    fn distance(&self) -> f64 {
        match self.cursor {
            None => f64::INFINITY,
            Some((x, y)) => {
                let dx = if x < 0.0 { -x } else if x > self.size.0 { x - self.size.0 } else { 0.0 };
                let dy = if y < 0.0 { -y } else if y > self.size.1 { y - self.size.1 } else { 0.0 };
                (dx * dx + dy * dy).sqrt()
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Actions {
    pub set_ignore: Option<bool>,
    pub set_fade: Option<bool>,
}

#[derive(Debug, Clone)]
pub struct ClickThrough {
    pub cfg: Config,
    ignoring: bool,
    faded: bool,
    empty_since: Option<Duration>,
}

impl ClickThrough {
    pub fn new(cfg: Config) -> Self {
        ClickThrough { cfg, ignoring: true, faded: false, empty_since: None }
    }
    pub fn ignoring(&self) -> bool {
        self.ignoring
    }
    pub fn faded(&self) -> bool {
        self.faded
    }

    pub fn step(&mut self, s: &Sample, rects: &[HitRect]) -> Actions {
        let mut a = Actions::default();
        let want_ignore;
        match s.inside() {
            None => {
                self.empty_since = None;
                if self.faded {
                    self.faded = false;
                    a.set_fade = Some(false);
                }
                want_ignore = true;
            }
            Some((x, y)) => {
                let over = hit(rects, x, y);
                if over {
                    self.empty_since = None;
                } else if self.empty_since.is_none() {
                    self.empty_since = Some(s.now);
                }
                if self.cfg.hover_fade && !self.faded {
                    if let Some(since) = self.empty_since {
                        if s.now.saturating_sub(since) >= self.cfg.fade_after {
                            self.faded = true;
                            a.set_fade = Some(true);
                        }
                    }
                }
                want_ignore = self.faded || !over;
            }
        }
        if want_ignore != self.ignoring {
            self.ignoring = want_ignore;
            a.set_ignore = Some(want_ignore);
        }
        a
    }

    pub fn interval(&self, s: &Sample) -> Duration {
        if s.distance() <= self.cfg.near_px {
            self.cfg.fast
        } else {
            self.cfg.slow
        }
    }

    /// The strip was hidden (or the rects reset): back to click-through, fade off.
    pub fn reset(&mut self) -> Actions {
        let mut a = Actions::default();
        if !self.ignoring {
            self.ignoring = true;
            a.set_ignore = Some(true);
        }
        if self.faded {
            self.faded = false;
            a.set_fade = Some(false);
        }
        self.empty_since = None;
        a
    }
}

pub fn hit(rects: &[HitRect], x: f64, y: f64) -> bool {
    rects.iter().any(|r| x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h)
}

/// Scale a HitRects v1 message (viewport CSS px) to the strip window's current CSS size.
pub fn rects_from_contract(msg: &busyholm_contracts::HitRects, strip_w: f64, strip_h: f64) -> Vec<HitRect> {
    let kx = if msg.viewport.w > 0.0 { strip_w / msg.viewport.w } else { 1.0 };
    let ky = if msg.viewport.h > 0.0 { strip_h / msg.viewport.h } else { 1.0 };
    msg.rects.iter().map(|r| HitRect { x: r.x * kx, y: r.y * ky, w: r.w * kx, h: r.h * ky }).collect()
}

/// What identifies the strip's geometry for HitRects: its physical rectangle, its scale and its CSS size.
/// Any difference makes previously published rectangles stale (review r1 L1).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GeomKey {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
    pub scale: f64,
    pub css: (f64, f64),
}

/// The published HitRects, tied to the geometry they were laid out for. A geometry change drops them (the strip
/// is click-through until the page republishes), and while it waits for that republish a late message for the
/// old viewport is ignored instead of being rescaled onto the new size.
#[derive(Debug, Default)]
pub struct HitStore {
    key: Option<GeomKey>,
    rects: Vec<HitRect>,
    awaiting_republish: bool,
}

/// How far a message's viewport may differ from the strip's CSS size and still count as laid out for it.
const VIEWPORT_TOLERANCE_PX: f64 = 2.0;

impl HitStore {
    /// Record the strip's current geometry. Returns true when rectangles were dropped because it changed.
    pub fn set_geometry(&mut self, key: GeomKey) -> bool {
        if self.key == Some(key) {
            return false;
        }
        let had_key = self.key.is_some();
        self.key = Some(key);
        if !had_key {
            return false;
        }
        self.rects.clear();
        self.awaiting_republish = true;
        true
    }

    /// Store a published HitRects message. Returns false (storing nothing) when there is no geometry yet or when
    /// the message was laid out for a viewport the strip no longer has.
    pub fn publish(&mut self, msg: &busyholm_contracts::HitRects) -> bool {
        let Some(key) = self.key else { return false };
        if self.awaiting_republish {
            let fits = (msg.viewport.w - key.css.0).abs() <= VIEWPORT_TOLERANCE_PX && (msg.viewport.h - key.css.1).abs() <= VIEWPORT_TOLERANCE_PX;
            if !fits {
                return false;
            }
            self.awaiting_republish = false;
        }
        self.rects = rects_from_contract(msg, key.css.0, key.css.1);
        true
    }

    pub fn rects(&self) -> &[HitRect] {
        &self.rects
    }
}
