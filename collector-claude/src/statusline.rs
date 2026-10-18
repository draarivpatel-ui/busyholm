//! Status line payload mapper: `rate_limits.five_hour` and `rate_limits.seven_day`.
//!
//! A window that is absent, null, malformed or out of range yields NO sample. A missing
//! window is never reported as 0%.

use busyholm_contracts::agent_event::{EventKind, EventSource, EventUsage};
use busyholm_contracts::check::MS_MAX;
use busyholm_contracts::check::MS_MIN;
use busyholm_contracts::common::{Confidence, Provider, Window};
use serde_json::Value;

use crate::hooks::MAX_BODY;
use crate::pending::Draft;
use crate::time::epoch_to_ms;
use crate::{Env, MapError, PendingEvent};

fn sample(rate_limits: &Value, key: &str) -> Option<(f64, u64)> {
    let w = rate_limits.get(key)?.as_object()?;
    let pct = w.get("used_percentage")?.as_f64()?;
    if !pct.is_finite() || !(0.0..=100.0).contains(&pct) {
        return None;
    }
    let reset = epoch_to_ms(w.get("resets_at")?.as_f64()?)?;
    if !(MS_MIN..=MS_MAX).contains(&reset) {
        return None;
    }
    Some((pct, reset))
}

pub fn map_statusline(body: &[u8], env: &Env) -> Result<Vec<PendingEvent>, MapError> {
    if body.len() > MAX_BODY {
        return Err(MapError::TooLarge);
    }
    let doc: Value = serde_json::from_slice(body).map_err(|_| MapError::NotJson)?;
    let obj = doc.as_object().ok_or(MapError::NotObject)?;
    let session = obj
        .get("session_id")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && s.len() <= 256)
        .ok_or(MapError::MissingField)?;
    let instance = env.instance(session);
    let host = env.host(&instance);
    let mut out = Vec::new();
    if let Some(rl) = obj.get("rate_limits") {
        for (key, window) in [("five_hour", Window::FiveHour), ("seven_day", Window::Weekly)] {
            if let Some((used_pct, resets_at)) = sample(rl, key) {
                out.push(
                    Draft::new(env, EventKind::UsageSample, EventSource::Hook, Confidence::Exact, instance.clone(), host)
                        .usage(EventUsage {
                            provider: Provider::Claude,
                            window,
                            used_pct,
                            resets_at,
                            observed_at: env.now_ms,
                        })
                        .done(),
                );
            }
        }
    }
    Ok(out)
}
