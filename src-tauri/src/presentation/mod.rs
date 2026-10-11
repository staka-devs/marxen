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
