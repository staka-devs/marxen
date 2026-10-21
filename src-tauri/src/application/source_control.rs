//! Source-control use cases over an injected Git adapter (Issue #121).

use crate::contracts::{GitStatus, WorkspaceError};
use crate::domain::git::validate_change_path;
use std::path::Path;

/// Read-only Git access for one workspace root.
pub trait SourceControl: Send + Sync {
    /// Return the branch and working-tree changes, or `repository: false` outside Git.
    fn status(&self, root: &Path) -> Result<GitStatus, WorkspaceError>;
    /// Return the unified diff of one path against HEAD; untracked paths diff against empty.
    fn diff(&self, root: &Path, path: &str, untracked: bool) -> Result<String, WorkspaceError>;
}

/// Diff one reported change after refusing paths that could leave the root.
pub fn change_diff(
    git: &dyn SourceControl,
    root: &Path,
    path: &str,
    status: &str,
) -> Result<String, WorkspaceError> {
    validate_change_path(path)?;
    git.diff(root, path, status == "?")
}
