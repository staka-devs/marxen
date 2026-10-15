//! Rust-only disk operations. Text is UTF-8 without newline/BOM conversion.
use crate::contracts::WorkspaceError;
use crate::domain::storage::*;

use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

/// Read file bytes, returning None only when the file is missing.
pub fn read_disk(path: &Path) -> Result<Option<Vec<u8>>, WorkspaceError> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => Err(WorkspaceError::OutsideWorkspace),
        Ok(meta) if !meta.is_file() => Err(WorkspaceError::InvalidPath),
        Ok(_) => Ok(Some(fs::read(path)?)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Compute the disk content fingerprint while retaining missing-file semantics.
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

/// Reject directories, unsafe links and destinations outside the optional workspace root.
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

/// Flush directory metadata after a durable file replacement on supported platforms.
pub fn sync_directory(path: &Path) -> Result<(), WorkspaceError> {
    #[cfg(unix)]
    fs::File::open(path)?.sync_all()?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

/// Move one directory without overwriting, refusing links, files, and existing destinations.
pub fn rename_dir(source: &Path, target: &Path) -> Result<(), WorkspaceError> {
    match fs::symlink_metadata(source) {
        Ok(meta) if meta.file_type().is_symlink() => return Err(WorkspaceError::OutsideWorkspace),
        Ok(meta) if !meta.is_dir() => return Err(WorkspaceError::InvalidPath),
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(WorkspaceError::NotFound),
        Err(e) => return Err(e.into()),
    }
    if let Err(e) = rename_no_replace(source, target) {
        if e.kind() == std::io::ErrorKind::AlreadyExists {
            return Err(WorkspaceError::AlreadyExists);
        }
        return Err(e.into());
    }
    if let Some(parent) = target.parent() {
        sync_directory(parent)?;
    }
    Ok(())
}

/// Commit a same-volume move with the Windows default refusal to replace a destination.
#[cfg(windows)]
fn rename_no_replace(source: &Path, target: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_WRITE_THROUGH};
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    // SAFETY: both pointers reference live NUL-terminated UTF-16 paths. No replace flag is set.
    if unsafe { MoveFileExW(source.as_ptr(), target.as_ptr(), MOVEFILE_WRITE_THROUGH) } == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

/// Commit a Unix move with the platform's atomic no-replace flag, failing closed if unsupported.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn rename_no_replace(source: &Path, target: &Path) -> std::io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let source = CString::new(source.as_os_str().as_bytes())?;
    let target = CString::new(target.as_os_str().as_bytes())?;
    // SAFETY: both pointers reference live NUL-terminated paths; flags prohibit replacement.
    #[cfg(target_os = "linux")]
    let result = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            source.as_ptr(),
            libc::AT_FDCWD,
            target.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    // SAFETY: both pointers reference live NUL-terminated paths; RENAME_EXCL prohibits replacement.
    #[cfg(target_os = "macos")]
    let result = unsafe { libc::renamex_np(source.as_ptr(), target.as_ptr(), libc::RENAME_EXCL) };
    if result != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

/// Refuse platforms without an atomic no-replace directory operation.
#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
fn rename_no_replace(_source: &Path, _target: &Path) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "atomic no-replace rename unavailable",
    ))
}

/// Atomically persist a serialized recovery record independently of the live file.
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

/// Remove a recovery record while accepting an already absent file.
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
    /// Preserve a native I/O failure as a structured workspace error.
    fn from(error: std::io::Error) -> Self {
        Self::Io {
            detail: error.to_string(),
        }
    }
}

use crate::application::ports::{
    Clock, DirectoryEntry, DirectoryStorage, DocumentStorage, FileInfo, FileReader, StagingStorage,
    WorkspaceStorage,
};
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
impl FileReader for NativeStorage {
    /// Delegate optional file reads to the native filesystem helper.
    fn read_disk(&self, path: &Path) -> Result<Option<Vec<u8>>, WorkspaceError> {
        read_disk(path)
    }
    /// Delegate disk conflict fingerprints to the native read helper.
    fn disk_fingerprint(&self, path: &Path) -> Result<Option<Fingerprint>, WorkspaceError> {
        disk_fingerprint(path)
    }
}
impl DocumentStorage for NativeStorage {
    /// Remove one guarded file through the native filesystem.
    fn remove_file(&self, path: &Path) -> Result<(), WorkspaceError> {
        Ok(fs::remove_file(path)?)
    }

