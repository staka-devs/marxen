pub mod ai;
pub mod ai_contracts;
pub mod contracts;
pub mod document;
pub mod ipc;
pub mod neovim;
pub mod storage;
pub mod validation;
pub mod workspace;

pub fn runtime_status() -> contracts::RuntimeStatus {
    contracts::RuntimeStatus {
        contract_version: 1,
        connection: contracts::ConnectionState::Disconnected,
        detail: "ワークスペースの Markdown ファイルを開くと Neovim に接続します。".into(),
    }
}

#[cfg(feature = "desktop")]
#[tauri::command]
fn get_runtime_status(state: tauri::State<ipc::ActorState>) -> contracts::RuntimeStatus {
    let has_document = state.workspace.lock().ok().is_some_and(|guard| {
        guard
            .as_ref()
            .is_some_and(|workspace| workspace.has_live_documents())
    });
    // A retained document is not evidence that its process is still running.
    if has_document {
        contracts::RuntimeStatus {
            contract_version: 1,
            connection: contracts::ConnectionState::Connected,
            detail: "実 Neovim embed セッションが文書を所有しています。".into(),
        }
    } else {
        runtime_status()
    }
}

#[cfg(feature = "desktop")]
pub fn run() {
    use tauri::{Emitter, Manager};
    tauri::Builder::default()
        .manage(ipc::ActorState::default())
        .setup(|app| {
            neovim::configure_resource_dir(app.path().resource_dir()?);
            let state = app.state::<ipc::ActorState>();
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
            get_runtime_status,
            ipc::open_document,
            ipc::fetch_snapshot,
            ipc::apply_gui_edits,
            ipc::save_document,
            ipc::fetch_mode,
            ipc::has_nvim_mapping,
            ipc::undo_document,
            ipc::report_cursor,
            ipc::open_workspace,
            ipc::list_workspace,
            ipc::list_documents,
            ipc::open_markdown,
            ipc::create_markdown,
            ipc::rename_markdown,
            ipc::reload_document,
            ipc::close_document,
            ipc::search_workspace,
            ipc::poll_workspace_events,
            ipc::list_recovery,
            ipc::restore_recovery,
            ipc::discard_recovery,
            ipc::load_relative_image,
            ipc::paste_image,
            ipc::redo_document,
            ipc::nvim_input,
            ipc::fetch_cursor,
            ipc::fetch_grid,
            ipc::fetch_config,
            ai::ai_credential_state,
            ai::ai_set_credential,
            ai::ai_delete_credential,
            ai::ai_test_connection,
            ai::ai_prompt_stream,
            ai::ai_prompt_cancel,
            ipc::configure_document
        ])
        .run(tauri::generate_context!())
        .expect("Marxen desktop runtime failed");
}
