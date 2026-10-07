//! Tauri IPC bindings over the authoritative [`crate::document::DocumentActor`].
//!
//! Issue #3 scope is the Rust actor plus bindings; the read-only shell keeps
//! calling `get_runtime_status` until Issue #5 wires GUI range edits. Errors
//! surface as strings: contract rejections keep their `ContractError` debug
//! shape (`StaleRevision { expected, received }`, ...) so callers can resync
//! from the latest snapshot.

use crate::document::DocumentActor;
use std::sync::Mutex;

#[cfg(feature = "desktop")]
use crate::contracts::{
    ContractError, DocumentId, DocumentSnapshot, EditRequest, EditSource, ModeUpdate, Revision,
    SaveRequest, SaveResult, TextEdit,
};

pub struct ActorState {
    pub actor: Mutex<Option<DocumentActor>>,
}

impl Default for ActorState {
    fn default() -> Self {
        Self {
            actor: Mutex::new(None),
        }
    }
}

#[cfg(feature = "desktop")]
fn actor_error(error: crate::document::ActorError) -> String {
    error.to_string()
}

#[cfg(feature = "desktop")]
fn contract_error(error: ContractError) -> String {
    format!("contract: {error:?}")
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn open_document(
    state: tauri::State<'_, ActorState>,
    document_id: String,
    text: String,
    path: Option<String>,
) -> Result<DocumentSnapshot, String> {
    let actor = DocumentActor::open(
        DocumentId(document_id),
        text,
        path.map(std::path::PathBuf::from),
    )
    .map_err(actor_error)?;
    let snapshot = actor.snapshot();
    state
        .actor
        .lock()
        .map_err(|_| "document lock poisoned".to_owned())?
        .replace(actor);
    Ok(snapshot)
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn fetch_snapshot(state: tauri::State<'_, ActorState>) -> Result<DocumentSnapshot, String> {
    state
        .actor
        .lock()
        .map_err(|_| "document lock poisoned".to_owned())?
        .as_ref()
        .map(DocumentActor::snapshot)
        .ok_or_else(|| "no open document".to_owned())
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn apply_gui_edits(
    state: tauri::State<'_, ActorState>,
    document_id: String,
    base_revision: u32,
    edits: Vec<TextEdit>,
) -> Result<DocumentSnapshot, String> {
    let guard = state
        .actor
        .lock()
        .map_err(|_| "document lock poisoned".to_owned())?;
    let actor = guard
        .as_ref()
        .ok_or_else(|| "no open document".to_owned())?;
    actor
        .apply_edits(EditRequest {
            document_id: DocumentId(document_id),
            base_revision: Revision(base_revision),
            source: EditSource::Gui,
            edits,
        })
        .map_err(|cause| match cause {
            crate::document::ActorError::Contract(contract) => contract_error(contract),
            other => actor_error(other),
        })
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn save_document(
    state: tauri::State<'_, ActorState>,
    document_id: String,
    base_revision: u32,
) -> Result<SaveResult, String> {
    let guard = state
        .actor
        .lock()
        .map_err(|_| "document lock poisoned".to_owned())?;
    let actor = guard
        .as_ref()
        .ok_or_else(|| "no open document".to_owned())?;
    actor
        .save(SaveRequest {
            document_id: DocumentId(document_id),
            base_revision: Revision(base_revision),
        })
        .map_err(actor_error)
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn fetch_mode(state: tauri::State<'_, ActorState>) -> Result<ModeUpdate, String> {
    let guard = state
        .actor
        .lock()
        .map_err(|_| "document lock poisoned".to_owned())?;
    let actor = guard
        .as_ref()
        .ok_or_else(|| "no open document".to_owned())?;
    actor.current_mode().map_err(actor_error)
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn undo_document(state: tauri::State<'_, ActorState>) -> Result<DocumentSnapshot, String> {
    let guard = state
        .actor
        .lock()
        .map_err(|_| "document lock poisoned".to_owned())?;
    let actor = guard
        .as_ref()
        .ok_or_else(|| "no open document".to_owned())?;
    actor.undo().map_err(actor_error)
}
