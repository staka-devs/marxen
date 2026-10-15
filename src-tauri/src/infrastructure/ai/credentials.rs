//! OS credentials and in-memory fixture implementation.
use crate::application::ai::credentials::*;
use crate::contracts::ai::*;
use crate::domain::ai::*;
use std::collections::HashMap;
use std::sync::Mutex;
#[derive(Default)]
pub struct MemoryKeyring {
    inner: Mutex<HashMap<String, String>>,
}

impl AgentKeyring for MemoryKeyring {
    /// Read the selected provider's in-memory credential slot.
    fn get(&self, kind: AiProviderKind) -> Result<Option<String>, AiError> {
        Ok(self
            .inner
            .lock()
            .expect("keyring lock")
            .get(credential_account(kind))
            .cloned())
    }

    /// Validate and update one provider's in-memory credential slot.
    fn set(&self, kind: AiProviderKind, secret: &str) -> Result<(), AiError> {
        validate_secret(secret)?;
        self.inner
            .lock()
            .expect("keyring lock")
            .insert(credential_account(kind).to_owned(), secret.to_owned());
        Ok(())
    }

    /// Remove only the selected in-memory provider credential.
    fn delete(&self, kind: AiProviderKind) -> Result<(), AiError> {
        self.inner
            .lock()
            .expect("keyring lock")
            .remove(credential_account(kind));
        Ok(())
    }
}

impl ApiConnectionKeyring for MemoryKeyring {
    /// Read one named connection's in-memory credential slot.
    fn get_connection(&self, id: &ApiConnectionId) -> Result<Option<String>, AiError> {
        validate_connection_id(id)?;
        Ok(self
            .inner
            .lock()
            .expect("keyring lock")
            .get(&connection_account(id))
            .cloned())
    }

    /// Validate and update one named connection's in-memory credential slot.
    fn set_connection(&self, id: &ApiConnectionId, secret: &str) -> Result<(), AiError> {
        validate_connection_id(id)?;
        validate_secret(secret)?;
        self.inner
            .lock()
            .expect("keyring lock")
            .insert(connection_account(id), secret.to_owned());
        Ok(())
    }

    /// Remove only the named connection's in-memory credential.
    fn delete_connection(&self, id: &ApiConnectionId) -> Result<(), AiError> {
        validate_connection_id(id)?;
        self.inner
            .lock()
            .expect("keyring lock")
            .remove(&connection_account(id));
        Ok(())
    }
}

/// Real OS backend: Windows Credential Manager, macOS Keychain, Linux Secret Service.
pub struct OsKeyring;

/// Open the stable application/provider credential slot without reading the secret.
fn keyring_entry(kind: AiProviderKind) -> Result<keyring::Entry, AiError> {
    keyring::Entry::new(SECRET_SERVICE, credential_account(kind)).map_err(|error| {
        AiError::CredentialStoreFailed {
            detail: format!("資格情報ストアを開けません: {error}"),
        }
    })
}

/// Open one named connection's stable credential slot without reading the secret.
fn connection_keyring_entry(id: &ApiConnectionId) -> Result<keyring::Entry, AiError> {
    validate_connection_id(id)?;
    keyring::Entry::new(SECRET_SERVICE, &connection_account(id)).map_err(|error| {
        AiError::CredentialStoreFailed {
            detail: format!("資格情報ストアを開けません: {error}"),
        }
    })
}

impl AgentKeyring for OsKeyring {
    /// Read the selected OS credential slot, distinguishing absence from store failure.
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

    /// Validate and write the selected OS credential slot using the stable application namespace.
    fn set(&self, kind: AiProviderKind, secret: &str) -> Result<(), AiError> {
        validate_secret(secret)?;
        keyring_entry(kind)?
            .set_password(secret)
            .map_err(|error| AiError::CredentialStoreFailed {
                detail: format!("資格情報を保存できません: {error}"),
            })
    }

    /// Remove only the selected OS credential, accepting an already absent entry.
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

impl ApiConnectionKeyring for OsKeyring {
    /// Read one named connection's OS credential slot, distinguishing absence from failure.
    fn get_connection(&self, id: &ApiConnectionId) -> Result<Option<String>, AiError> {
        let entry = connection_keyring_entry(id)?;
        match entry.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(AiError::CredentialStoreFailed {
                detail: format!("資格情報を読めません: {error}"),
            }),
        }
    }

    /// Validate and write one named connection's OS credential slot.
    fn set_connection(&self, id: &ApiConnectionId, secret: &str) -> Result<(), AiError> {
        validate_secret(secret)?;
        connection_keyring_entry(id)?
            .set_password(secret)
            .map_err(|error| AiError::CredentialStoreFailed {
                detail: format!("資格情報を保存できません: {error}"),
            })
    }

    /// Remove only the named connection's OS credential, accepting an absent entry.
    fn delete_connection(&self, id: &ApiConnectionId) -> Result<(), AiError> {
        let entry = connection_keyring_entry(id)?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(AiError::CredentialStoreFailed {
                detail: format!("資格情報を削除できません: {error}"),
            }),
        }
    }
}

// ---- Mock transport (tests and connection dry runs) ----
