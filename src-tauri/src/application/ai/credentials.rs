//! Secret access port; callers expose presence only to IPC.
use crate::contracts::ai::*;
pub trait AgentKeyring: Send + Sync {
    /// Read the selected provider credential inside Rust; return None when absent.
    fn get(&self, kind: AiProviderKind) -> Result<Option<String>, AiError>;
    /// Validate and persist the selected provider credential without exposing it to events.
    fn set(&self, kind: AiProviderKind, secret: &str) -> Result<(), AiError>;
    /// Delete only the selected provider credential slot.
    fn delete(&self, kind: AiProviderKind) -> Result<(), AiError>;
    /// Report credential presence while keeping its value out of the IPC response.
    fn has(&self, kind: AiProviderKind) -> Result<bool, AiError> {
        Ok(self
            .get(kind)?
            .map(|secret| !secret.is_empty())
            .unwrap_or(false))
    }
}

/// Per-connection secret port; callers expose presence only to IPC.
/// Legacy kind slots stay untouched: named connections own `ai/api/<id>` slots.
pub trait ApiConnectionKeyring: Send + Sync {
    /// Read one named connection's credential inside Rust; None when absent.
    fn get_connection(&self, id: &ApiConnectionId) -> Result<Option<String>, AiError>;
    /// Validate and persist one named connection's credential without exposing it.
    fn set_connection(&self, id: &ApiConnectionId, secret: &str) -> Result<(), AiError>;
    /// Delete only the named connection's credential slot.
    fn delete_connection(&self, id: &ApiConnectionId) -> Result<(), AiError>;
    /// Report presence while keeping the value out of the IPC response.
    fn has_connection(&self, id: &ApiConnectionId) -> Result<bool, AiError> {
        Ok(self
            .get_connection(id)?
            .map(|secret| !secret.is_empty())
            .unwrap_or(false))
    }
}
