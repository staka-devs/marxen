//! Clipboard publishing port with one retained native owner.
pub trait Clipboard: Send + Sync {
    /// Publish the requested native formats atomically where supported, retaining selection ownership.
    fn write(&self, text: String, html: Option<String>, rtf: Option<String>) -> Result<(), String>;
}
