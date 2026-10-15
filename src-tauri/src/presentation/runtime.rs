use crate::contracts;
/// Return an explicit disconnected runtime status when no native buffer is active.
pub fn disconnected_status() -> contracts::RuntimeStatus {
    contracts::RuntimeStatus {
        contract_version: 1,
        connection: contracts::ConnectionState::Disconnected,
        detail: "ワークスペースの Markdown ファイルを開くと Neovim に接続します。".into(),
    }
}

#[cfg(feature = "desktop")]
#[tauri::command]
/// Report authoritative buffer connectivity through the injected desktop registry.
pub fn get_runtime_status(
    state: tauri::State<super::document::ActorState>,
) -> contracts::RuntimeStatus {
    let has_document = state
        .workspace
        .lock()
        .ok()
        .is_some_and(|guard| guard.has_live_documents());
    // A retained document is not evidence that its process is still running.
    if has_document {
        contracts::RuntimeStatus {
            contract_version: 1,
            connection: contracts::ConnectionState::Connected,
            detail: "実 Neovim embed セッションが文書を所有しています。".into(),
        }
    } else {
        disconnected_status()
    }
}
