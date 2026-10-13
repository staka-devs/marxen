//! Folder-scoped IPC. Commands share the ID registry and actor locks.
use crate::application::workspace::Workspace;
use crate::contracts::WorkspaceEvent;
use std::sync::{Arc, Mutex};

pub struct ActorState {
    pub services: crate::application::ports::DocumentServices,
    pub files: Arc<dyn crate::application::ports::WorkspaceStorage>,
    pub clock: Arc<dyn crate::application::ports::Clock>,
    pub workspace: Arc<Mutex<Option<Workspace>>>,
    pub pending: Arc<Mutex<Vec<WorkspaceEvent>>>,
}
impl ActorState {
    /// Retain injected native dependencies alongside the workspace/event locks.
    pub fn new(
        services: crate::application::ports::DocumentServices,
        files: Arc<dyn crate::application::ports::WorkspaceStorage>,
        clock: Arc<dyn crate::application::ports::Clock>,
    ) -> Self {
        Self {
            services,
            files,
            clock,
            workspace: Arc::new(Mutex::new(None)),
            pending: Arc::new(Mutex::new(Vec::new())),
        }
    }
}
#[cfg(feature = "desktop")]
pub use desktop::*;
#[cfg(feature = "desktop")]
mod desktop {
    use super::*;
    use crate::contracts::*;
    use tauri::Manager;
    /// Serialize a workspace use case under the shared registry lock.
    fn with_workspace<T>(
        state: &ActorState,
        call: impl FnOnce(&mut Workspace) -> Result<T, WorkspaceError>,
    ) -> Result<T, WorkspaceError> {
        let mut guard = state.workspace.lock().map_err(|_| WorkspaceError::Io {
            detail: "workspace lock poisoned".into(),
        })?;
        call(guard.as_mut().ok_or(WorkspaceError::NoWorkspace)?)
    }
    /// Construct the typed document ID and revision boundary for a command.
    fn request(document_id: String, base_revision: u32) -> SaveRequest {
        SaveRequest {
            document_id: DocumentId(document_id),
            base_revision: Revision(base_revision),
        }
    }
    #[tauri::command(async)]
    /// Resolve the app recovery directory and replace only a clean workspace registry.
    pub fn open_workspace(
        app: tauri::AppHandle,
        state: tauri::State<'_, ActorState>,
        path: String,
    ) -> Result<WorkspaceInfo, WorkspaceError> {
        let recovery = app
            .path()
            .app_data_dir()
            .map_err(|e| WorkspaceError::Io {
                detail: e.to_string(),
            })?
            .join("recovery");
        let mut guard = state.workspace.lock().map_err(|_| WorkspaceError::Io {
            detail: "workspace lock poisoned".into(),
        })?;
        if let Some(workspace) = guard.as_ref() {
            workspace.ensure_clean()?;
        }
        let workspace = Workspace::open(
            std::path::Path::new(&path),
            &recovery,
            state.services.clone(),
            state.files.clone(),
            state.clock.clone(),
        )?;
        let info = workspace.info();
        *guard = Some(workspace);
        state
            .pending
            .lock()
            .map_err(|_| WorkspaceError::Io {
                detail: "event lock poisoned".into(),
            })?
            .clear();
        Ok(info)
    }
    #[tauri::command(async)]
    /// Return supported direct workspace children through the registry use case.
    pub fn list_workspace(
        state: tauri::State<'_, ActorState>,
        path: String,
    ) -> Result<Vec<WorkspaceEntry>, WorkspaceError> {
        with_workspace(&state, |w| w.list(&path))
    }
    #[tauri::command(async)]
    /// Return authoritative descriptors for all registered documents.
    pub fn list_documents(
        state: tauri::State<'_, ActorState>,
    ) -> Result<Vec<OpenDocument>, WorkspaceError> {
        with_workspace(&state, |w| w.documents())
    }
    #[tauri::command(async)]
    /// Open a contained Markdown document through the shared registry.
    pub fn open_markdown(
        state: tauri::State<'_, ActorState>,
        path: String,
    ) -> Result<OpenDocument, WorkspaceError> {
        with_workspace(&state, |w| w.open_markdown(&path))
    }
    #[tauri::command(async)]
    /// Open a supported contained text document through the shared registry.
    pub fn open_text_file(
        state: tauri::State<'_, ActorState>,
        path: String,
    ) -> Result<OpenDocument, WorkspaceError> {
        with_workspace(&state, |w| w.open_text_file(&path))
    }
    #[tauri::command(async)]
    /// Return bounded workspace image bytes for the explorer viewer.
    pub fn load_workspace_image(
        state: tauri::State<'_, ActorState>,
        path: String,
    ) -> Result<ImageData, WorkspaceError> {
        with_workspace(&state, |w| w.load_workspace_image(&path))
    }
    #[tauri::command(async)]
    /// Insert a workspace image reference at the caller's exact revision and UTF-16 range.
    pub fn insert_workspace_image(
        state: tauri::State<'_, ActorState>,
        document_id: String,
        base_revision: u32,
        path: String,
        range: Utf16Range,
    ) -> Result<DocumentSnapshot, WorkspaceError> {
        with_workspace(&state, |w| {
            w.insert_workspace_image(request(document_id, base_revision), &path, range)
        })
    }
    #[tauri::command(async)]
    /// Import an external image and insert its reference through the revision-checked use case.
    pub fn import_external_image(
        state: tauri::State<'_, ActorState>,
        document_id: String,
        base_revision: u32,
        path: String,
        range: Utf16Range,
    ) -> Result<PasteResult, WorkspaceError> {
        with_workspace(&state, |w| {
            w.import_external_image(
                request(document_id, base_revision),
                std::path::Path::new(&path),
                range,
            )
        })
    }
    #[tauri::command(async)]
    /// Create a new contained Markdown document through the workspace registry.
    pub fn create_markdown(
        state: tauri::State<'_, ActorState>,
        path: String,
        text: String,
    ) -> Result<OpenDocument, WorkspaceError> {
        with_workspace(&state, |w| w.create(&path, &text))
    }
    #[tauri::command(async)]
    /// Create a new folder inside the active workspace without opening a document.
    pub fn create_folder(
        state: tauri::State<'_, ActorState>,
        path: String,
    ) -> Result<WorkspaceEntry, WorkspaceError> {
        with_workspace(&state, |w| w.create_folder(&path))
    }
    #[tauri::command(async)]
    /// Rename a document only at the supplied revision and a safe workspace destination.
    pub fn rename_markdown(
        state: tauri::State<'_, ActorState>,
        document_id: String,
        base_revision: u32,
        path: String,
    ) -> Result<OpenDocument, WorkspaceError> {
        with_workspace(&state, |w| {
            w.rename(request(document_id, base_revision), &path)
        })
    }
    #[tauri::command(async)]
    /// Register an untitled authoritative buffer through the active workspace.
    pub fn open_document(
        state: tauri::State<'_, ActorState>,
        document_id: String,
        text: String,
        path: Option<String>,
    ) -> Result<DocumentSnapshot, WorkspaceError> {
        if path.is_some() {
            return Err(WorkspaceError::InvalidPath);
        }
        with_workspace(&state, |w| {
            w.open_untitled(DocumentId(document_id), text)
                .map(|d| d.snapshot)
        })
    }
    #[tauri::command(async)]
    /// Return the authoritative document snapshot from the registry actor.
    pub fn fetch_snapshot(
        state: tauri::State<'_, ActorState>,
        document_id: String,
    ) -> Result<DocumentSnapshot, WorkspaceError> {
        with_workspace(&state, |w| Ok(w.actor(&document_id)?.sync_from_nvim()?))
    }
    #[tauri::command(async)]
    /// Validate and apply revision-tagged GUI ranges through the authoritative actor.
    pub fn apply_gui_edits(
        state: tauri::State<'_, ActorState>,
        document_id: String,
        base_revision: u32,
        edits: Vec<TextEdit>,
    ) -> Result<DocumentSnapshot, WorkspaceError> {
        with_workspace(&state, |w| {
            Ok(w.actor(&document_id)?.apply_edits(EditRequest {
                document_id: DocumentId(document_id),
                base_revision: Revision(base_revision),
                source: EditSource::Gui,
                edits,
            })?)
        })
    }
    #[tauri::command(async)]
    /// Save the requested document through the actor's disk conflict contract.
    pub fn save_document(
        state: tauri::State<'_, ActorState>,
        document_id: String,
        base_revision: u32,
    ) -> Result<SaveResult, WorkspaceError> {
        with_workspace(&state, |w| {
            Ok(w.actor(&document_id)?
                .save(request(document_id, base_revision))?)
        })
    }
    #[tauri::command(async)]
    /// Reload disk text through the requested revision-aware actor operation.
    pub fn reload_document(
        state: tauri::State<'_, ActorState>,
        document_id: String,
        base_revision: u32,
    ) -> Result<DocumentSnapshot, WorkspaceError> {
        with_workspace(&state, |w| {
            Ok(w.actor(&document_id)?
                .reload(request(document_id, base_revision))?)
        })
    }
    #[tauri::command(async)]
    /// Apply the explicit close decision before removing the registered actor.
    pub fn close_document(
        state: tauri::State<'_, ActorState>,
        document_id: String,
        base_revision: u32,
        action: CloseAction,
    ) -> Result<bool, WorkspaceError> {
        with_workspace(&state, |w| {
            w.close(request(document_id, base_revision), action)
        })
    }
    #[tauri::command(async)]
    /// Return supported workspace text matches through the registry search use case.
    pub fn search_workspace(
        state: tauri::State<'_, ActorState>,
        query: String,
    ) -> Result<Vec<SearchMatch>, WorkspaceError> {
        with_workspace(&state, |w| w.search(&query))
    }
    #[tauri::command(async)]
    /// Collect pending document, save and disk-change events in registry order.
    pub fn poll_workspace_events(
        state: tauri::State<'_, ActorState>,
    ) -> Result<Vec<WorkspaceEvent>, WorkspaceError> {
        with_workspace(&state, |w| {
            let mut pending = state.pending.lock().map_err(|_| WorkspaceError::Io {
                detail: "event lock poisoned".into(),
            })?;
            let mut events = std::mem::take(&mut *pending);
            events.extend(w.poll());
            Ok(events)
        })
    }
    #[tauri::command(async)]
    /// Return available workspace recovery descriptors.
    pub fn list_recovery(
        state: tauri::State<'_, ActorState>,
    ) -> Result<Vec<RecoveryEntry>, WorkspaceError> {
        with_workspace(&state, |w| w.recovery_entries())
    }
    #[tauri::command(async)]
    /// Restore the selected recovery entry through the registry's containment and conflict checks.
    pub fn restore_recovery(
        state: tauri::State<'_, ActorState>,
        document_id: String,
    ) -> Result<OpenDocument, WorkspaceError> {
        with_workspace(&state, |w| w.restore(&document_id))
    }
    #[tauri::command(async)]
    /// Dismiss the selected recovery entry without changing live documents.
    pub fn discard_recovery(
        state: tauri::State<'_, ActorState>,
        document_id: String,
    ) -> Result<(), WorkspaceError> {
        with_workspace(&state, |w| w.discard_recovery(&document_id))
    }
    #[tauri::command(async)]
    /// Resolve bounded document-relative image bytes through the workspace use case.
    pub fn load_relative_image(
        state: tauri::State<'_, ActorState>,
        document_id: String,
        path: String,
    ) -> Result<ImageData, WorkspaceError> {
        with_workspace(&state, |w| w.load_image(&document_id, &path))
    }
    #[tauri::command(async)]
    /// Import supplied image bytes and replace an exact revision-tagged UTF-16 range.
    pub fn paste_image(
        state: tauri::State<'_, ActorState>,
        document_id: String,
        base_revision: u32,
        name: String,
        bytes: Vec<u8>,
        range: Utf16Range,
    ) -> Result<PasteResult, WorkspaceError> {
        with_workspace(&state, |w| {
            w.paste_image(request(document_id, base_revision), &name, &bytes, range)
        })
    }
    #[tauri::command(async)]
    /// Return the actor's native Vim mode and authoritative revision.
    pub fn fetch_mode(
        state: tauri::State<'_, ActorState>,
        document_id: String,
    ) -> Result<ModeUpdate, WorkspaceError> {
        with_workspace(&state, |w| Ok(w.actor(&document_id)?.current_mode()?))
    }
    #[tauri::command(async)]
    /// Route native keys and return post-yank clipboard side effects in revision order.
    pub fn nvim_input_with_copy(
        state: tauri::State<'_, ActorState>,
        document_id: String,
        base_revision: u32,
        keys: String,
    ) -> Result<VimInputResult, WorkspaceError> {
        with_workspace(&state, |w| {
            Ok(w.actor(&document_id)?
                .input_with_copy(request(document_id, base_revision), &keys)?)
        })
    }
    #[tauri::command(async)]
    /// Query a native mode mapping prefix without interpreting it in presentation.
    pub fn has_nvim_mapping(
        state: tauri::State<'_, ActorState>,
        document_id: String,
        mode: String,
        lhs: String,
    ) -> Result<bool, WorkspaceError> {
        with_workspace(&state, |w| {
            Ok(w.actor(&document_id)?.has_user_mapping(&mode, &lhs)?)
        })
    }
    #[tauri::command(async)]
    /// Undo through the requested actor's authoritative native history.
    pub fn undo_document(
        state: tauri::State<'_, ActorState>,
        document_id: String,
    ) -> Result<DocumentSnapshot, WorkspaceError> {
        with_workspace(&state, |w| Ok(w.actor(&document_id)?.undo()?))
    }
    #[tauri::command(async)]
    /// Redo through the requested actor's authoritative native history.
    pub fn redo_document(
        state: tauri::State<'_, ActorState>,
        document_id: String,
    ) -> Result<DocumentSnapshot, WorkspaceError> {
        with_workspace(&state, |w| Ok(w.actor(&document_id)?.redo()?))
    }
    #[tauri::command(async)]
    /// Feed native Vim key notation at the supplied document revision.
    pub fn nvim_input(
        state: tauri::State<'_, ActorState>,
        document_id: String,
        base_revision: u32,
        keys: String,
    ) -> Result<DocumentSnapshot, WorkspaceError> {
        with_workspace(&state, |w| {
            Ok(w.actor(&document_id)?
                .input_checked(request(document_id, base_revision), &keys)?)
        })
    }
    #[tauri::command(async)]
    /// Return the actor's current native selection in global UTF-16 coordinates.
    pub fn fetch_cursor(
        state: tauri::State<'_, ActorState>,
        document_id: String,
    ) -> Result<CursorUpdate, WorkspaceError> {
        with_workspace(&state, |w| Ok(w.actor(&document_id)?.cursor()?))
    }
    #[tauri::command(async)]
    /// Validate and install a GUI selection through the actor's native cursor operation.
    pub fn report_cursor(
        state: tauri::State<'_, ActorState>,
        document_id: String,
        revision: u32,
        anchor: u32,
        head: u32,
    ) -> Result<CursorUpdate, WorkspaceError> {
        with_workspace(&state, |w| {
            Ok(w.actor(&document_id)?.set_cursor(CursorUpdate {
                document_id: DocumentId(document_id),
                revision: Revision(revision),
                anchor: Utf16Offset(anchor),
                head: Utf16Offset(head),
            })?)
        })
    }
    #[tauri::command(async)]
    /// Return a resized native grid snapshot for the selected document.
    pub fn fetch_grid(
        state: tauri::State<'_, ActorState>,
        document_id: String,
        width: u32,
        height: u32,
    ) -> Result<GridUpdate, WorkspaceError> {
        with_workspace(&state, |w| {
            Ok(w.actor(&document_id)?.grid(width, height)?)
        })
    }
    #[tauri::command(async)]
    /// Apply explicitly selected native configuration through the revision-aware actor.
    pub fn configure_document(
        state: tauri::State<'_, ActorState>,
        document_id: String,
        base_revision: u32,
        path: Option<String>,
    ) -> Result<NvimConfig, WorkspaceError> {
        with_workspace(&state, |w| {
            Ok(w.actor(&document_id)?.configure(
                request(document_id, base_revision),
                path.map(std::path::PathBuf::from),
            )?)
        })
    }
    #[tauri::command(async)]
    /// Return the active configuration source and captured boot errors.
    pub fn fetch_config(
        state: tauri::State<'_, ActorState>,
        document_id: String,
    ) -> Result<NvimConfig, WorkspaceError> {
        with_workspace(&state, |w| {
            let actor = w.actor(&document_id)?;
            Ok(NvimConfig {
                path: Some(actor.config_source()),
                errors: actor
                    .config_errors()
                    .into_iter()
                    .chain(actor.copy_key_errors()?)
                    .collect(),
                copy_keys: actor.copy_keys()?,
            })
        })
    }
}
