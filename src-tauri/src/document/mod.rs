//! Authoritative document actor: Neovim buffer is truth, Rust serializes access.
//!
//! All GUI / AI range edits enter through [`DocumentActor::apply_edits`]
//! with an exact `base_revision`. The actor validates against the current
//! snapshot ([`crate::validation`]), converts global UTF-16 ranges to Neovim
//! `(row, UTF-8 byte col)` ([`crate::neovim::coordinates`]), applies them tail
//! first via `nvim_buf_set_text`, re-reads the buffer, and bumps the revision
//! exactly once. Stale revisions are rejected so callers resync from the
//! returned snapshot. `:w` never writes from Lua; [`DocumentActor::save`]
//! writes the file with Rust and only clears `dirty`.
//!
//! Vim-side changes (mappings, macros, `u`) bypass `apply_edits`; they are
//! picked up by [`DocumentActor::sync_from_nvim`] / [`undo`] /
//! [`input_via_nvim`], which re-read the buffer and mint a new `Neovim`-sourced
//! revision. Native undo history is therefore shared: a GUI range edit is a
//! normal buffer change that `u` reverts.

use crate::contracts::{
    ContractError, CursorUpdate, DocumentEvent, DocumentId, DocumentSnapshot, EditRequest,
    ModeUpdate, Revision, SaveRequest, SaveResult, VimMode,
};
use crate::neovim::config::ConfigSource;
use crate::neovim::coordinates::global_utf16_to_line_byte;
use crate::neovim::{rpc::RpcError, NeovimSession};
use crate::validation::{
    next_revision, validate_cursor, validate_document_id, validate_edit, validate_save,
};
use std::path::PathBuf;
use std::sync::Mutex;

#[derive(Debug)]
pub enum ActorError {
    Contract(ContractError),
    Nvim(String),
}

impl std::fmt::Display for ActorError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Contract(error) => write!(f, "contract: {error:?}"),
            Self::Nvim(detail) => write!(f, "neovim: {detail}"),
        }
    }
}

impl std::error::Error for ActorError {}

impl From<ContractError> for ActorError {
    fn from(error: ContractError) -> Self {
        Self::Contract(error)
    }
}

impl From<RpcError> for ActorError {
    fn from(error: RpcError) -> Self {
        Self::Nvim(error.to_string())
    }
}

struct ActorState {
    snapshot: DocumentSnapshot,
    nvim: NeovimSession,
    path: Option<PathBuf>,
}

/// Serialized owner of one document's Neovim buffer, snapshot, and file path.
pub struct DocumentActor {
    state: Mutex<ActorState>,
}

impl DocumentActor {
    /// Open a new authoritative buffer with `initial_text` at revision 0.
    pub fn open(
        document_id: DocumentId,
        initial_text: String,
        path: Option<PathBuf>,
    ) -> Result<Self, ActorError> {
        Self::open_with_config(document_id, initial_text, path, ConfigSource::Isolated)
    }

    pub fn open_with_config(
        document_id: DocumentId,
        initial_text: String,
        path: Option<PathBuf>,
        config: ConfigSource,
    ) -> Result<Self, ActorError> {
        validate_document_id(&document_id)?;
        let nvim = NeovimSession::spawn_with_config(config).map_err(ActorError::Nvim)?;
        // Headless embed only processes typed input / mode changes with a UI
        // attached (verified: `nvim_input("i")` stays Normal without one).
        // Attach a minimal UI so mappings, insert, and grid all work.
        crate::neovim::grid::attach(nvim.client(), 80, 24)?;
        // Name the buffer when a file path is known so `:w` has a target and
        // `BufWriteCmd` interception fires instead of E32 on unnamed buffers.
        if let Some(path) = &path {
            // Best-effort: a duplicate or missing-file name must not fail open.
            let _ = nvim.set_buf_name(&path.to_string_lossy());
        }
        nvim.set_text(&initial_text)?;
        // Keep undo history anchored at the initial content: one clean change
        // so the first GUI edit is a single `undo` step back to initial.
        nvim.command("silent! setlocal nomodified")?;
        let snapshot = DocumentSnapshot {
            document_id,
            revision: Revision(0),
            text: nvim.get_text()?,
            dirty: false,
        };
        debug_assert_eq!(snapshot.text, initial_text);
        Ok(Self {
            state: Mutex::new(ActorState {
                snapshot,
                nvim,
                path,
            }),
        })
    }

