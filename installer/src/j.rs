//! A tiny ordered JSON value for the text the installer writes, plus the canonical form used for hashes.
//!
//! `serde_json::Value` is not used for output because its key order depends on a Cargo feature that other
//! crates in the workspace may switch on. Here the order is exactly what the code says.

use serde_json::Value;

#[derive(Debug, Clone, PartialEq)]
pub enum J {
    Str(String),
    Bool(bool),
    Num(String),
    /// Verbatim JSON text (already valid), used to carry a user's own values through unchanged.
    Raw(String),
    Arr(Vec<J>),
    Obj(Vec<(String, J)>),
}

/// How a document is laid out, so inserted text looks like the text around it.
#[derive(Debug, Clone)]
pub struct Style {
    pub nl: &'static str,
    /// One indent level.
    pub unit: String,
    /// A single-line document: insert without any whitespace.
    pub compact: bool,
}

impl Style {
    pub fn default_pretty() -> Style {
        Style { nl: "\n", unit: "  ".to_string(), compact: false }
    }
}

pub fn quote(s: &str) -> String {
    serde_json::to_string(s).expect("string serialisation cannot fail")
}

impl J {
    fn is_scalar(&self) -> bool {
        matches!(self, J::Str(_) | J::Bool(_) | J::Num(_) | J::Raw(_))
    }

    /// No whitespace at all.
    pub fn render_min(&self) -> String {
        match self {
            J::Str(s) => quote(s),
            J::Bool(b) => b.to_string(),
            J::Num(n) | J::Raw(n) => n.clone(),
            J::Arr(v) => format!("[{}]", v.iter().map(J::render_min).collect::<Vec<_>>().join(",")),
            J::Obj(m) => format!("{{{}}}", m.iter().map(|(k, v)| format!("{}:{}", quote(k), v.render_min())).collect::<Vec<_>>().join(",")),
        }
    }

    /// One line, with a space after `:` and `,`.
    pub fn render_inline(&self) -> String {
        match self {
            J::Arr(v) => format!("[{}]", v.iter().map(J::render_inline).collect::<Vec<_>>().join(", ")),
            J::Obj(m) => {
                if m.is_empty() {
                    "{}".to_string()
                } else {
                    format!("{{{}}}", m.iter().map(|(k, v)| format!("{}: {}", quote(k), v.render_inline())).collect::<Vec<_>>().join(", "))
                }
            }
            other => other.render_min(),
        }
    }

    /// Pretty text for a value that starts on a line indented by `indent` (the closing bracket aligns to it).
    pub fn render(&self, st: &Style, indent: &str) -> String {
        if st.compact {
            return self.render_min();
        }
        match self {
            J::Arr(v) if v.is_empty() => "[]".to_string(),
            J::Obj(m) if m.is_empty() => "{}".to_string(),
            J::Arr(v) if v.iter().all(J::is_scalar) => self.render_inline(),
            J::Arr(v) => {
                let inner = format!("{indent}{}", st.unit);
                let items: Vec<String> = v.iter().map(|x| format!("{inner}{}", x.render(st, &inner))).collect();
                format!("[{nl}{}{nl}{indent}]", items.join(&format!(",{}", st.nl)), nl = st.nl)
            }
            J::Obj(m) => {
                let inner = format!("{indent}{}", st.unit);
                let items: Vec<String> = m.iter().map(|(k, x)| format!("{inner}{}: {}", quote(k), x.render(st, &inner))).collect();
                format!("{{{nl}{}{nl}{indent}}}", items.join(&format!(",{}", st.nl)), nl = st.nl)
            }
            other => other.render_min(),
        }
    }

    pub fn to_value(&self) -> Value {
        match self {
            J::Str(s) => Value::String(s.clone()),
            J::Bool(b) => Value::Bool(*b),
            J::Num(n) | J::Raw(n) => serde_json::from_str(n).unwrap_or(Value::Null),
            J::Arr(v) => Value::Array(v.iter().map(J::to_value).collect()),
            J::Obj(m) => Value::Object(m.iter().map(|(k, v)| (k.clone(), v.to_value())).collect()),
        }
    }
}

/// Canonical text of a JSON value: compact, object keys sorted by byte order. This is what
/// `OwnedEntry.sha256` hashes, so it is the same whatever indentation or key order a file uses.
pub fn canonical_json(v: &Value) -> String {
    match v {
        Value::Object(m) => {
            let mut keys: Vec<&String> = m.keys().collect();
            keys.sort();
            let parts: Vec<String> = keys.iter().map(|k| format!("{}:{}", quote(k), canonical_json(&m[*k]))).collect();
            format!("{{{}}}", parts.join(","))
        }
        Value::Array(a) => format!("[{}]", a.iter().map(canonical_json).collect::<Vec<_>>().join(",")),
        other => serde_json::to_string(other).expect("value serialisation cannot fail"),
    }
}
