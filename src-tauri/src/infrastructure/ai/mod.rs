//! ACP, HTTP, credential, and native discovery adapters.
pub mod acp;
mod config_options;
pub mod credentials;
pub mod discovery;
pub mod http;
#[cfg(test)]
mod tests;
pub mod transport;
