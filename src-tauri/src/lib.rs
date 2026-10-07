pub mod contracts;
pub mod document;
pub mod ipc;
pub mod neovim;
pub mod validation;

pub fn runtime_status() -> contracts::RuntimeStatus {
    contracts::RuntimeStatus {
        contract_version: 1,
        connection: contracts::ConnectionState::Disconnected,
        detail: "Neovim actor は実 Neovim embed として実装中です。文書コマンドは open_document から利用できます。".into(),
    }
}

#[cfg(feature = "desktop")]
#[tauri::command]
fn get_runtime_status(state: tauri::State<ipc::ActorState>) -> contracts::RuntimeStatus {
    let has_document = state
        .actor
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().map(|_| ()))
        .is_some();
    // Truthful until a persistent connection manager lands: report connected
    // only when an actor holds a live embedded session in this process.
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
    use tauri::Manager;
    tauri::Builder::default()
        .setup(|app| {
            neovim::configure_resource_dir(app.path().resource_dir()?);
            Ok(())
        })
        .manage(ipc::ActorState::default())
        .invoke_handler(tauri::generate_handler![
            get_runtime_status,
            ipc::open_document,
            ipc::fetch_snapshot,
            ipc::apply_gui_edits,
            ipc::save_document,
            ipc::fetch_mode,
            ipc::undo_document,
            ipc::report_cursor
        ])
        .run(tauri::generate_context!())
        .expect("Marxen desktop runtime failed");
}
