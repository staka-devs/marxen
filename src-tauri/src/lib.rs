pub mod contracts;
pub mod validation;

pub fn runtime_status() -> contracts::RuntimeStatus {
    contracts::RuntimeStatus {
        contract_version: 1,
        connection: contracts::ConnectionState::Disconnected,
        detail: "Neovim actor は未実装です。文書の編集・保存はまだ利用できません。".into(),
    }
}

#[cfg(feature = "desktop")]
#[tauri::command]
fn get_runtime_status() -> contracts::RuntimeStatus {
    runtime_status()
}

#[cfg(feature = "desktop")]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![get_runtime_status])
        .run(tauri::generate_context!())
        .expect("Marxen desktop runtime failed");
}
