//! Account use cases own selection, secret lifetime and host boundaries.
use crate::contracts::provider_accounts::*;
use crate::domain::provider_accounts::*;
use std::{
    collections::BTreeMap,
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
};

pub type AccountFuture<'a> =
    Pin<Box<dyn Future<Output = Result<ProviderAccountUsage, ProviderAccountError>> + Send + 'a>>;

/// Durable non-secret settings; saving must replace the complete document atomically.
pub trait ProviderAccountStore: Send + Sync {
    /// Load bounded settings or return an empty document when it does not exist.
    fn load(&self) -> Result<AccountSettings, ProviderAccountError>;
    /// Atomically persist validated account metadata without any secret values.
    fn save(&self, settings: &AccountSettings) -> Result<(), ProviderAccountError>;
    /// Issue an unpredictable account identifier without accepting a frontend path.
    fn issue_id(&self) -> Result<String, ProviderAccountError>;
}

/// Dedicated slots in the existing application OS credential service.
pub trait ProviderAccountCredentials: Send + Sync {
    /// Read one managed secret inside Rust only.
    fn get(&self, id: &str) -> Result<Option<String>, ProviderAccountError>;
    /// Replace one managed secret without exposing backend error text.
    fn set(&self, id: &str, secret: &str) -> Result<(), ProviderAccountError>;
    /// Delete one managed slot, accepting an already absent credential.
    fn delete(&self, id: &str) -> Result<(), ProviderAccountError>;
}

/// Native account operations never start an inference turn or change default CLI login.
pub trait ProviderAccountRuntime: Send + Sync {
    /// Open a fixed official setup page using the user's default browser.
    fn open_setup(&self, provider: AccountProvider) -> Result<(), ProviderAccountError>;
    /// Read presence only for the provider's system login; this does not prove authentication.
    fn system_credential_present(
        &self,
        provider: AccountProvider,
    ) -> Result<bool, ProviderAccountError>;
    /// Construct private CLI configuration and a child-only environment for the account.
    fn environment(
        &self,
        account: &ProviderAccount,
        credential: &str,
    ) -> Result<AccountLaunchEnvironment, ProviderAccountError>;
    /// Remove only the managed account's private runtime directory.
    fn remove(&self, id: &str) -> Result<(), ProviderAccountError>;
    /// Read measured limits using the chosen credential; None means explicit system default.
    fn usage(
        &self,
        provider: AccountProvider,
        account: Option<ProviderAccount>,
        credential: Option<String>,
    ) -> AccountFuture<'_>;
}

/// Native-only launch data: never serialize environment values across IPC or log them.
#[derive(Default)]
pub struct AccountLaunchEnvironment {
    /// Stable conversation discriminator; managed identities change with saved revision.
    pub identity: String,
    pub set: BTreeMap<String, String>,
    pub remove: Vec<String>,
}

/// Serialize metadata/credential transactions and inject all external effects.
pub struct ProviderAccountService {
    pub store: Arc<dyn ProviderAccountStore>,
    pub credentials: Arc<dyn ProviderAccountCredentials>,
    pub runtime: Arc<dyn ProviderAccountRuntime>,
    pub mutation: Mutex<()>,
}

impl ProviderAccountService {
    /// Load and validate before a selector can reach storage or launch adapters.
    fn settings(&self) -> Result<AccountSettings, ProviderAccountError> {
        let settings = self.store.load()?;
        validate_settings(&settings)?;
        Ok(settings)
    }

    /// Return public records and secret presence without disclosing credential contents.
    pub fn snapshot(&self) -> Result<AccountSnapshot, ProviderAccountError> {
        let _guard = self
            .mutation
            .lock()
            .map_err(|_| ProviderAccountError::StoreFailed)?;
        let settings = self.settings()?;
        let accounts = settings
            .accounts
            .into_iter()
            .map(|account| {
                let has_credential = self.credentials.get(&account.id)?.is_some();
                Ok(AccountState {
                    account,
                    has_credential,
                })
            })
            .collect::<Result<_, ProviderAccountError>>()?;
        Ok(AccountSnapshot {
            accounts,
            selections: settings.selections,
        })
    }

    /// Save a new or edited account, rolling back its secret if metadata persistence fails.
    pub fn save(
        &self,
        mut account: ProviderAccount,
        credential: Option<String>,
    ) -> Result<(), ProviderAccountError> {
        let _guard = self
            .mutation
            .lock()
            .map_err(|_| ProviderAccountError::StoreFailed)?;
        let mut settings = self.settings()?;
        let creating = account.id.is_empty();
        if creating {
            account.id = self.store.issue_id()?;
            account.revision = 1;
        }
        let index = settings.accounts.iter().position(|a| a.id == account.id);
        if creating && index.is_some() {
            return Err(ProviderAccountError::InvalidSettings);
        }
        if !creating && index.is_none() {
            return Err(ProviderAccountError::NotFound);
        }
        if let Some(index) = index {
            let old = &settings.accounts[index];
            if old.provider != account.provider
                || old.host != account.host
                || old.revision != account.revision
            {
                return Err(ProviderAccountError::InvalidSettings);
            }
            account.revision = account
                .revision
                .checked_add(1)
                .ok_or(ProviderAccountError::InvalidSettings)?;
        }
        validate_account(&account)?;
        if let Some(secret) = &credential {
            validate_credential(account.provider, secret)?;
        }
        let old_secret = self.credentials.get(&account.id)?;
        if let Some(secret) = &credential {
            self.credentials.set(&account.id, secret)?;
        }
        let id = account.id.clone();
        if let Some(index) = index {
            settings.accounts[index] = account;
        } else {
            settings.accounts.push(account);
        }
        if let Err(error) = validate_settings(&settings).and_then(|_| self.store.save(&settings)) {
            if credential.is_some() {
                match old_secret {
                    Some(secret) => self.credentials.set(&id, &secret)?,
                    None => self.credentials.delete(&id)?,
                }
            }
            return Err(error);
        }
        Ok(())
    }

