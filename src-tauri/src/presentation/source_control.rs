//! Source-control desktop commands: Git status and diffs for registered workspace roots only.

use crate::application::source_control::SourceControl;
use std::sync::Arc;

/// Injected Git adapter owned by the composition root.
pub struct SourceControlState {
    git: Arc<dyn SourceControl>,
}

impl SourceControlState {
    /// Retain the injected native Git adapter.
    pub fn new(git: Arc<dyn SourceControl>) -> Self {
        Self { git }
    }
}

#[cfg(feature = "desktop")]
mod desktop {
    use super::*;
    use crate::application::source_control::{change_diff, head_text};
    use crate::contracts::{GitStatus, RootScope, WorkspaceError};
    use crate::presentation::document::ActorState;
    use std::path::PathBuf;

    /// Resolve a root only through the registry, so arbitrary folders are never queried.
    fn root_of(actors: &ActorState, scope: &RootScope) -> Result<PathBuf, WorkspaceError> {
        let mut guard = actors.workspace.lock().map_err(|_| WorkspaceError::Io {
            detail: "workspace lock poisoned".into(),
        })?;
        Ok(guard.workspace_mut(scope)?.root().to_owned())
    }

    #[tauri::command(async)]
    /// Return the branch and working-tree changes of one registered root.
    pub fn git_status(
        actors: tauri::State<'_, ActorState>,
        state: tauri::State<'_, SourceControlState>,
        scope: RootScope,
    ) -> Result<GitStatus, WorkspaceError> {
        state.git.status(&root_of(&actors, &scope)?)
    }

    #[tauri::command(async)]
    /// Return the unified diff of one reported change against HEAD.
    pub fn git_diff(
        actors: tauri::State<'_, ActorState>,
        state: tauri::State<'_, SourceControlState>,
        scope: RootScope,
        path: String,
        status: String,
    ) -> Result<String, WorkspaceError> {
        change_diff(
            state.git.as_ref(),
            &root_of(&actors, &scope)?,
            &path,
            &status,
        )
    }

    #[tauri::command(async)]
    /// Return one root-relative file's text at HEAD for the editor's change gutter.
    pub fn git_head_text(
        actors: tauri::State<'_, ActorState>,
        state: tauri::State<'_, SourceControlState>,
        scope: RootScope,
        path: String,
    ) -> Result<Option<String>, WorkspaceError> {
        head_text(state.git.as_ref(), &root_of(&actors, &scope)?, &path)
    }
}

#[cfg(feature = "desktop")]
pub use desktop::*;
