//! Containment checks for native staging paths.
use crate::contracts::WorkspaceError;
use std::fs;
use std::path::{Component, Path, PathBuf};

/// Join a relative candidate under root without escapes, devices, or links.
pub fn guard_staging_path(root: &Path, candidate: &Path) -> Result<PathBuf, WorkspaceError> {
    if root.as_os_str().is_empty() {
        return Err(WorkspaceError::InvalidPath);
    }
    // Unix Path components do not recognize Windows drive or rooted paths.
    let portable = candidate.as_os_str().to_string_lossy();
    let bytes = portable.as_bytes();
    if portable.starts_with('\\')
        || (bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':')
    {
        return Err(WorkspaceError::OutsideWorkspace);
    }
    let mut normalized = PathBuf::new();
    for component in candidate.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    return Err(WorkspaceError::OutsideWorkspace);
                }
            }
            Component::Normal(part) => normalized.push(part),
            Component::RootDir | Component::Prefix(_) => {
                return Err(WorkspaceError::OutsideWorkspace);
            }
        }
    }
    if normalized.as_os_str().is_empty() {
        return Err(WorkspaceError::InvalidPath);
    }
    let joined = root.join(&normalized);
    if !joined.starts_with(root) {
        return Err(WorkspaceError::OutsideWorkspace);
    }
    Ok(joined)
}

/// Reject every linked component between the staging root and candidate path.
pub fn check_no_symlink(path: &Path, root: &Path) -> Result<(), WorkspaceError> {
    // Every existing prefix must be a real directory inside root, never a link.
    let mut current = root.to_owned();
    // Validate the root itself once.
    if fs::symlink_metadata(&current)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err(WorkspaceError::OutsideWorkspace);
    }
    if let Ok(rel) = path.strip_prefix(root) {
        for part in rel.components() {
            if let Component::Normal(name) = part {
                current.push(name);
                match fs::symlink_metadata(&current) {
                    Ok(meta) => {
                        if meta.file_type().is_symlink() {
                            return Err(WorkspaceError::OutsideWorkspace);
                        }
                        if current != path && !meta.is_dir() && meta.is_file() {
                            // Intermediate file where a directory is expected.
                            return Err(WorkspaceError::InvalidPath);
                        }
                        if fs::canonicalize(&current)
                            .map(|p| !p.starts_with(root))
                            .unwrap_or(true)
                            && meta.is_dir()
                        {
                            // Canonical check for junctions/reparse points.
                            return Err(WorkspaceError::OutsideWorkspace);
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                        // Missing suffix is fine; remaining components are new.
                        break;
                    }
                    Err(e) => return Err(e.into()),
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    /// Verify absolute, parent-traversal and linked staging paths cannot escape the root.
    fn staging_guard_rejects_escapes() {
        let root = Path::new("/staging");
        assert!(guard_staging_path(root, Path::new("copy_01/notes.md")).is_ok());
        assert!(guard_staging_path(root, Path::new("../live/doc.md")).is_err());
        assert!(guard_staging_path(root, Path::new("/etc/passwd")).is_err());
        assert!(guard_staging_path(Path::new(""), Path::new("copy")).is_err());
    }
}