    /// Select only an account from the same provider and host; None restores system defaults.
    pub fn select(&self, selection: AccountSelection) -> Result<(), ProviderAccountError> {
        let _guard = self
            .mutation
            .lock()
            .map_err(|_| ProviderAccountError::StoreFailed)?;
        let mut settings = self.settings()?;
        settings
            .selections
            .retain(|s| s.provider != selection.provider || s.host != selection.host);
        settings.selections.push(selection);
        validate_settings(&settings)?;
        self.store.save(&settings)
    }

    /// Remove only the requested account and reset its selections, keeping failures retryable.
    pub fn delete(&self, id: &str) -> Result<(), ProviderAccountError> {
        let _guard = self
            .mutation
            .lock()
            .map_err(|_| ProviderAccountError::StoreFailed)?;
        let mut settings = self.settings()?;
        if !settings.accounts.iter().any(|a| a.id == id) {
            return Err(ProviderAccountError::NotFound);
        }
        let secret = self.credentials.get(id)?;
        self.runtime.remove(id)?;
        self.credentials.delete(id)?;
        settings.accounts.retain(|a| a.id != id);
        for selection in &mut settings.selections {
            if selection.account_id.as_deref() == Some(id) {
                selection.account_id = None;
            }
        }
        if let Err(error) = self.store.save(&settings) {
            if let Some(secret) = secret {
                self.credentials.set(id, &secret)?;
            }
            return Err(error);
        }
        Ok(())
    }

    /// Resolve the current selection without ever falling back from a missing managed account.
    fn selected(
        &self,
        provider: AccountProvider,
        host: &AccountHost,
    ) -> Result<Option<ProviderAccount>, ProviderAccountError> {
        validate_host(host)?;
        if !matches!(host, AccountHost::Local) {
            return Err(ProviderAccountError::Unsupported {
                reason: AccountReason::WslUnsupported,
            });
        }
        let settings = self.settings()?;
        let id = settings
            .selections
            .iter()
            .find(|s| s.provider == provider && &s.host == host)
            .and_then(|s| s.account_id.as_deref());
        id.map(|id| {
            settings
                .accounts
                .into_iter()
                .find(|a| a.id == id)
                .ok_or(ProviderAccountError::NotFound)
        })
        .transpose()
    }

    /// Report selected credential presence; presence never claims server authentication.
    pub fn credential_present(
        &self,
        provider: AccountProvider,
        host: &AccountHost,
    ) -> Result<bool, ProviderAccountError> {
        let _guard = self
            .mutation
            .lock()
            .map_err(|_| ProviderAccountError::StoreFailed)?;
        match self.selected(provider, host)? {
            Some(account) => Ok(self.credentials.get(&account.id)?.is_some()),
            None => self.runtime.system_credential_present(provider),
        }
    }

    /// Public ACP integration point: apply set/remove to the child and key sessions by identity.
    pub fn launch_environment(
        &self,
        provider: AccountProvider,
        host: &AccountHost,
    ) -> Result<AccountLaunchEnvironment, ProviderAccountError> {
        let _guard = self
            .mutation
            .lock()
            .map_err(|_| ProviderAccountError::StoreFailed)?;
        match self.selected(provider, host)? {
            None => Ok(AccountLaunchEnvironment {
                identity: format!("{provider:?}:system:local"),
                ..Default::default()
            }),
            Some(account) => {
                let secret = self.credentials.get(&account.id)?.ok_or(
                    ProviderAccountError::Unsupported {
                        reason: AccountReason::MissingCredential,
                    },
                )?;
                self.runtime.environment(&account, &secret)
            }
        }
    }

    /// Capture account and credential together, then release the mutation lock before network I/O.
    pub async fn usage(
        &self,
        provider: AccountProvider,
        host: &AccountHost,
    ) -> Result<ProviderAccountUsage, ProviderAccountError> {
        let (account, secret) = {
            let _guard = self
                .mutation
                .lock()
                .map_err(|_| ProviderAccountError::StoreFailed)?;
            let account = self.selected(provider, host)?;
            let secret = account
                .as_ref()
                .map(|a| self.credentials.get(&a.id))
                .transpose()?
                .flatten();
            if account.is_some() && secret.is_none() {
                return Err(ProviderAccountError::Unsupported {
                    reason: AccountReason::MissingCredential,
                });
            }
            (account, secret)
        };
        self.runtime.usage(provider, account, secret).await
    }
}
