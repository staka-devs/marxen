//! Secret access port; callers expose presence only to IPC.
use crate::contracts::ai::*;
use crate::contracts::Utf16Range;
use crate::domain::validation::validate_document_id;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::Duration;
pub trait AgentKeyring: Send + Sync {
    fn get(&self, kind: AiProviderKind) -> Result<Option<String>, AiError>;
    fn set(&self, kind: AiProviderKind, secret: &str) -> Result<(), AiError>;
    fn delete(&self, kind: AiProviderKind) -> Result<(), AiError>;
    fn has(&self, kind: AiProviderKind) -> Result<bool, AiError> {
        Ok(self
            .get(kind)?
            .map(|secret| !secret.is_empty())
            .unwrap_or(false))
    }
}
