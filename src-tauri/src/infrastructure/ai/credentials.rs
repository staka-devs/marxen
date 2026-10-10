//! OS credentials and in-memory fixture implementation.
use crate::application::ai::credentials::*;
use crate::application::ai::runs::*;
use crate::contracts::ai::*;
use crate::contracts::Utf16Range;
use crate::domain::ai::*;
use crate::domain::validation::validate_document_id;
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
use std::time::Instant;
pub struct MemoryKeyring {
    inner: Mutex<HashMap<String, String>>,
}

impl AgentKeyring for MemoryKeyring {
    fn get(&self, kind: AiProviderKind) -> Result<Option<String>, AiError> {
        Ok(self
            .inner
            .lock()
            .expect("keyring lock")
            .get(credential_account(kind))
            .cloned())
    }

    fn set(&self, kind: AiProviderKind, secret: &str) -> Result<(), AiError> {
        validate_secret(secret)?;
        self.inner
            .lock()
            .expect("keyring lock")
            .insert(credential_account(kind).to_owned(), secret.to_owned());
        Ok(())
    }

    fn delete(&self, kind: AiProviderKind) -> Result<(), AiError> {
        self.inner
            .lock()
            .expect("keyring lock")
            .remove(credential_account(kind));
        Ok(())
    }
}

/// Real OS backend: Windows Credential Manager, macOS Keychain, Linux Secret Service.
pub struct OsKeyring;

fn keyring_entry(kind: AiProviderKind) -> Result<keyring::Entry, AiError> {
    keyring::Entry::new(SECRET_SERVICE, credential_account(kind)).map_err(|error| {
        AiError::CredentialStoreFailed {
            detail: format!("資格情報ストアを開けません: {error}"),
        }
    })
}

impl AgentKeyring for OsKeyring {
    fn get(&self, kind: AiProviderKind) -> Result<Option<String>, AiError> {
        let entry = keyring_entry(kind)?;
        match entry.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(AiError::CredentialStoreFailed {
                detail: format!("資格情報を読めません: {error}"),
            }),
        }
    }

    fn set(&self, kind: AiProviderKind, secret: &str) -> Result<(), AiError> {
        validate_secret(secret)?;
        keyring_entry(kind)?
            .set_password(secret)
            .map_err(|error| AiError::CredentialStoreFailed {
                detail: format!("資格情報を保存できません: {error}"),
            })
    }

    fn delete(&self, kind: AiProviderKind) -> Result<(), AiError> {
        let entry = keyring_entry(kind)?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(AiError::CredentialStoreFailed {
                detail: format!("資格情報を削除できません: {error}"),
            }),
        }
    }
}

// ---- Mock transport (tests and connection dry runs) ----
