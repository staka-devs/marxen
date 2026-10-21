//! Native implementations of application ports.
pub mod ai;
#[cfg(feature = "desktop")]
pub mod clipboard;
pub mod git;
pub mod neovim;
pub mod staging;
pub mod storage;
pub mod vim_settings;

pub mod provider_accounts;