    /// Current snapshot (cheap clone under the actor lock).
    pub fn snapshot(&self) -> DocumentSnapshot {
        self.state
            .lock()
            .map(|state| state.snapshot.clone())
            .expect("document actor lock poisoned")
    }

    pub fn config_source(&self) -> String {
        self.state
            .lock()
            .map(|state| state.nvim.config_report().source.clone())
            .expect("document actor lock poisoned")
    }

    pub fn config_errors(&self) -> Vec<String> {
        self.state
            .lock()
            .map(|state| state.nvim.config_report().errors.clone())
            .expect("document actor lock poisoned")
    }

    /// Apply GUI/AI range edits validated against `base_revision`.
    pub fn apply_edits(&self, request: EditRequest) -> Result<DocumentSnapshot, ActorError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| ActorError::Nvim("document lock poisoned".into()))?;
        // Pick up any Vim-side drift first so a stale base is reported
        // truthfully instead of applied on the wrong text.
        Self::sync_locked(&mut state)?;
        let byte_ranges = validate_edit(&state.snapshot, &request)?;
        // Convert global ranges to (row, col) against the base text, then
        // apply tail-first so earlier offsets stay valid.
        let mut positioned = Vec::with_capacity(byte_ranges.len());
        for (index, byte_range) in byte_ranges.into_iter().enumerate() {
            let edit = &request.edits[index];
            let (start_row, start_col) =
                global_utf16_to_line_byte(&state.snapshot.text, edit.range.start)?;
            let (end_row, end_col) =
                global_utf16_to_line_byte(&state.snapshot.text, edit.range.end)?;
            let _ = byte_range;
            positioned.push((start_row, start_col, end_row, end_col, edit.text.clone()));
        }
        for (start_row, start_col, end_row, end_col, replacement) in positioned.into_iter().rev() {
            state
                .nvim
                .set_text_range(start_row, start_col, end_row, end_col, &replacement)?;
        }
        let text = state.nvim.get_text()?;
        let revision = next_revision(state.snapshot.revision)?;
        state.snapshot = DocumentSnapshot {
            document_id: state.snapshot.document_id.clone(),
            revision,
            text,
            dirty: true,
        };
        Ok(state.snapshot.clone())
    }

    /// Re-read the Neovim buffer. When Vim-side keys, mappings, or undo
    /// changed the text, mint a new revision (dirty) and return it.
    pub fn sync_from_nvim(&self) -> Result<DocumentSnapshot, ActorError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| ActorError::Nvim("document lock poisoned".into()))?;
        Self::sync_locked(&mut state)?;
        Ok(state.snapshot.clone())
    }

    /// Feed keys through real Neovim (mappings/macros fire), then sync.
    /// Test and Vim-path entry point; GUI edits must use [`apply_edits`].
    pub fn input_via_nvim(&self, keys: &str) -> Result<DocumentSnapshot, ActorError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| ActorError::Nvim("document lock poisoned".into()))?;
        state.nvim.input(keys)?;
        // `nvim_input` queues keys; flush with a no-op request before reading.
        let _ = state.nvim.mode();
        Self::sync_locked(&mut state)?;
        Ok(state.snapshot.clone())
    }

    /// Native `undo` (shared history with GUI edits), then sync.
    pub fn undo(&self) -> Result<DocumentSnapshot, ActorError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| ActorError::Nvim("document lock poisoned".into()))?;
        state.nvim.undo()?;
        let _ = state.nvim.mode();
        Self::sync_locked(&mut state)?;
        Ok(state.snapshot.clone())
    }

    pub fn redo(&self) -> Result<DocumentSnapshot, ActorError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| ActorError::Nvim("document lock poisoned".into()))?;
        state.nvim.redo()?;
        let _ = state.nvim.mode();
        Self::sync_locked(&mut state)?;
        Ok(state.snapshot.clone())
    }

    /// Rust-owned save (`:w` delegates here). Validates the exact revision,
    /// writes the buffer text to `path`, clears `dirty`, keeps the revision.
    pub fn save(&self, request: SaveRequest) -> Result<SaveResult, ActorError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| ActorError::Nvim("document lock poisoned".into()))?;
        Self::sync_locked(&mut state)?;
        validate_save(&state.snapshot, &request)?;
        let path = state.path.clone().ok_or_else(|| {
            ActorError::Nvim("no file path for document; save requires a path".into())
        })?;
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)
                    .map_err(|cause| ActorError::Nvim(format!("create dirs: {cause}")))?;
            }
        }
        std::fs::write(&path, state.snapshot.text.as_bytes())
            .map_err(|cause| ActorError::Nvim(format!("write {}: {cause}", path.display())))?;
        state.snapshot.dirty = false;
        Ok(SaveResult {
            document_id: state.snapshot.document_id.clone(),
            revision: state.snapshot.revision,
            dirty: false,
        })
    }

    /// Current Vim mode paired with the latest revision.
    pub fn current_mode(&self) -> Result<ModeUpdate, ActorError> {
        let state = self
            .state
            .lock()
            .map_err(|_| ActorError::Nvim("document lock poisoned".into()))?;
        let mode: VimMode = state.nvim.mode()?;
        Ok(ModeUpdate {
            document_id: state.snapshot.document_id.clone(),
            revision: state.snapshot.revision,
            mode,
        })
    }

    /// Validate a GUI-reported cursor against the current snapshot.
    /// Accepts reversed (anchor > head) selections; never bumps the revision.
    pub fn check_cursor(&self, update: CursorUpdate) -> Result<CursorUpdate, ActorError> {
        let state = self
            .state
            .lock()
            .map_err(|_| ActorError::Nvim("document lock poisoned".into()))?;
        validate_cursor(&state.snapshot, &update)?;
        Ok(update)
    }

    /// Install the `:w` -> Rust interception (`BufWriteCmd` notifies, never writes).
    pub fn install_save_intercept(&self) -> Result<(), ActorError> {
        let state = self
            .state
            .lock()
            .map_err(|_| ActorError::Nvim("document lock poisoned".into()))?;
        state.nvim.install_save_intercept()?;
        Ok(())
    }

    /// Test/maintenance escape hatch: run one Neovim command on the owned buffer.
    pub fn nvim_command(&self, cmd: &str) -> Result<(), ActorError> {
        let state = self
            .state
            .lock()
            .map_err(|_| ActorError::Nvim("document lock poisoned".into()))?;
        state.nvim.command(cmd)?;
        Ok(())
    }

    /// Buffer text re-read without minting a revision when unchanged.
    pub fn buffer_text(&self) -> Result<String, ActorError> {
        let state = self
            .state
            .lock()
            .map_err(|_| ActorError::Nvim("document lock poisoned".into()))?;
        Ok(state.nvim.get_text()?)
    }

    /// Drain pending `marxen:save-requested` methods (all params dropped).
    pub fn drain_save_requests(&self) -> Vec<String> {
        self.state
            .lock()
            .map(|state| {
                state
                    .nvim
                    .drain_save_requests()
                    .into_iter()
                    .map(|note| note.method)
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Snapshot event for IPC emission.
    pub fn snapshot_event(&self) -> DocumentEvent {
        DocumentEvent::Snapshot(self.snapshot())
    }

    fn sync_locked(state: &mut ActorState) -> Result<bool, ActorError> {
        let text = state.nvim.get_text()?;
        if text == state.snapshot.text {
            return Ok(false);
        }
        let revision = next_revision(state.snapshot.revision)?;
        state.snapshot = DocumentSnapshot {
            document_id: state.snapshot.document_id.clone(),
            revision,
            text,
            dirty: true,
        };
        Ok(true)
    }
}
