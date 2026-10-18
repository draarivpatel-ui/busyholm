//! Semantic validation entry points.
//!
//! Deserialization (the serde layer) checks structure. [`Validate`] is the
//! second layer: ranges, patterns, conditionals and uniqueness, matching the
//! JSON Schemas in `contracts/schemas`.

use std::fmt;

use serde::de::DeserializeOwned;


/// A contract violation: where it is and what is wrong.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContractError {
    /// JSON Pointer (RFC 6901) to the offending value; empty for the root.
    pub path: String,
    /// Human-readable description.
    pub message: String,
}

impl fmt::Display for ContractError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.path.is_empty() {
            write!(f, "{}", self.message)
        } else {
            write!(f, "{}: {}", self.path, self.message)
        }
    }
}

impl std::error::Error for ContractError {}

/// Semantic validation of an already deserialized contract value.
pub trait Validate {
    /// Returns the first violation found, or `Ok(())`.
    fn validate(&self) -> Result<(), ContractError>;
}

fn serde_error(e: serde_json::Error) -> ContractError {
    ContractError { path: String::new(), message: e.to_string() }
}

/// Parses JSON text into a contract type, then validates it.
pub fn from_json<T: DeserializeOwned + Validate>(text: &str) -> Result<T, ContractError> {
    let value: T = serde_json::from_str(text).map_err(serde_error)?;
    value.validate()?;
    Ok(value)
}

/// Converts a JSON value into a contract type, then validates it.
pub fn from_value<T: DeserializeOwned + Validate>(v: serde_json::Value) -> Result<T, ContractError> {
    let value: T = serde_json::from_value(v).map_err(serde_error)?;
    value.validate()?;
    Ok(value)
}
