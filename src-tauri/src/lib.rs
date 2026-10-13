//! Composition roots wire native adapters into inward application ports.
pub mod application;
pub mod contracts;
pub mod domain;
pub mod infrastructure;
pub mod presentation;
use application::document::{ActorError, DocumentActor};
use application::isolation::IsolationManager;
use application::ports::DocumentServices;
use application::workspace::Workspace;
use contracts::{DocumentId, WorkspaceError};
use std::path::{Path, PathBuf};
use std::sync::Arc;
/// Construct the production buffer and filesystem dependencies once per composition request.
pub fn document_services() -> DocumentServices {
    DocumentServices {
        storage: Arc::new(infrastructure::storage::NativeStorage),
        buffers: Arc::new(infrastructure::neovim::buffer::NativeBufferFactory),
    }
}
/// Construct the native vim-settings file adapter for guarded config access.
pub fn vim_settings_files() -> Arc<dyn application::vim_settings::VimSettingsFiles> {
    Arc::new(infrastructure::vim_settings::NativeVimSettingsFiles)
}
/// Open a real authoritative document with isolated configuration and native storage.
pub fn open_document(
    id: DocumentId,
    text: String,
    path: Option<PathBuf>,
) -> Result<DocumentActor, ActorError> {
    DocumentActor::open(id, text, path, document_services())
}
/// Open a real document with the caller's explicitly selected configuration.
pub fn open_document_with_config(
    id: DocumentId,
    text: String,
    path: Option<PathBuf>,
    config: application::ports::ConfigSource,
) -> Result<DocumentActor, ActorError> {
    DocumentActor::open_with_config(id, text, path, config, document_services())
}
/// Open a native folder registry whose actors share injected buffer and storage adapters.
pub fn open_workspace(root: &Path, recovery: &Path) -> Result<Workspace, WorkspaceError> {
    Workspace::open(
        root,
        recovery,
        document_services(),
        Arc::new(infrastructure::storage::NativeStorage),
        Arc::new(infrastructure::storage::SystemClock),
    )
}
/// Open a native exact-scope staging manager with process-local copy identifiers.
pub fn open_isolation(root: &Path) -> Result<IsolationManager, WorkspaceError> {
    IsolationManager::open(
        root,
        Arc::new(infrastructure::storage::NativeStorage),
        Arc::new(infrastructure::storage::SystemClock),
    )
}
#[cfg(feature = "desktop")]
/// Compose native adapters, desktop state, events and Tauri command handlers before starting the app.
pub fn run() {
    use tauri::{Emitter, Manager};
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(presentation::document::ActorState::new(
            document_services(),
            std::sync::Arc::new(infrastructure::storage::NativeStorage),
            std::sync::Arc::new(infrastructure::storage::SystemClock),
        ))
        .manage(presentation::clipboard::ClipboardState(
            std::sync::Arc::new(infrastructure::clipboard::NativeClipboard::default()),
        ))
        .manage(presentation::isolation::IsolationState::new(
            open_isolation(&std::env::temp_dir().join("marxen-staging")).expect("staging dir"),
        ))
        .manage(presentation::vim_settings::VimSettingsState::new(
            vim_settings_files(),
        ))
        .manage(application::ai::service::AiService {
            keyring: Arc::new(infrastructure::ai::credentials::OsKeyring),
            transport: Arc::new(infrastructure::ai::transport::NativeAiTransport),
            spawner: Arc::new(infrastructure::ai::transport::NativeTaskSpawner),
            runs: Arc::new(application::ai::runs::RunRegistry::new()),
            usage: Arc::new(application::ai::usage::UsageRegistry::new()),
        })
        .manage(application::ai::account_usage::AccountUsageService {
            reader: Arc::new(infrastructure::ai::account_usage::NativeAccountUsageReader),
            clock: Arc::new(infrastructure::storage::SystemClock),
        })
        .setup(|app| {
            infrastructure::neovim::configure_resource_dir(app.path().resource_dir()?);
            let state = app.state::<presentation::document::ActorState>();
            let workspace = std::sync::Arc::downgrade(&state.workspace);
            let pending = std::sync::Arc::downgrade(&state.pending);
            let handle = app.handle().clone();
            std::thread::Builder::new()
                .name("marxen-workspace-poll".into())
                .spawn(move || loop {
                    std::thread::sleep(std::time::Duration::from_millis(500));
                    let (Some(workspace), Some(pending)) = (workspace.upgrade(), pending.upgrade())
                    else {
                        break;
                    };
                    let Ok(mut guard) = workspace.lock() else {
                        break;
                    };
                    let Some(workspace) = guard.as_mut() else {
                        continue;
                    };
                    let events = workspace.poll();
                    if !events.is_empty() {
                        let _ = handle.emit("marxen:workspace", &events);
                        if let Ok(mut queue) = pending.lock() {
                            queue.extend(events);
                            if queue.len() > 1024 {
                                let excess = queue.len() - 1024;
                                queue.drain(..excess);
                            }
                        }
                    }
                })?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            presentation::runtime::get_runtime_status,
            presentation::clipboard::write_clipboard,
            presentation::document::open_document,
            presentation::document::fetch_snapshot,
            presentation::document::apply_gui_edits,
            presentation::document::save_document,
            presentation::document::fetch_mode,
            presentation::document::nvim_input_with_copy,
            presentation::document::has_nvim_mapping,
            presentation::document::undo_document,
            presentation::document::report_cursor,
            presentation::document::open_workspace,
            presentation::document::list_workspace,
            presentation::document::list_documents,
            presentation::document::open_markdown,
            presentation::document::open_text_file,
            presentation::document::load_workspace_image,
            presentation::document::insert_workspace_image,
            presentation::document::import_external_image,
            presentation::document::create_markdown,
            presentation::document::create_folder,
            presentation::document::rename_markdown,
            presentation::document::reload_document,
            presentation::document::close_document,
            presentation::document::search_workspace,
            presentation::document::poll_workspace_events,
            presentation::document::list_recovery,
            presentation::document::restore_recovery,
            presentation::document::discard_recovery,
            presentation::document::load_relative_image,
            presentation::document::paste_image,
            presentation::document::redo_document,
            presentation::document::nvim_input,
            presentation::document::fetch_cursor,
            presentation::document::fetch_grid,
            presentation::document::fetch_config,
            presentation::ai::ai_credential_state,
            presentation::ai::ai_set_credential,
            presentation::ai::ai_delete_credential,
            presentation::ai::ai_test_connection,
            presentation::ai::ai_prompt_stream,
            presentation::ai::ai_prompt_cancel,
            presentation::ai::ai_usage_snapshot,
            presentation::ai::ai_codex_account_usage,
            presentation::isolation::isolation_create,
            presentation::isolation::isolation_diff,
            presentation::isolation::isolation_new_files,
            presentation::isolation::isolation_stage_proposal,
            presentation::isolation::isolation_approve,
            presentation::isolation::isolation_reject,
            presentation::isolation::isolation_cancel,
            presentation::document::configure_document,
            presentation::vim_settings::vim_settings_read,
            presentation::vim_settings::vim_settings_write_managed,
            presentation::vim_settings::vim_settings_write_raw
        ])
        .run(tauri::generate_context!())
        .expect("Marxen desktop runtime failed");
}