    /// Create a non-overwriting link and retain the structured AlreadyExists error.
    fn hard_link(&self, source: &Path, target: &Path) -> Result<(), WorkspaceError> {
        fs::hard_link(source, target).map_err(|e| {
            if e.kind() == std::io::ErrorKind::AlreadyExists {
                WorkspaceError::AlreadyExists
            } else {
                e.into()
            }
        })
    }

    /// Delegate save-destination containment checks to the shared native helper.
    fn check_target(&self, root: Option<&Path>, path: &Path) -> Result<(), WorkspaceError> {
        check_target(root, path)
    }
    /// Delegate conflict-checked atomic replacement to the native durable-write helper.
    fn atomic_write(
        &self,
        path: &Path,
        bytes: &[u8],
        expected: Option<&Fingerprint>,
        root: Option<&Path>,
    ) -> Result<Fingerprint, WorkspaceError> {
        atomic_write(path, bytes, expected, root)
    }
    /// Delegate recovery record persistence to the shared atomic checkpoint helper.
    fn checkpoint(&self, path: &Path, record: &RecoveryRecord) -> Result<(), WorkspaceError> {
        checkpoint(path, record)
    }
    /// Delegate recovery record dismissal to the idempotent native helper.
    fn remove_checkpoint(&self, path: &Path) -> Result<(), WorkspaceError> {
        remove_checkpoint(path)
    }
}
impl DirectoryStorage for NativeStorage {
    /// Resolve the supplied filesystem path to its canonical absolute target.
    fn canonicalize(&self, path: &Path) -> Result<PathBuf, WorkspaceError> {
        Ok(fs::canonicalize(path)?)
    }
    /// Create a required directory hierarchy through the native filesystem.
    fn create_dir_all(&self, path: &Path) -> Result<(), WorkspaceError> {
        Ok(fs::create_dir_all(path)?)
    }
    /// Create one new directory and preserve native existing-entry failures.
    fn create_dir(&self, path: &Path) -> Result<(), WorkspaceError> {
        Ok(fs::create_dir(path)?)
    }
    /// Move one directory without overwriting, refusing links and missing sources.
    fn rename_dir(&self, source: &Path, target: &Path) -> Result<(), WorkspaceError> {
        rename_dir(source, target)
    }
    /// Read symlink-aware native entry metadata for containment decisions.
    fn metadata(&self, path: &Path) -> Result<FileInfo, WorkspaceError> {
        let m = fs::symlink_metadata(path)?;
        Ok(FileInfo {
            directory: m.is_dir(),
            regular: m.is_file(),
            link: m.file_type().is_symlink(),
        })
    }
    /// Query path existence through the native filesystem adapter.
    fn exists(&self, path: &Path) -> bool {
        path.exists()
    }
}
impl WorkspaceStorage for NativeStorage {
    /// Bound directory enumeration before allocating entries for search traversal.
    fn read_search_entries(
        &self,
        path: &Path,
        limit: usize,
    ) -> Result<(Vec<DirectoryEntry>, bool), WorkspaceError> {
        let mut entries = Vec::new();
        let mut truncated = false;
        for entry in fs::read_dir(path)?.take(limit + 1) {
            let entry = entry?;
            if entries.len() == limit {
                truncated = true;
                break;
            }
            let metadata = entry.file_type()?;
            entries.push(DirectoryEntry {
                path: entry.path(),
                info: FileInfo {
                    directory: metadata.is_dir(),
                    regular: metadata.is_file(),
                    link: metadata.is_symlink(),
                },
            });
        }
        entries.sort_by_key(|entry| entry.path());
        Ok((entries, truncated))
    }
    /// Bound disk allocation before decoding text for native search.
    fn read_search_text(&self, path: &Path, limit: usize) -> Result<String, WorkspaceError> {
        let metadata = fs::symlink_metadata(path)?;
        if metadata.file_type().is_symlink() {
            return Err(WorkspaceError::OutsideWorkspace);
        }
        if !metadata.is_file() {
            return Err(WorkspaceError::InvalidPath);
        }
        if metadata.len() > limit as u64 {
            return Err(WorkspaceError::SearchIncomplete);
        }
        let mut bytes = Vec::new();
        fs::File::open(path)?
            .take(limit as u64 + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() > limit {
            return Err(WorkspaceError::SearchIncomplete);
        }
        String::from_utf8(bytes).map_err(|_| WorkspaceError::InvalidUtf8)
    }
    /// Delegate canonical workspace path resolution to the shared containment helper.
    fn resolve(&self, root: &Path, relative: &str) -> Result<PathBuf, WorkspaceError> {
        resolve(root, relative)
    }
    /// Delegate image reads to the shared size-bounded native helper.
    fn read_image_bytes(&self, path: &Path) -> Result<Vec<u8>, WorkspaceError> {
        read_image_bytes(path)
    }
    /// Enumerate direct native children with their captured directory, file and link kinds.
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
}
impl StagingStorage for NativeStorage {
    /// Write proposal bytes to the use case's already guarded staging destination.
    fn write_staging(&self, path: &Path, bytes: &[u8]) -> Result<(), WorkspaceError> {
        Ok(fs::write(path, bytes)?)
    }
    /// Remove the use case's guarded completed staging directory recursively.
    fn remove_staging(&self, path: &Path) -> Result<(), WorkspaceError> {
        Ok(fs::remove_dir_all(path)?)
    }
    /// Delegate staging-relative path validation to the shared native containment helper.
    fn guard_staging_path(&self, root: &Path, candidate: &Path) -> Result<PathBuf, WorkspaceError> {
        super::staging::guard_staging_path(root, candidate)
    }
    /// Delegate staging component link rejection to the native containment helper.
    fn check_no_symlink(&self, path: &Path, root: &Path) -> Result<(), WorkspaceError> {
        super::staging::check_no_symlink(path, root)
    }
    /// Walk one staging directory, returning regular files without following symlinks.
    fn list_staging_files(&self, dir: &Path) -> Result<Vec<PathBuf>, WorkspaceError> {
        let mut out = Vec::new();
        let mut stack = vec![dir.to_owned()];
        while let Some(current) = stack.pop() {
            let entries = fs::read_dir(&current).map_err(|_| WorkspaceError::NotFound)?;
            for entry in entries.flatten() {
                let path = entry.path();
                let kind = entry.file_type().map_err(|_| WorkspaceError::NotFound)?;
                if kind.is_symlink() {
                    continue;
                }
                if kind.is_dir() {
                    stack.push(path);
                    continue;
                }
                out.push(path);
            }
        }
        out.sort();
        Ok(out)
    }
}

#[cfg(test)]
mod rename_tests {
    use super::*;
    use std::sync::{Arc, Barrier};

