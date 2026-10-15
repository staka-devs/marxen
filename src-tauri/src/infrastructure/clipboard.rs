//! A retained native clipboard keeps Linux selection ownership alive. All
//! operations share one mutex; WebViews never call browser clipboard APIs.

use std::sync::Mutex;

#[derive(Default)]
pub struct NativeClipboard(Mutex<Option<arboard::Clipboard>>);

impl crate::application::clipboard::Clipboard for NativeClipboard {
    /// Read plain text with the same retained clipboard mutex and bounded payload limit.
    fn read_text(&self) -> Result<String, String> {
        let mut guard = self
            .0
            .lock()
            .map_err(|_| "clipboard lock poisoned".to_owned())?;
        if guard.is_none() {
            *guard = Some(arboard::Clipboard::new().map_err(|error| error.to_string())?);
        }
        let text = guard
            .as_mut()
            .expect("clipboard initialized")
            .get_text()
            .map_err(|error| error.to_string())?;
        if text.len() > 20 * 1024 * 1024 {
            return Err("clipboard text exceeds 20 MiB".into());
        }
        Ok(text)
    }
    /// Publish supported native clipboard formats through one platform-specific adapter.
    fn write(&self, text: String, html: Option<String>, rtf: Option<String>) -> Result<(), String> {
        if text
            .len()
            .saturating_add(html.as_ref().map_or(0, String::len))
            .saturating_add(rtf.as_ref().map_or(0, String::len))
            > 20 * 1024 * 1024
        {
            return Err("コピーする内容は 20 MiB 以下にしてください。".into());
        }
        let mut guard = self
            .0
            .lock()
            .map_err(|_| "クリップボードのロックに失敗しました。")?;
        #[cfg(windows)]
        {
            // One clipboard transaction publishes RTF first for native document
            // editors, CF_HTML for web/email targets, and Unicode as a fallback.
            let _guard = &mut guard;
            write_windows(&text, html.as_deref(), rtf.as_deref())
                .map_err(|error| format!("クリップボードへコピーできません: {error}"))
        }
        #[cfg(target_os = "macos")]
        {
            let _guard = &mut guard;
            write_macos(&text, html.as_deref(), rtf.as_deref())
        }
        #[cfg(not(any(windows, target_os = "macos")))]
        {
            let _ = rtf;
            if guard.is_none() {
                *guard = Some(
                    arboard::Clipboard::new()
                        .map_err(|error| format!("クリップボードを開けません: {error}"))?,
                );
            }
            let clipboard = guard.as_mut().expect("clipboard initialized");
            match html {
                Some(html) => clipboard.set_html(html, Some(text)),
                None => clipboard.set_text(text),
            }
            .map_err(|error| format!("クリップボードへコピーできません: {error}"))
        }
    }
}

#[cfg(target_os = "macos")]
/// Publish text, HTML and RTF data together to the macOS pasteboard.
fn write_macos(text: &str, html: Option<&str>, rtf: Option<&str>) -> Result<(), String> {
    use objc2_app_kit::NSPasteboard;
    use objc2_foundation::{NSArray, NSData, NSString};
    let board = NSPasteboard::generalPasteboard();
    let text_type = NSString::from_str("public.utf8-plain-text");
    let html_type = NSString::from_str("public.html");
    let rtf_type = NSString::from_str("public.rtf");
    let mut types = vec![&*text_type];
    if rtf.is_some() {
        types.insert(0, &*rtf_type);
    }
    if html.is_some() {
        types.push(&*html_type);
    }
    let types = NSArray::from_slice(&types);
    // SAFETY: only declared NSString UTIs are used; no custom pasteboard
    // owner is installed. NSPasteboard copies each NSData into its item.
    unsafe {
        board.declareTypes_owner(&types, None);
    }
    if !board.setString_forType(&NSString::from_str(text), &text_type) {
        return Err("クリップボードへテキストをコピーできません。".into());
    }
    if let Some(html) = html {
        let data = NSData::from_vec(html.as_bytes().to_vec());
        if !board.setData_forType(Some(&data), &html_type) {
            return Err("クリップボードへ HTML をコピーできません。".into());
        }
    }
    if let Some(rtf) = rtf {
        let data = NSData::from_vec(rtf.as_bytes().to_vec());
        if !board.setData_forType(Some(&data), &rtf_type) {
            return Err("クリップボードへ RTF をコピーできません。".into());
        }
    }
    Ok(())
}

#[cfg(windows)]
/// Publish Unicode text, CF_HTML and RTF data together to the Windows clipboard.
fn write_windows(
    text: &str,
    html: Option<&str>,
    rtf: Option<&str>,
) -> clipboard_win::SysResult<()> {
    use clipboard_win::{options::NoClear, raw, Clipboard};
    let _open = Clipboard::new_attempts(10)?;
    // Register all required formats before replacing existing clipboard data.
    let html_format = html
        .map(|_| {
            raw::register_format("HTML Format").ok_or_else(clipboard_win::ErrorCode::last_system)
        })
        .transpose()?;
    let rtf_format = rtf
        .map(|_| {
            raw::register_format("Rich Text Format")
                .ok_or_else(clipboard_win::ErrorCode::last_system)
        })
        .transpose()?;
    raw::empty()?;
    if let (Some(rtf), Some(format)) = (rtf, rtf_format) {
        let mut bytes = rtf.as_bytes().to_vec();
        bytes.push(0);
        raw::set_without_clear(format.get(), &bytes)?;
    }
    if let (Some(html), Some(format)) = (html, html_format) {
        raw::set_without_clear(
            format.get(),
            &crate::domain::clipboard_format::windows_html(html),
        )?;
    }
    raw::set_string_with(text, NoClear)?;
    Ok(())
}
