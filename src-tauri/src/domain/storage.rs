//! Deterministic file families, fingerprints, and UTF-8 policy.
use crate::contracts::{DocumentSnapshot, WorkspaceError};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

/// Hash the exact file bytes as a lowercase hexadecimal SHA-256 fingerprint.
pub fn fingerprint(bytes: &[u8]) -> Fingerprint {
    Fingerprint(format!("{:x}", Sha256::digest(bytes)))
}

/// Recognize `.md` and `.markdown` extensions without regard to ASCII case.
pub fn markdown(path: &Path) -> bool {
    path.extension()
        .and_then(|s| s.to_str())
        .is_some_and(|s| s.eq_ignore_ascii_case("md") || s.eq_ignore_ascii_case("markdown"))
}

/// Strip a lexical root prefix and normalize backslashes to `/` for a UTF-8 path.
/// Return `OutsideWorkspace` for a prefix mismatch or `InvalidPath` for non-UTF-8 text;
/// this does not canonicalize paths or resolve symlinks.
pub fn relative(root: &Path, path: &Path) -> Result<String, WorkspaceError> {
    path.strip_prefix(root)
        .map_err(|_| WorkspaceError::OutsideWorkspace)?
        .to_str()
        .map(|s| s.replace('\\', "/"))
        .ok_or(WorkspaceError::InvalidPath)
}

/// Recognize PNG, JPEG, GIF, and WebP names by case-insensitive extension only.
pub fn image_family(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "webp"
    )
}

/// Classify supported source/configuration extensions and conventional extensionless
/// text names without inspecting the file's bytes.
pub fn text_family(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    markdown(path)
        || matches!(
            name.as_str(),
            "readme"
                | "license"
                | "copying"
                | "makefile"
                | "dockerfile"
                | "vimrc"
                | "_vimrc"
                | ".vimrc"
                | ".gitignore"
                | ".gitattributes"
                | ".editorconfig"
                | ".env"
        )
        || matches!(
            path.extension()
                .and_then(|s| s.to_str())
                .unwrap_or_default()
                .to_ascii_lowercase()
                .as_str(),
            "txt"
                | "text"
                | "log"
                | "csv"
                | "tsv"
                | "json"
                | "jsonc"
                | "yaml"
                | "yml"
                | "toml"
                | "ini"
                | "conf"
                | "config"
                | "xml"
                | "html"
                | "htm"
                | "css"
                | "scss"
                | "less"
                | "js"
                | "jsx"
                | "ts"
                | "tsx"
                | "mjs"
                | "cjs"
                | "rs"
                | "py"
                | "rb"
                | "go"
                | "java"
                | "c"
                | "h"
                | "cpp"
                | "hpp"
                | "cs"
                | "swift"
                | "kt"
                | "sh"
                | "bash"
                | "zsh"
                | "ps1"
                | "sql"
                | "lua"
                | "vim"
                | "tex"
                | "rst"
                | "env"
        )
}

/// Decode UTF-8 and reject control characters other than LF, CR, and tab.
/// Invalid encoding or a forbidden control character yields `InvalidUtf8`.
pub fn utf8_text(bytes: Vec<u8>) -> Result<String, WorkspaceError> {
    let text = String::from_utf8(bytes).map_err(|_| WorkspaceError::InvalidUtf8)?;
    if text
        .chars()
        .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
    {
        return Err(WorkspaceError::InvalidUtf8);
    }
    Ok(text)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Fingerprint(pub String);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecoveryRecord {
    pub version: u32,
    pub root: PathBuf,
    pub path: Option<String>,
    pub baseline: Option<Fingerprint>,
    pub snapshot: DocumentSnapshot,
}

pub const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;