    #[test]
    /// Reject an existing empty directory at the OS commit rather than replacing it on Unix.
    fn no_replace_rejects_empty_directory_at_commit() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        let target = root.path().join("target");
        fs::create_dir(&source).unwrap();
        fs::create_dir(&target).unwrap();
        fs::write(source.join("original"), "kept").unwrap();
        assert_eq!(
            rename_no_replace(&source, &target).unwrap_err().kind(),
            std::io::ErrorKind::AlreadyExists
        );
        assert!(source.join("original").is_file());
        assert!(fs::read_dir(target).unwrap().next().is_none());
    }

    #[test]
    /// Let exactly one concurrent directory move win without deleting either contender's contents.
    fn concurrent_directory_renames_never_replace_the_winner() {
        let root = tempfile::tempdir().unwrap();
        let barrier = Arc::new(Barrier::new(2));
        let target = root.path().join("target");
        let workers: Vec<_> = (0..2)
            .map(|index| {
                let source = root.path().join(format!("source{index}"));
                fs::create_dir(&source).unwrap();
                fs::write(source.join("content"), index.to_string()).unwrap();
                let target = target.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    rename_dir(&source, &target)
                })
            })
            .collect();
        let results: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter(|result| matches!(result, Err(WorkspaceError::AlreadyExists)))
                .count(),
            1
        );
        let winner = fs::read_to_string(target.join("content")).unwrap();
        let loser = if winner == "0" { "1" } else { "0" };
        assert_eq!(
            fs::read_to_string(root.path().join(format!("source{loser}/content"))).unwrap(),
            loser
        );
    }
}
