//! Deterministic policy without runtime adapters.
pub mod ai;
pub mod ai_account_usage;
#[cfg(any(all(feature = "desktop", windows), test))]
pub mod clipboard_format;
pub mod coordinates;
pub mod isolation;
pub mod search;
pub mod storage;
pub mod validation;
pub mod vim_settings;
pub mod vim_ui;
pub mod provider_accounts;
