//! Tauri clipboard adapter; native publication is supplied by the composition root.
use std::sync::Arc;
pub struct ClipboardState(pub Arc<dyn crate::application::clipboard::Clipboard>);
/// Publish copy formats through the retained native clipboard port.
#[tauri::command(async)]
pub fn write_clipboard(
    state: tauri::State<'_, ClipboardState>,
    text: String,
    html: Option<String>,
    rtf: Option<String>,
) -> Result<(), String> {
    state.0.write(text, html, rtf)
}
