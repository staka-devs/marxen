//! Thin IPC commands never return credentials, private paths or raw provider responses.
use crate::application::provider_accounts::ProviderAccountService;
use crate::contracts::provider_accounts::*;

#[tauri::command]
/// List managed account metadata and credential presence.
pub fn provider_accounts_snapshot(
    service: tauri::State<'_, std::sync::Arc<ProviderAccountService>>,
) -> Result<AccountSnapshot, ProviderAccountError> {
    service.snapshot()
}

#[tauri::command]
/// Save explicitly entered credentials in Rust and persist only public account settings.
pub fn provider_accounts_save(
    service: tauri::State<'_, std::sync::Arc<ProviderAccountService>>,
    account: ProviderAccount,
    credentials: Option<AccountCredentialPatch>,
) -> Result<(), ProviderAccountError> {
    service.save(account, credentials)
}

#[tauri::command]
/// Select one provider account for subsequent launches and usage reads in the same host scope.
pub fn provider_accounts_select(
    service: tauri::State<'_, std::sync::Arc<ProviderAccountService>>,
    selection: AccountSelection,
) -> Result<(), ProviderAccountError> {
    service.select(selection)
}

#[tauri::command]
/// Delete only the requested managed account, its secret and private files.
pub fn provider_accounts_delete(
    service: tauri::State<'_, std::sync::Arc<ProviderAccountService>>,
    id: String,
) -> Result<(), ProviderAccountError> {
    service.delete(&id)
}

#[tauri::command]
/// Check credential presence without claiming network authentication or starting a CLI.
pub fn provider_accounts_credential_present(
    service: tauri::State<'_, std::sync::Arc<ProviderAccountService>>,
    provider: AccountProvider,
    host: AccountHost,
) -> Result<bool, ProviderAccountError> {
    service.credential_present(provider, &host)
}

#[tauri::command]
/// Fetch only measured usage for the selected account without creating an AI turn.
pub async fn provider_accounts_usage(
    service: tauri::State<'_, std::sync::Arc<ProviderAccountService>>,
    provider: AccountProvider,
    host: AccountHost,
) -> Result<ProviderAccountUsage, ProviderAccountError> {
    service.usage(provider, &host).await
}

#[tauri::command]
/// Open the provider's fixed setup page without exposing arbitrary URL or command execution.
pub async fn provider_accounts_open_setup(
    service: tauri::State<'_, std::sync::Arc<ProviderAccountService>>,
    provider: AccountProvider,
) -> Result<(), ProviderAccountError> {
    let runtime = service.runtime.clone();
    tauri::async_runtime::spawn_blocking(move || runtime.open_setup(provider))
        .await
        .map_err(|_| ProviderAccountError::RequestFailed)?
}
