//! Authoritative document actor: Neovim buffer is truth, Rust serializes access.
//!
//! All GUI / AI range edits enter through [`DocumentActor::apply_edits`]
//! with an exact `base_revision`. The actor validates against the current
//! snapshot ([`crate::domain::validation`]), converts global UTF-16 ranges to Neovim
//! `(row, UTF-8 byte col)` ([`crate::domain::coordinates`]), applies them tail
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

use crate::application::ports::*;
use crate::contracts::{
    ContractError, CopyFormat, CursorUpdate, DocumentEvent, DocumentId, DocumentSnapshot,
    EditRequest, GridUpdate, ModeUpdate, NvimConfig, Revision, SaveRequest, SaveResult,
    Utf16Offset, VimInputResult, VimMode, WorkspaceError, YankCopy,
};
use crate::domain::coordinates::global_utf16_to_line_byte;

use crate::domain::storage::{self, Fingerprint, RecoveryRecord};
use crate::domain::validation::{
    next_revision, validate_cursor, validate_document_id, validate_edit, validate_save,
};
use std::path::PathBuf;
use std::sync::Mutex;

#[derive(Debug)]
pub enum ActorError {
    Contract(ContractError),
    Nvim(String),
    Workspace(WorkspaceError),
}

impl std::fmt::Display for ActorError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Contract(error) => write!(f, "contract: {error:?}"),
            Self::Nvim(detail) => write!(f, "neovim: {detail}"),
            Self::Workspace(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for ActorError {}

impl From<ContractError> for ActorError {
    fn from(error: ContractError) -> Self {
        Self::Contract(error)
    }
}

impl From<BufferError> for ActorError {
    fn from(error: BufferError) -> Self {
        Self::Nvim(error.to_string())
    }
}
impl From<WorkspaceError> for ActorError {
    fn from(error: WorkspaceError) -> Self {
        Self::Workspace(error)
    }
}
impl From<ActorError> for WorkspaceError {
    fn from(error: ActorError) -> Self {
        match error {
            ActorError::Contract(error) => Self::Contract { error },
            ActorError::Nvim(detail) => Self::Neovim { detail },
            ActorError::Workspace(error) => error,
        }
    }
}

struct ActorState {
    snapshot: DocumentSnapshot,
    nvim: Box<dyn Buffer>,
    services: DocumentServices,
    path: Option<PathBuf>,
    root: Option<PathBuf>,
    baseline: Option<Fingerprint>,
    recovery: Option<PathBuf>,
    grid: Vec<serde_json::Value>,
    saved: Vec<SaveResult>,
    save_requested: bool,
    last_cursor: (Utf16Offset, Utf16Offset),
    gui_virtualedit: Option<String>,
    /// One following command may choose a format for the last native yank.
    ready_yank: Option<(Revision, String)>,
}

/// Serialized owner of one document's Neovim buffer, snapshot, and file path.
pub struct DocumentActor {
    state: Mutex<ActorState>,
}

impl DocumentActor {
    pub fn is_alive(&self) -> Result<bool, ActorError> {
        let state = self
            .state
            .lock()
            .map_err(|_| ActorError::Nvim("document lock poisoned".into()))?;
        Ok(state.nvim.is_alive()?)
    }

    /// Open a new authoritative buffer with `initial_text` at revision 0.
    pub fn open(
        document_id: DocumentId,
        initial_text: String,
        path: Option<PathBuf>,
        services: DocumentServices,
    ) -> Result<Self, ActorError> {
        Self::open_with_config(
            document_id,
            initial_text,
            path,
            ConfigSource::Isolated,
            services,
        )
    }

    pub fn open_with_config(
        document_id: DocumentId,
        initial_text: String,
        path: Option<PathBuf>,
        config: ConfigSource,
        services: DocumentServices,
    ) -> Result<Self, ActorError> {
        validate_document_id(&document_id)?;
        let baseline = path
            .as_deref()
            .map(|path| services.storage.disk_fingerprint(path))
            .transpose()?
            .flatten();
        let nvim = services
            .buffers
            .open(config, &initial_text, path.as_deref(), true)?;
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
                services,
                path,
                root: None,
                baseline,
                recovery: None,
                grid: Vec::new(),
                saved: Vec::new(),
                save_requested: false,
                last_cursor: (Utf16Offset(0), Utf16Offset(0)),
                gui_virtualedit: None,
                ready_yank: None,
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

    /// Validate a planned edit against a live, ready authoritative buffer.
    /// This does not change text or Undo history. Multi-document approvals
    /// preflight every actor before the first mutation; apply still rechecks.
    pub fn preflight_edits(&self, request: &EditRequest) -> Result<DocumentSnapshot, ActorError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| ActorError::Nvim("document lock poisoned".into()))?;
        Self::require_ready(&state)?;
        Self::sync_locked(&mut state)?;
        if request.edits.is_empty() {
            validate_save(
                &state.snapshot,
                &SaveRequest {
                    document_id: request.document_id.clone(),
                    base_revision: request.base_revision,
                },
            )?;
        } else {
            validate_edit(&state.snapshot, request)?;
        }
        Ok(state.snapshot.clone())
    }

    /// Apply GUI/AI range edits validated against `base_revision`.
    pub fn apply_edits(&self, request: EditRequest) -> Result<DocumentSnapshot, ActorError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| ActorError::Nvim("document lock poisoned".into()))?;
        Self::require_ready(&state)?;
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
        state.nvim.apply_ranges(&positioned)?;
        let text = state.nvim.get_text()?;
        let revision = next_revision(state.snapshot.revision)?;
        let dirty = state.baseline.as_ref() != Some(&storage::fingerprint(text.as_bytes()));
        state.snapshot = DocumentSnapshot {
            document_id: state.snapshot.document_id.clone(),
            revision,
            text,
            dirty,
        };
        Self::checkpoint_locked(&state)?;
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
        Self::service_notifications(&mut state)?;
        Ok(state.snapshot.clone())
    }

    /// Feed keys through real Neovim (mappings/macros fire), then sync.
    /// Test and Vim-path entry point; GUI edits must use [`apply_edits`].
    pub fn input_via_nvim(&self, keys: &str) -> Result<DocumentSnapshot, ActorError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| ActorError::Nvim("document lock poisoned".into()))?;
        state.ready_yank = None;
        state.nvim.input(keys)?;
        Self::sync_locked(&mut state)?;
        Self::service_notifications(&mut state)?;
        Ok(state.snapshot.clone())
    }

    pub fn input_checked(
        &self,
        request: SaveRequest,
        keys: &str,
    ) -> Result<DocumentSnapshot, ActorError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| ActorError::Nvim("document lock poisoned".into()))?;
        Self::sync_locked(&mut state)?;
        validate_save(&state.snapshot, &request)?;
        state.ready_yank = None;
        state.nvim.input(keys)?;
        Self::sync_locked(&mut state)?;
        Self::service_notifications(&mut state)?;
        Ok(state.snapshot.clone())
    }

    /// Native input and post-yank selectors share the actor lock. A selector
    /// is considered only as the very next key after a real TextYankPost,
    /// after a ready/mapping check. Every other key follows Neovim normally.
    pub fn input_with_copy(
        &self,
        request: SaveRequest,
        keys: &str,
    ) -> Result<VimInputResult, ActorError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| ActorError::Nvim("document lock poisoned".into()))?;
        Self::sync_locked(&mut state)?;
        Self::service_notifications(&mut state)?;
        validate_save(&state.snapshot, &request)?;
        if let Some((revision, text)) = state.ready_yank.take() {
            if revision == state.snapshot.revision
                && state.nvim.mode()? == VimMode::Normal
                && !state.nvim.input_pending()?
                && !state.nvim.has_mapping("n", keys)?
            {
                for (name, selector) in state.nvim.copy_keys()? {
                    if state.nvim.same_key(keys, &selector)? {
                        let format = match name.as_str() {
                            "markdown" => CopyFormat::Markdown,
                            "text" => CopyFormat::Text,
                            "rich" => CopyFormat::Rich,
                            "html" => CopyFormat::Html,
                            _ => continue,
                        };
                        return Ok(VimInputResult {
                            snapshot: state.snapshot.clone(),
                            copy: Some(YankCopy { format, text }),
                            copy_ready: false,
                        });
                    }
                }
            }
        }
        state.nvim.input(keys)?;
        Self::sync_locked(&mut state)?;
        Self::service_notifications(&mut state)?;
        Ok(VimInputResult {
            snapshot: state.snapshot.clone(),
            copy: None,
            copy_ready: state.ready_yank.is_some(),
        })
    }

    /// Native `undo` (shared history with GUI edits), then sync.
    pub fn undo(&self) -> Result<DocumentSnapshot, ActorError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| ActorError::Nvim("document lock poisoned".into()))?;
        Self::require_ready(&state)?;
        state.ready_yank = None;
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
        Self::require_ready(&state)?;
        state.ready_yank = None;
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
        Self::require_ready(&state)?;
        Self::sync_locked(&mut state)?;
        validate_save(&state.snapshot, &request)?;
        Self::save_locked(&mut state)
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

    pub fn copy_keys(&self) -> Result<std::collections::BTreeMap<String, String>, ActorError> {
        let state = self
            .state
            .lock()
            .map_err(|_| ActorError::Nvim("document lock poisoned".into()))?;
        Self::require_ready(&state)?;
        Ok(state.nvim.copy_keys()?)
    }

    pub fn copy_key_errors(&self) -> Result<Vec<String>, ActorError> {
        let state = self
            .state
            .lock()
            .map_err(|_| ActorError::Nvim("document lock poisoned".into()))?;
        Self::require_ready(&state)?;
        Ok(state.nvim.copy_config()?.1)
    }

    /// Display navigation must yield to user mappings and pending Vim input.
    pub fn has_user_mapping(&self, mode: &str, lhs: &str) -> Result<bool, ActorError> {
        if !matches!(mode, "n" | "i" | "v" | "x" | "s" | "o" | "c" | "t")
            || lhs.is_empty()
            || lhs.len() > 512
            || lhs.contains('\0')
        {
            return Err(ActorError::Nvim("invalid mapping query".into()));
        }
        let state = self
            .state
            .lock()
            .map_err(|_| ActorError::Nvim("document lock poisoned".into()))?;
        if state.nvim.input_pending()? {
            return Ok(true);
        }
        Ok(state.nvim.has_mapping(mode, lhs)?)
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
        Self::require_ready(&state)?;
        state.nvim.install_save_intercept()?;

        Ok(())
    }

    /// Test/maintenance escape hatch: run one Neovim command on the owned buffer.
    #[cfg(feature = "dev-tools")]
    pub fn nvim_command(&self, cmd: &str) -> Result<(), ActorError> {
        let state = self
            .state
            .lock()
            .map_err(|_| ActorError::Nvim("document lock poisoned".into()))?;
        Self::require_ready(&state)?;
        state.nvim.command_for_fixture(cmd)?;
        Ok(())
    }

    /// Buffer text re-read without minting a revision when unchanged.
    pub fn buffer_text(&self) -> Result<String, ActorError> {
        let state = self
            .state
            .lock()
            .map_err(|_| ActorError::Nvim("document lock poisoned".into()))?;
        Self::require_ready(&state)?;
        Ok(state.nvim.get_text()?)
    }

    /// Drain pending `marxen:save-requested` methods (all params dropped).
    pub fn drain_save_requests(&self) -> Vec<String> {
        self.state
            .lock()
            .map(|state| state.nvim.drain_save_requests())
            .unwrap_or_default()
    }

    /// Snapshot event for IPC emission.
    pub fn snapshot_event(&self) -> DocumentEvent {
        DocumentEvent::Snapshot(self.snapshot())
    }

    /// Workspace attaches a contained path and durable checkpoint location.
    pub fn attach_storage(&self, root: PathBuf, recovery: PathBuf) -> Result<(), ActorError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| ActorError::Nvim("document lock poisoned".into()))?;
        if let Some(path) = &state.path {
            state.services.storage.check_target(Some(&root), path)?;
        }
        state.root = Some(root);
        state.recovery = Some(recovery);
        Self::checkpoint_locked(&state)
    }

    pub fn baseline(&self) -> Option<Fingerprint> {
        self.state
            .lock()
            .expect("document lock poisoned")
            .baseline
            .clone()
    }

    pub fn mark_unsaved(&self) -> Result<(), ActorError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| ActorError::Nvim("document lock poisoned".into()))?;
        state.snapshot.dirty = true;
        Self::checkpoint_locked(&state)
    }

    pub fn path(&self) -> Option<PathBuf> {
        self.state
            .lock()
            .expect("document lock poisoned")
            .path
            .clone()
    }

    pub fn restore_record(&self, record: &RecoveryRecord) -> Result<(), ActorError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| ActorError::Nvim("document lock poisoned".into()))?;
        state.snapshot = record.snapshot.clone();
        state.snapshot.dirty = true;
        state.baseline = record.baseline.clone();
        Self::checkpoint_locked(&state)
    }

    pub fn discard_recovery(&self) -> Result<(), ActorError> {
        let state = self
            .state
            .lock()
            .map_err(|_| ActorError::Nvim("document lock poisoned".into()))?;
        if let Some(path) = &state.recovery {
            state.services.storage.remove_checkpoint(path)?;
        }
        Ok(())
    }

    /// Explicit reload refuses dirty content; accepted disk text is a new revision.
    pub fn reload(&self, request: SaveRequest) -> Result<DocumentSnapshot, ActorError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| ActorError::Nvim("document lock poisoned".into()))?;
        Self::require_ready(&state)?;
        Self::sync_locked(&mut state)?;
        validate_save(&state.snapshot, &request)?;
        if state.snapshot.dirty {
            return Err(WorkspaceError::UnsavedChanges {
                snapshot: state.snapshot.clone(),
            }
            .into());
        }
        let path = state.path.as_ref().ok_or(WorkspaceError::InvalidPath)?;
        state
            .services
            .storage
            .check_target(state.root.as_deref(), path)?;
        let bytes = state
            .services
            .storage
            .read_disk(path)?
            .ok_or(WorkspaceError::NotFound)?;
        let text = String::from_utf8(bytes.clone()).map_err(|_| WorkspaceError::InvalidUtf8)?;
        let revision = next_revision(state.snapshot.revision)?;
        state.nvim.set_text(&text)?;
        state.nvim.clear_modified()?;
        state.snapshot.text = text;
        state.snapshot.revision = revision;
        state.baseline = Some(storage::fingerprint(&bytes));
        Ok(state.snapshot.clone())
    }

    /// No-overwrite rename preserves the authoritative buffer and Undo tree.
    pub fn rename(&self, request: SaveRequest, target: PathBuf) -> Result<(), ActorError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| ActorError::Nvim("document lock poisoned".into()))?;
        Self::require_ready(&state)?;
        Self::sync_locked(&mut state)?;
        validate_save(&state.snapshot, &request)?;
        let source = state.path.clone().ok_or(WorkspaceError::InvalidPath)?;
        if source == target {
            return Ok(());
        }
        state
            .services
            .storage
            .check_target(state.root.as_deref(), &source)?;
        state
            .services
            .storage
            .check_target(state.root.as_deref(), &target)?;
        if state.services.storage.disk_fingerprint(&source)? != state.baseline {
            return Err(WorkspaceError::Conflict {
                path: source.display().to_string(),
            }
            .into());
        }
        // Hard-link creation is atomic and refuses an existing destination.
        state.services.storage.hard_link(&source, &target)?;
        if let Err(error) = state.nvim.set_buf_name(&target.to_string_lossy()) {
            let _ = state.services.storage.remove_file(&target);
            return Err(error.into());
        }
        if let Err(error) = state.services.storage.remove_file(&source) {
            let _ = state.nvim.set_buf_name(&source.to_string_lossy());
            let _ = state.services.storage.remove_file(&target);
            return Err(WorkspaceError::from(error).into());
        }
        state.path = Some(target);
        Self::checkpoint_locked(&state)?;
        Ok(())
    }

    pub fn cursor(&self) -> Result<CursorUpdate, ActorError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| ActorError::Nvim("document lock poisoned".into()))?;
        Self::sync_locked(&mut state)?;
        let (mode, blocking) = state.nvim.mode_state()?;
        if blocking {
            return Ok(Self::cached_cursor(&state));
        }
        if matches!(mode, VimMode::Visual | VimMode::VisualLine) {
            let (start_row, start_col, end_row, end_col, newline, forward) =
                state.nvim.visual_selection()?;
            let start = crate::domain::coordinates::line_byte_to_global_utf16(
                &state.snapshot.text,
                start_row,
                start_col,
            )?;
            let mut end = crate::domain::coordinates::line_byte_to_global_utf16(
                &state.snapshot.text,
                end_row,
                end_col,
            )?;
            if newline {
                end.0 += 1;
            }
            state.last_cursor = if forward { (start, end) } else { (end, start) };
            return Ok(Self::cached_cursor(&state));
        }
        let (row, col) = state.nvim.win_cursor()?;
        let offset = crate::domain::coordinates::line_byte_to_global_utf16(
            &state.snapshot.text,
            (row - 1) as u32,
            col as u32,
        )?;
        state.last_cursor = (offset, offset);
        Ok(Self::cached_cursor(&state))
    }

    pub fn set_cursor(&self, update: CursorUpdate) -> Result<CursorUpdate, ActorError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| ActorError::Nvim("document lock poisoned".into()))?;
        Self::require_ready(&state)?;
        Self::sync_locked(&mut state)?;
        validate_cursor(&state.snapshot, &update)?;
        if (update.anchor, update.head) != state.last_cursor {
            state.ready_yank = None;
        }
        let (mode, _) = state.nvim.mode_state()?;
        if mode == VimMode::VisualBlock && update.anchor != update.head {
            return Err(ActorError::Nvim(
                "矩形選択は Neovim 画面で操作してください".into(),
            ));
        }
        let visual = matches!(mode, VimMode::Visual | VimMode::VisualLine);
        let install_selection = update.anchor != update.head
            && matches!(
                mode,
                VimMode::Normal | VimMode::Visual | VimMode::VisualLine
            );
        if install_selection {
            // GUI ranges are half-open. Native exclusive regions end after
            // the selected text; inclusive regions end on its last character.
            let previous = |offset: Utf16Offset| -> Result<Utf16Offset, ContractError> {
                let byte = crate::domain::validation::utf16_to_utf8(&state.snapshot.text, offset)?.0
                    as usize;
                let width = state.snapshot.text[..byte]
                    .chars()
                    .next_back()
                    .map(char::len_utf16)
                    .unwrap_or(0);
                Ok(Utf16Offset(offset.0 - width as u32))
            };
            let forward = update.anchor.0 < update.head.0;
            let exclusive = state.nvim.selection_exclusive()?;
            let anchor = if forward || (exclusive && mode != VimMode::VisualLine) {
                update.anchor
            } else {
                previous(update.anchor)?
            };
            let head = if forward && (mode == VimMode::VisualLine || !exclusive) {
                previous(update.head)?
            } else {
                update.head
            };
            let (anchor_row, anchor_col) = global_utf16_to_line_byte(&state.snapshot.text, anchor)?;
            let (head_row, head_col) = global_utf16_to_line_byte(&state.snapshot.text, head)?;
            if state.gui_virtualedit.is_none() {
                state.gui_virtualedit = Some(state.nvim.virtualedit()?);
            }
            state.nvim.install_selection(
                (anchor_row, anchor_col),
                (head_row, head_col),
                mode == VimMode::VisualLine,
            )?;
            state.last_cursor = (update.anchor, update.head);
            return Ok(update);
        }
        if visual {
            state.nvim.exit_visual()?;
            Self::restore_gui_virtualedit(&mut state)?;
        }
        let (row, col) = global_utf16_to_line_byte(&state.snapshot.text, update.head)?;
        state.nvim.set_cursor(row, col)?;
        state.last_cursor = (update.anchor, update.head);
        Ok(update)
    }

    /// Drain raw Neovim redraw deltas without losing pending Rust save requests.
    pub fn grid(&self, width: u32, height: u32) -> Result<GridUpdate, ActorError> {
        if !(1..=500).contains(&width) || !(1..=300).contains(&height) {
            return Err(WorkspaceError::InvalidPath.into());
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| ActorError::Nvim("document lock poisoned".into()))?;
        if !state.nvim.mode_state()?.1 {
            state.nvim.resize_grid(width, height)?;
        }
        Self::sync_locked(&mut state)?;
        Self::service_notifications(&mut state)?;
        Ok(GridUpdate {
            document_id: state.snapshot.document_id.clone(),
            revision: state.snapshot.revision,
            updates: std::mem::take(&mut state.grid),
        })
    }

    pub fn configure(
        &self,
        request: SaveRequest,
        path: Option<PathBuf>,
    ) -> Result<NvimConfig, ActorError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| ActorError::Nvim("document lock poisoned".into()))?;
        Self::require_ready(&state)?;
        Self::sync_locked(&mut state)?;
        validate_save(&state.snapshot, &request)?;
        let config = path
            .clone()
            .map(ConfigSource::UserFile)
            .unwrap_or(ConfigSource::Isolated);
        let nvim = state.services.buffers.open(
            config,
            &state.snapshot.text,
            state.path.as_deref(),
            false,
        )?;
        let (copy_keys, copy_errors) = nvim.copy_config()?;
        let result = NvimConfig {
            path: path.map(|p| p.display().to_string()),
            errors: nvim
                .config_report()
                .errors
                .iter()
                .cloned()
                .chain(copy_errors)
                .collect(),
            copy_keys,
        };
        state.nvim = nvim;
        state.ready_yank = None;
        state.gui_virtualedit = None;
        state.grid.clear();
        Ok(result)
    }

    pub fn take_saved(&self) -> Vec<SaveResult> {
        self.state
            .lock()
            .map(|mut s| std::mem::take(&mut s.saved))
            .unwrap_or_default()
    }

    fn service_notifications(state: &mut ActorState) -> Result<(), ActorError> {
        for note in state.nvim.drain_notifications() {
            match note {
                BufferNotification::Yank(text) => {
                    state.ready_yank = Some((state.snapshot.revision, text))
                }
                BufferNotification::SaveRequested => state.save_requested = true,
                BufferNotification::Redraw(value) => state.grid.push(value),
            }
        }
        // Keep only a bounded backlog; grid() requests a full redraw.
        if state.grid.len() > 256 {
            state.grid.drain(..state.grid.len() - 256);
        }
        if state.save_requested && !state.nvim.mode_state()?.1 {
            let result = Self::save_locked(state)?;
            state.save_requested = false;
            state.saved.push(result);
        }
        Ok(())
    }

    fn save_locked(state: &mut ActorState) -> Result<SaveResult, ActorError> {
        let path = state.path.as_ref().ok_or(WorkspaceError::InvalidPath)?;
        let baseline = state.services.storage.atomic_write(
            path,
            state.snapshot.text.as_bytes(),
            state.baseline.as_ref(),
            state.root.as_deref(),
        )?;
        state.baseline = Some(baseline);
        // A failed Neovim acknowledgement leaves recovery and dirty status intact.
        state.nvim.clear_modified()?;
        if let Some(path) = &state.recovery {
            state.services.storage.remove_checkpoint(path)?;
        }
        state.snapshot.dirty = false;
        Ok(SaveResult {
            document_id: state.snapshot.document_id.clone(),
            revision: state.snapshot.revision,
            dirty: false,
        })
    }

    fn checkpoint_locked(state: &ActorState) -> Result<(), ActorError> {
        if !state.snapshot.dirty {
            if let Some(path) = &state.recovery {
                state.services.storage.remove_checkpoint(path)?;
            }
            return Ok(());
        }
        if let (Some(root), Some(recovery)) = (&state.root, &state.recovery) {
            state.services.storage.checkpoint(
                recovery,
                &RecoveryRecord {
                    version: 1,
                    root: root.clone(),
                    path: state
                        .path
                        .as_ref()
                        .map(|p| storage::relative(root, p))
                        .transpose()?,
                    baseline: state.baseline.clone(),
                    snapshot: state.snapshot.clone(),
                },
            )?;
        }
        Ok(())
    }

    fn sync_locked(state: &mut ActorState) -> Result<bool, ActorError> {
        // Deferred API reads cannot answer while Vim waits for the next key.
        // Keep the acknowledged snapshot and leave input available to finish it.
        let (mode, blocking) = state.nvim.mode_state()?;
        if blocking {
            return Ok(false);
        }
        if !matches!(mode, VimMode::Visual | VimMode::VisualLine) {
            Self::restore_gui_virtualedit(state)?;
        }
        let text = state.nvim.get_text()?;
        if text == state.snapshot.text {
            Self::checkpoint_locked(state)?;
            return Ok(false);
        }
        let revision = next_revision(state.snapshot.revision)?;
        state.ready_yank = None;
        let dirty = state.baseline.as_ref() != Some(&storage::fingerprint(text.as_bytes()));
        state.snapshot = DocumentSnapshot {
            document_id: state.snapshot.document_id.clone(),
            revision,
            text,
            dirty,
        };
        Self::checkpoint_locked(state)?;
        Ok(true)
    }

    fn restore_gui_virtualedit(state: &mut ActorState) -> Result<(), ActorError> {
        if let Some(original) = state.gui_virtualedit.as_ref() {
            state.nvim.restore_virtualedit(original)?;
            state.gui_virtualedit = None;
        }
        Ok(())
    }

    fn cached_cursor(state: &ActorState) -> CursorUpdate {
        let clamp = |offset: Utf16Offset| {
            let mut offset = Utf16Offset(
                offset
                    .0
                    .min(crate::domain::coordinates::utf16_len(&state.snapshot.text)),
            );
            if crate::domain::validation::utf16_to_utf8(&state.snapshot.text, offset).is_err() {
                offset.0 = offset.0.saturating_sub(1);
            }
            offset
        };
        CursorUpdate {
            document_id: state.snapshot.document_id.clone(),
            revision: state.snapshot.revision,
            anchor: clamp(state.last_cursor.0),
            head: clamp(state.last_cursor.1),
        }
    }

    fn require_ready(state: &ActorState) -> Result<(), ActorError> {
        if state.nvim.input_pending()? {
            return Err(ActorError::Nvim(
                "次のキーを待っています。Vim 操作を完了するか Esc で取り消してください。".into(),
            ));
        }
        Ok(())
    }
}
