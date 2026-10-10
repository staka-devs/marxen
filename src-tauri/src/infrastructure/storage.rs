//! Rust-only disk operations. Text is UTF-8 without newline/BOM conversion.
use crate::contracts::{DocumentSnapshot, WorkspaceError};
use crate::domain::storage::*;

use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

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

impl From<std::io::Error> for WorkspaceError {
    fn from(error: std::io::Error) -> Self {
        Self::Io {
            detail: error.to_string(),
        }
    }
}

use crate::application::ports::{Clock, DirectoryEntry, FileInfo, Storage};
pub struct NativeStorage;
pub struct SystemClock;
impl Clock for SystemClock {
    /// Supply the native clock component of process-local document and copy identifiers.
    fn nanos(&self) -> u128 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    }
}
impl Storage for NativeStorage {
    fn read_disk(&self, path: &Path) -> Result<Option<Vec<u8>>, WorkspaceError> {
        read_disk(path)
    }
    fn disk_fingerprint(&self, path: &Path) -> Result<Option<Fingerprint>, WorkspaceError> {
        disk_fingerprint(path)
    }
    fn resolve(&self, root: &Path, relative: &str) -> Result<PathBuf, WorkspaceError> {
        resolve(root, relative)
    }
    fn check_target(&self, root: Option<&Path>, path: &Path) -> Result<(), WorkspaceError> {
        check_target(root, path)
    }
    fn atomic_write(
        &self,
        path: &Path,
        bytes: &[u8],
        expected: Option<&Fingerprint>,
        root: Option<&Path>,
    ) -> Result<Fingerprint, WorkspaceError> {
        atomic_write(path, bytes, expected, root)
    }
    fn checkpoint(&self, path: &Path, record: &RecoveryRecord) -> Result<(), WorkspaceError> {
        checkpoint(path, record)
    }
    fn remove_checkpoint(&self, path: &Path) -> Result<(), WorkspaceError> {
        remove_checkpoint(path)
    }
    fn read_image_bytes(&self, path: &Path) -> Result<Vec<u8>, WorkspaceError> {
        read_image_bytes(path)
    }

    fn canonicalize(&self, path: &Path) -> Result<PathBuf, WorkspaceError> {
        Ok(fs::canonicalize(path)?)
    }
    fn create_dir_all(&self, path: &Path) -> Result<(), WorkspaceError> {
        Ok(fs::create_dir_all(path)?)
    }
    fn create_dir(&self, path: &Path) -> Result<(), WorkspaceError> {
        Ok(fs::create_dir(path)?)
    }
    fn metadata(&self, path: &Path) -> Result<FileInfo, WorkspaceError> {
        let m = fs::symlink_metadata(path)?;
        Ok(FileInfo {
            directory: m.is_dir(),
            regular: m.is_file(),
            link: m.file_type().is_symlink(),
        })
    }
    fn read_dir(&self, path: &Path) -> Result<Vec<DirectoryEntry>, WorkspaceError> {
        fs::read_dir(path)?
            .map(|entry| {
                let entry = entry?;
                let m = entry.file_type()?;
                Ok(DirectoryEntry {
                    path: entry.path(),
                    info: FileInfo {
                        directory: m.is_dir(),
                        regular: m.is_file(),
                        link: m.is_symlink(),
                    },
                })
            })
            .collect()
    }
    fn hard_link(&self, source: &Path, target: &Path) -> Result<(), WorkspaceError> {
        fs::hard_link(source, target).map_err(|e| {
            if e.kind() == std::io::ErrorKind::AlreadyExists {
                WorkspaceError::AlreadyExists
            } else {
                e.into()
            }
        })
    }
    fn remove_file(&self, path: &Path) -> Result<(), WorkspaceError> {
        Ok(fs::remove_file(path)?)
    }
    fn write_staging(&self, path: &Path, bytes: &[u8]) -> Result<(), WorkspaceError> {
        Ok(fs::write(path, bytes)?)
    }
    fn remove_staging(&self, path: &Path) -> Result<(), WorkspaceError> {
        Ok(fs::remove_dir_all(path)?)
    }
    fn guard_staging_path(&self, root: &Path, candidate: &Path) -> Result<PathBuf, WorkspaceError> {
        super::staging::guard_staging_path(root, candidate)
    }
    fn check_no_symlink(&self, path: &Path, root: &Path) -> Result<(), WorkspaceError> {
        super::staging::check_no_symlink(path, root)
    }
}
