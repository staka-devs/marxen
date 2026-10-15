//! Vim-settings IPC data, independent of document and AI contracts.
//!
//! Rust owns this definition; the `export-vim-settings-contracts` helper
//! generates TypeScript into `src/contracts/vim-settings.ts`. JSON fields are
//! camelCase. These declarations are exported separately from document contracts.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// One mode-specific mapping managed inside the Marxen block.
///
/// `mode` is a single Vim mode letter (`n/i/v/x/s/o/c/t`); `lhs`/`rhs` are
/// validated key notation and replacement text, never full Vim language.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VimMapping {
    pub mode: String,
    pub lhs: String,
    pub rhs: String,
}

/// Post-yank copy-format selectors. Empty strings disable a selector.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VimCopyKeys {
    pub markdown: String,
    pub text: String,
    pub rich: String,
    pub html: String,
}

/// Structured settings owned by the Marxen managed block.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VimSettings {
    pub tabstop: u8,
    pub shiftwidth: u8,
    pub expandtab: bool,
    pub ignorecase: bool,
    pub smartcase: bool,
    /// Explicit opt-in for the non-focusing selection formatting popup.
    #[serde(default)]
    pub selection_toolbar: bool,
    pub leader: String,
    pub mappings: Vec<VimMapping>,
    pub copy_keys: VimCopyKeys,
}

/// File read result with fingerprint-guarded raw text and parsed settings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VimConfigRead {
    pub path: String,
    /// Hex SHA-256 of the exact file bytes, absent when the file is missing.
    pub fingerprint: Option<String>,
    /// Whether the selected configuration file exists.
    pub exists: bool,
    /// True for `init.lua`: raw editing only, never managed Vimscript.
    pub is_lua: bool,
    pub raw: String,
    pub settings: VimSettings,
    /// Managed-block parse failure, if any; the raw text stays inspectable.
    pub managed_error: Option<String>,
}

/// Durable write result with the new fingerprint and full file text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VimConfigWrite {
    pub path: String,
    pub fingerprint: String,
    pub raw: String,
}

/// Return exported Vim-settings IPC TypeScript declarations; no files are written.
///
/// Run the `export-vim-settings-contracts` helper
/// with `--output src/contracts/vim-settings.ts` and commit the result.
/// Never merge this output into the main `contracts.ts` generator.
#[cfg(feature = "dev-tools")]
pub fn typescript() -> String {
    let cfg = ts_rs::Config::default();
    let declarations = [
        VimMapping::decl(&cfg),
        VimCopyKeys::decl(&cfg),
        VimSettings::decl(&cfg),
        VimConfigRead::decl(&cfg),
        VimConfigWrite::decl(&cfg),
    ];
    let mut output = "// Generated from src-tauri/src/contracts/vim_settings.rs. Run the export-vim-settings-contracts helper.\n// Do not edit by hand. Vim-settings IPC schema version 1.\n"
        .to_owned();
    for declaration in declarations {
        output.push_str("export ");
        output.push_str(&declaration);
        output.push('\n');
    }
    output
}
