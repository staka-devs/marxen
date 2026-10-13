/// Run Tauri's build-time resource/configuration setup when desktop support is enabled.
/// Builds without the desktop feature perform no Tauri build setup.
fn main() {
    #[cfg(feature = "desktop")]
    tauri_build::build();
}
