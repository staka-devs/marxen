//! Deterministic policy without runtime adapters.
pub mod ai;
#[cfg(any(all(feature = "desktop", windows), test))]
pub mod clipboard_format;
pub mod coordinates;
pub mod isolation;
pub mod storage;
pub mod validation;
