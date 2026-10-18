//! Pure strip placement (SPEC 6.3, 6.5). Rectangles are physical pixels in the OS's global desktop
//! space, exactly as Tauri's `Monitor` reports them (on macOS that is points times the monitor's
//! backing scale, so every rectangle of one monitor is consistent with that monitor's scale).

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PRect {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
}

impl PRect {
    pub fn right(&self) -> i32 {
        self.x + self.w as i32
    }
    pub fn bottom(&self) -> i32 {
        self.y + self.h as i32
    }
    pub fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x as f64 && x < self.right() as f64 && y >= self.y as f64 && y < self.bottom() as f64
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Os {
    MacOs,
    Windows,
    Linux,
}

impl Os {
    pub const fn current() -> Os {
        if cfg!(target_os = "macos") {
            Os::MacOs
        } else if cfg!(windows) {
            Os::Windows
        } else {
            Os::Linux
        }
    }
    pub fn as_str(&self) -> &'static str {
        match self {
            Os::MacOs => "macos",
            Os::Windows => "windows",
            Os::Linux => "linux",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct MonitorInfo {
    pub name: Option<String>,
    pub bounds: PRect,
    pub work: PRect,
    pub scale: f64,
    pub primary: bool,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Placement {
    /// Index into the monitor list that was passed in.
    pub monitor: usize,
    /// The strip window's outer rectangle, physical pixels.
    pub rect: PRect,
    pub scale: f64,
}

impl Placement {
    /// The strip rectangle in logical units (points on macOS, DIPs elsewhere) of its own monitor.
    pub fn logical(&self) -> (f64, f64, f64, f64) {
        let s = self.scale;
        (self.rect.x as f64 / s, self.rect.y as f64 / s, self.rect.w as f64 / s, self.rect.h as f64 / s)
    }
}

pub const MIN_HEIGHT: u8 = 72;
pub const MAX_HEIGHT: u8 = 160;

/// Does this monitor host the Dock or a taskbar? On macOS the top inset is the menu bar (present on
/// every display when displays have separate Spaces), so only bottom, left and right insets count.
pub fn has_dock(m: &MonitorInfo, os: Os) -> bool {
    let (b, w) = (m.bounds, m.work);
    let left = w.x > b.x;
    let right = w.right() < b.right();
    let bottom = w.bottom() < b.bottom();
    let top = w.y > b.y;
    match os {
        Os::MacOs => left || right || bottom,
        Os::Windows | Os::Linux => left || right || bottom || top,
    }
}

/// SPEC 6.5: a named display if it exists, else the display with the Dock or taskbar, else the
/// primary, else the first.
pub fn pick_monitor(ms: &[MonitorInfo], named: Option<&str>, os: Os) -> Option<usize> {
    if ms.is_empty() {
        return None;
    }
    if let Some(n) = named {
        if let Some(i) = ms.iter().position(|m| m.name.as_deref() == Some(n)) {
            return Some(i);
        }
    }
    if let Some(i) = ms.iter().position(|m| has_dock(m, os)) {
        return Some(i);
    }
    Some(ms.iter().position(|m| m.primary).unwrap_or(0))
}

/// The strip spans the work area's width and sits on its bottom edge. `height` is in logical
/// pixels (Settings v1 `strip.height`) and is clamped to 72..=160.
pub fn strip_rect(work: PRect, scale: f64, height: u8) -> PRect {
    let h_logical = height.clamp(MIN_HEIGHT, MAX_HEIGHT) as f64;
    let h = ((h_logical * scale).round() as u32).min(work.h).max(1);
    PRect { x: work.x, y: work.bottom() - h as i32, w: work.w, h }
}

/// Reserve-space mode (Windows AppBar, X11 strut): once our own reservation is in place the OS
/// folds it into the work area. Undo that, so placing again lands in the same spot instead of
/// creeping upwards by one strip each time.
pub fn without_own_reservation(work: PRect, own: Option<PRect>) -> PRect {
    match own {
        Some(o) if (work.bottom() - o.y).abs() <= 1 && o.x < work.right() && o.right() > work.x => {
            PRect { h: work.h + (o.bottom() - work.bottom()).max(0) as u32, ..work }
        }
        _ => work,
    }
}

pub fn place(ms: &[MonitorInfo], named: Option<&str>, os: Os, height: u8, own: Option<PRect>) -> Option<Placement> {
    // Undo our own reservation before deciding which display has a dock: our strut or AppBar must
    // not make a dockless display look like the Dock display.
    let adjusted: Vec<MonitorInfo> = ms
        .iter()
        .map(|m| MonitorInfo { work: without_own_reservation(m.work, own), ..m.clone() })
        .collect();
    let i = pick_monitor(&adjusted, named, os)?;
    let m = &adjusted[i];
    Some(Placement { monitor: i, rect: strip_rect(m.work, m.scale, height), scale: m.scale })
}

/// Euclidean distance from a point to a rectangle (0 inside).
pub fn distance_outside(r: PRect, x: f64, y: f64) -> f64 {
    let dx = if x < r.x as f64 { r.x as f64 - x } else if x > r.right() as f64 { x - r.right() as f64 } else { 0.0 };
    let dy = if y < r.y as f64 { r.y as f64 - y } else if y > r.bottom() as f64 { y - r.bottom() as f64 } else { 0.0 };
    (dx * dx + dy * dy).sqrt()
}
