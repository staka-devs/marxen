//! Deterministic policy without runtime adapters.
pub mod ai;
pub mod ai_account_usage;
#[cfg(any(all(feature = "desktop", windows), test))]
pub mod clipboard_format;
pub mod coordinates;
pub mod git;
pub mod isolation;
pub mod provider_accounts;
pub mod search;
pub mod storage;
pub mod transcript_usage;
pub mod validation;
pub mod vim_settings;
pub mod vim_ui;
