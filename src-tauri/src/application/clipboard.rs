//! Clipboard publishing port with one retained native owner.
pub trait Clipboard: Send + Sync {
    /// Read bounded plain text from the native clipboard for an explicit editor paste.
    fn read_text(&self) -> Result<String, String>;
    /// Publish the requested native formats atomically where supported, retaining selection ownership.
    fn write(&self, text: String, html: Option<String>, rtf: Option<String>) -> Result<(), String>;
}
