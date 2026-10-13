//! Vim-settings desktop commands over the fingerprint-guarded use case.
//!
//! Thin IPC boundary: resolve the effective path, delegate to the application
//! use case with the injected file adapter, and return fingerprints so the GUI
//! can detect external changes before every save. Unsaved document text is
//! never touched here; applying a saved file still goes through the existing
//! `configure_document` flow which retains buffer text.

use crate::application::vim_settings::{self, VimSettingsFiles};
use crate::contracts::vim_settings::{VimConfigRead, VimConfigWrite, VimSettings};
use crate::contracts::WorkspaceError;
use std::sync::Arc;

/// Injected vim-settings file adapter owned by the composition root.
pub struct VimSettingsState {
    files: Arc<dyn VimSettingsFiles>,
}

impl VimSettingsState {
    /// Retain the injected native file adapter for guarded config access.
    pub fn new(files: Arc<dyn VimSettingsFiles>) -> Self {
        Self { files }
    }
}

#[cfg(feature = "desktop")]
mod desktop {
    use super::*;
    use tauri::Manager;

    /// Resolve the app-data directory owning the standard vim-settings file.
    fn app_data(app: &tauri::AppHandle) -> Result<std::path::PathBuf, WorkspaceError> {
        app.path()
            .app_data_dir()
            .map_err(|error| WorkspaceError::Io {
                detail: error.to_string(),
            })
    }

    #[tauri::command(async)]
    /// Read a vim-settings config with fingerprint and managed parse state.
    pub fn vim_settings_read(
        app: tauri::AppHandle,
        state: tauri::State<'_, VimSettingsState>,
        path: Option<String>,
    ) -> Result<VimConfigRead, WorkspaceError> {
        let effective = vim_settings::resolve_settings_path(path.as_deref(), &app_data(&app)?)?;
        vim_settings::read_settings(state.files.as_ref(), &effective)
    }

    #[tauri::command(async)]
    /// Rewrite only the managed block, refusing stale baselines and Lua targets.
    pub fn vim_settings_write_managed(
        app: tauri::AppHandle,
        state: tauri::State<'_, VimSettingsState>,
        path: Option<String>,
        expected_fingerprint: Option<String>,
        settings: VimSettings,
    ) -> Result<VimConfigWrite, WorkspaceError> {
        let effective = vim_settings::resolve_settings_path(path.as_deref(), &app_data(&app)?)?;
        vim_settings::write_managed_settings(
            state.files.as_ref(),
            &effective,
            expected_fingerprint.as_deref(),
            &settings,
        )
    }

    #[tauri::command(async)]
    /// Store caller-edited raw text verbatim with a stale-file guard.
    pub fn vim_settings_write_raw(
        app: tauri::AppHandle,
        state: tauri::State<'_, VimSettingsState>,
        path: Option<String>,
        expected_fingerprint: Option<String>,
        raw: String,
    ) -> Result<VimConfigWrite, WorkspaceError> {
        let effective = vim_settings::resolve_settings_path(path.as_deref(), &app_data(&app)?)?;
        vim_settings::write_raw_settings(
            state.files.as_ref(),
            &effective,
            expected_fingerprint.as_deref(),
            &raw,
        )
    }
}

#[cfg(feature = "desktop")]
pub use desktop::*;
