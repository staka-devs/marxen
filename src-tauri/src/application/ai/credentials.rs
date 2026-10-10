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
