//! Atomic account metadata and dedicated slots in Marxen's existing OS secret service.
use crate::application::provider_accounts::{ProviderAccountCredentials, ProviderAccountStore};
use crate::contracts::{ai::SECRET_SERVICE, provider_accounts::*};
use crate::domain::provider_accounts::{valid_id, validate_settings};
use crate::infrastructure::storage::{atomic_write, disk_fingerprint};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};

pub struct NativeAccountStore {
    pub root: PathBuf,
}
pub struct NativeAccountCredentials;

/// Open a dedicated namespace so account deletion cannot affect API connections or defaults.
fn entry(id: &str) -> Result<keyring::Entry, ProviderAccountError> {
    if !valid_id(id) {
        return Err(ProviderAccountError::InvalidSettings);
    }
    keyring::Entry::new(SECRET_SERVICE, &format!("ai/provider-account/{id}"))
        .map_err(|_| ProviderAccountError::CredentialStoreFailed)
}

impl ProviderAccountCredentials for NativeAccountCredentials {
    /// Distinguish an absent slot from an unavailable OS credential store without error payloads.
    fn get(&self, id: &str) -> Result<Option<String>, ProviderAccountError> {
        match entry(id)?.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(ProviderAccountError::CredentialStoreFailed),
        }
    }
    /// Save only in the application account namespace, never a provider's own login slot.
    fn set(&self, id: &str, secret: &str) -> Result<(), ProviderAccountError> {
        entry(id)?
            .set_password(secret)
            .map_err(|_| ProviderAccountError::CredentialStoreFailed)
    }
    /// Treat an absent account secret as already deleted.
    fn delete(&self, id: &str) -> Result<(), ProviderAccountError> {
        match entry(id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(ProviderAccountError::CredentialStoreFailed),
        }
    }
}

/// Reject symlink entries before private files or account metadata can be accessed.
pub(super) fn reject_link(path: &Path) -> Result<(), ProviderAccountError> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => Err(ProviderAccountError::StoreFailed),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(ProviderAccountError::StoreFailed),
    }
}

/// Check every managed component while permitting trusted ancestors such as macOS /var aliases.
pub(super) fn guard_managed(root: &Path, path: &Path) -> Result<(), ProviderAccountError> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| ProviderAccountError::StoreFailed)?;
    reject_link(root)?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let std::path::Component::Normal(part) = component else {
            return Err(ProviderAccountError::StoreFailed);
        };
        current.push(part);
        reject_link(&current)?;
    }
    Ok(())
}

/// Create an application-owned directory and deny group/other access on Unix hosts.
pub(super) fn directory(path: &Path) -> Result<(), ProviderAccountError> {
    reject_link(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(path)
            .map_err(|_| ProviderAccountError::StoreFailed)?;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|_| ProviderAccountError::StoreFailed)?;
    }
    #[cfg(not(unix))]
    {
        fs::create_dir_all(path).map_err(|_| ProviderAccountError::StoreFailed)?;
        #[cfg(windows)]
        super::windows::private_directory(path)?;
    }
    Ok(())
}

/// Read bounded JSON from a chosen file without echoing paths, parse errors or credentials.
pub(super) fn read_json(path: &Path) -> Result<Option<serde_json::Value>, ProviderAccountError> {
    reject_link(path)?;
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(ProviderAccountError::StoreFailed),
    };
    let mut bytes = Vec::new();
    file.take(262145)
        .read_to_end(&mut bytes)
        .map_err(|_| ProviderAccountError::StoreFailed)?;
    if bytes.len() > 262144 {
        return Err(ProviderAccountError::InvalidResponse);
    }
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| ProviderAccountError::InvalidResponse)
}

impl ProviderAccountStore for NativeAccountStore {
    /// Missing metadata is empty; corrupt metadata remains an error and is never overwritten.
    fn load(&self) -> Result<AccountSettings, ProviderAccountError> {
        reject_link(&self.root)?;
        let Some(value) = read_json(&self.root.join("settings.json"))? else {
            return Ok(AccountSettings::default());
        };
        let settings =
            serde_json::from_value(value).map_err(|_| ProviderAccountError::InvalidSettings)?;
        validate_settings(&settings)?;
        Ok(settings)
    }
    /// Reuse the guarded atomic storage writer for the complete non-secret document.
    fn save(&self, settings: &AccountSettings) -> Result<(), ProviderAccountError> {
        validate_settings(settings)?;
        directory(&self.root)?;
        let path = self.root.join("settings.json");
        reject_link(&path)?;
        let expected = disk_fingerprint(&path).map_err(|_| ProviderAccountError::StoreFailed)?;
        let bytes = serde_json::to_vec(settings).map_err(|_| ProviderAccountError::StoreFailed)?;
        atomic_write(&path, &bytes, expected.as_ref(), None)
            .map(|_| ())
            .map_err(|_| ProviderAccountError::StoreFailed)
    }
    /// Mint a collision-resistant opaque ID from a random temporary-file name.
    fn issue_id(&self) -> Result<String, ProviderAccountError> {
        let temp = tempfile::Builder::new()
            .rand_bytes(32)
            .tempfile()
            .map_err(|_| ProviderAccountError::StoreFailed)?;
        Ok(format!(
            "{:x}",
            Sha256::digest(temp.path().as_os_str().to_string_lossy().as_bytes())
        )[..32]
            .to_owned())
    }
}
