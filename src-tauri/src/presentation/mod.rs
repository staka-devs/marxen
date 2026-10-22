//! Desktop command adapters and Tauri-owned state.
#[cfg(feature = "desktop")]
pub mod ai;
#[cfg(feature = "desktop")]
pub mod clipboard;
pub mod document;
#[cfg(feature = "desktop")]
pub mod isolation;
#[cfg(feature = "desktop")]
pub mod runtime;
#[cfg(feature = "desktop")]
pub mod source_control;
#[cfg(feature = "desktop")]
pub mod vim_settings;

#[cfg(feature = "desktop")]
pub mod provider_accounts;
