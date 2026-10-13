//! Rust-only disk operations. Text is UTF-8 without newline/BOM conversion.
use crate::contracts::{DocumentSnapshot, WorkspaceError};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Fingerprint(pub String);

pub fn fingerprint(bytes: &[u8]) -> Fingerprint {
    Fingerprint(format!("{:x}", Sha256::digest(bytes)))
}

pub fn read_disk(path: &Path) -> Result<Option<Vec<u8>>, WorkspaceError> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => Err(WorkspaceError::OutsideWorkspace),
        Ok(meta) if !meta.is_file() => Err(WorkspaceError::InvalidPath),
        Ok(_) => Ok(Some(fs::read(path)?)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn disk_fingerprint(path: &Path) -> Result<Option<Fingerprint>, WorkspaceError> {
    Ok(read_disk(path)?.map(|bytes| fingerprint(&bytes)))
}

/// Only portable relative names: no parent traversal, devices, ADS, or links.
pub fn resolve(root: &Path, relative: &str) -> Result<PathBuf, WorkspaceError> {
    if relative.contains(['\\', ':', '\0']) {
        return Err(WorkspaceError::InvalidPath);
    }
    let mut target = root.to_owned();
    for part in Path::new(relative).components() {
        let Component::Normal(name) = part else {
            return Err(WorkspaceError::InvalidPath);
        };
        let name = name.to_str().ok_or(WorkspaceError::InvalidPath)?;
        let stem = name
            .split('.')
            .next()
            .unwrap_or_default()
            .to_ascii_uppercase();
        if name.ends_with(['.', ' '])
            || name.contains(['<', '>', '"', '|', '?', '*'])
            || name.chars().any(char::is_control)
            || name.starts_with(".marxen-")
            || matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || (stem.len() == 4
                && (stem.starts_with("COM") || stem.starts_with("LPT"))
                && matches!(stem.as_bytes()[3], b'1'..=b'9'))
        {
            return Err(WorkspaceError::InvalidPath);
        }
        target.push(name);
        match fs::symlink_metadata(&target) {
            Ok(meta) => {
                if meta.file_type().is_symlink() || !fs::canonicalize(&target)?.starts_with(root) {
                    return Err(WorkspaceError::OutsideWorkspace);
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
    }
    // Resolve the existing parent even when the leaf doesn't exist.
    if target != root {
        let parent = fs::canonicalize(target.parent().ok_or(WorkspaceError::InvalidPath)?)?;
        if !parent.starts_with(root) {
            return Err(WorkspaceError::OutsideWorkspace);
        }
    }
    Ok(target)
}

pub fn markdown(path: &Path) -> bool {
    path.extension()
        .and_then(|s| s.to_str())
        .is_some_and(|s| s.eq_ignore_ascii_case("md") || s.eq_ignore_ascii_case("markdown"))
}

pub fn relative(root: &Path, path: &Path) -> Result<String, WorkspaceError> {
    path.strip_prefix(root)
        .map_err(|_| WorkspaceError::OutsideWorkspace)?
        .to_str()
        .map(|s| s.replace('\\', "/"))
        .ok_or(WorkspaceError::InvalidPath)
}

pub fn check_target(root: Option<&Path>, path: &Path) -> Result<(), WorkspaceError> {
    if let Some(root) = root {
        let resolved = resolve(root, &relative(root, path)?)?;
        if resolved != path {
            return Err(WorkspaceError::OutsideWorkspace);
        }
    }
    Ok(())
}

/// A staged, synced file is committed only if the expected bytes still match.
/// Missing targets use persist_noclobber, so create never overwrites a race.
pub fn atomic_write(
    path: &Path,
    bytes: &[u8],
    expected: Option<&Fingerprint>,
    root: Option<&Path>,
) -> Result<Fingerprint, WorkspaceError> {
    check_target(root, path)?;
    if disk_fingerprint(path)?.as_ref() != expected {
        return Err(WorkspaceError::Conflict {
            path: path.display().to_string(),
        });
    }
    if let Ok(meta) = fs::metadata(path) {
        if meta.permissions().readonly() {
            return Err(WorkspaceError::Io {
                detail: "file is read-only".into(),
            });
        }
    }
    let parent = path.parent().ok_or(WorkspaceError::InvalidPath)?;
    let mut temporary = tempfile::Builder::new()
        .prefix(".marxen-save-")
        .tempfile_in(parent)?;
    temporary.write_all(bytes)?;
    if let Ok(meta) = fs::metadata(path) {
        temporary.as_file().set_permissions(meta.permissions())?;
    }
    temporary.as_file().sync_all()?;
    check_target(root, path)?;
    if disk_fingerprint(path)?.as_ref() != expected {
        return Err(WorkspaceError::Conflict {
            path: path.display().to_string(),
        });
    }
    #[cfg(windows)]
    if expected.is_some() {
        replace_windows(temporary, path)?;
        return Ok(fingerprint(bytes));
    }
    let committed = if expected.is_some() {
        temporary.persist(path)
    } else {
        temporary.persist_noclobber(path)
    };
    match committed {
        Ok(file) => {
            file.sync_all()?;
        }
        Err(e) if e.error.kind() == std::io::ErrorKind::AlreadyExists => {
            return Err(WorkspaceError::AlreadyExists);
        }
        Err(e) => return Err(e.error.into()),
    }
    sync_directory(parent)?;
    Ok(fingerprint(bytes))
}

pub fn sync_directory(path: &Path) -> Result<(), WorkspaceError> {
    #[cfg(unix)]
    fs::File::open(path)?.sync_all()?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecoveryRecord {
    pub version: u32,
    pub root: PathBuf,
    pub path: Option<String>,
    pub baseline: Option<Fingerprint>,
    pub snapshot: DocumentSnapshot,
}

pub fn checkpoint(path: &Path, record: &RecoveryRecord) -> Result<(), WorkspaceError> {
    let bytes = serde_json::to_vec(record).map_err(|e| WorkspaceError::Io {
        detail: e.to_string(),
    })?;
    let current = read_disk(path)?;
    if current.as_deref() == Some(bytes.as_slice()) {
        return Ok(());
    }
    atomic_write(
        path,
        &bytes,
        current.as_ref().map(|b| fingerprint(b)).as_ref(),
        None,
    )?;
    Ok(())
}

pub fn remove_checkpoint(path: &Path) -> Result<(), WorkspaceError> {
    match fs::remove_file(path) {
        Ok(()) => sync_directory(path.parent().ok_or(WorkspaceError::InvalidPath)?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

/// ReplaceFileW preserves the original DACL, creation time, and named streams.
/// A same-volume backup guards Windows' documented partial failure states.
#[cfg(windows)]
fn replace_windows(temporary: tempfile::NamedTempFile, path: &Path) -> Result<(), WorkspaceError> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::ReplaceFileW;
    let parent = path.parent().ok_or(WorkspaceError::InvalidPath)?;
    let backup_dir = tempfile::Builder::new()
        .prefix(".marxen-backup-")
        .tempdir_in(parent)?;
    let backup = backup_dir.path().join("original");
    // ReplaceFileW opens the replacement exclusively; close its writer first.
    let staged = temporary.into_temp_path();
    let wide = |p: &Path| {
        p.as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>()
    };
    let target_w = wide(path);
    let staged_w = wide(&staged);
    let backup_w = wide(&backup);
    // SAFETY: all strings are live NUL-terminated UTF-16; optional pointers are
    // null as required by Win32, and no merge/ACL errors are ignored.
    let result = unsafe {
        ReplaceFileW(
            target_w.as_ptr(),
            staged_w.as_ptr(),
            backup_w.as_ptr(),
            0,
            std::ptr::null(),
            std::ptr::null(),
        )
    };
    if result == 0 {
        let error = std::io::Error::last_os_error();
        if backup.exists() {
            // Do not clobber a destination created by another process.
            if !path.exists() && fs::hard_link(&backup, path).is_ok() {
                fs::remove_file(&backup)?;
            }
            if backup.exists() {
                let kept = backup_dir.keep();
                return Err(WorkspaceError::Io {
                    detail: format!(
                        "replace failed: {error}; original retained at {}",
                        kept.join("original").display()
                    ),
                });
            }
        }
        return Err(error.into());
    }
    fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)?
        .sync_all()?;
    backup_dir.close()?;
    Ok(())
}

pub const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;

/// Bound allocation and read even when a dropped file grows concurrently.
pub fn read_image_bytes(path: &Path) -> Result<Vec<u8>, WorkspaceError> {
    let meta = fs::symlink_metadata(path)?;
    if meta.file_type().is_symlink() || !meta.is_file() || meta.len() > MAX_IMAGE_BYTES as u64 {
        return Err(WorkspaceError::InvalidImage);
    }
    let mut bytes = Vec::new();
    fs::File::open(path)?
        .take(MAX_IMAGE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(WorkspaceError::InvalidImage);
    }
    Ok(bytes)
}

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
