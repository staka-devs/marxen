//! Export a document's current text to PDF through the user's pandoc command.

use super::Workspace;
use crate::application::ports::PdfConverter;
use crate::contracts::WorkspaceError;
use std::path::{Path, PathBuf};

impl Workspace {
    /// Current buffer text and the folder its relative links resolve from (the root for untitled notes).
    pub fn pdf_source(&self, document_id: &str) -> Result<(String, PathBuf), WorkspaceError> {
        let actor = self.actor(document_id)?;
        let folder = actor
            .path()
            .and_then(|path| path.parent().map(PathBuf::from))
            .unwrap_or_else(|| self.root.clone());
        Ok((actor.snapshot().text, folder))
    }
}

/// True for a program named `pandoc` (any folder, optional `.exe`); the settings may not run other tools.
fn is_pandoc(program: &str) -> bool {
    let name = program.rsplit(['/', '\\']).next().unwrap_or_default();
    matches!(name.to_ascii_lowercase().as_str(), "pandoc" | "pandoc.exe")
}

/// Validate the configured command and an absolute `.pdf` destination, then convert.
pub fn export_pdf(
    converter: &dyn PdfConverter,
    markdown: &str,
    folder: &Path,
    destination: &Path,
    program: &str,
    args: &[String],
) -> Result<(), WorkspaceError> {
    let pdf = destination
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("pdf"));
    if !is_pandoc(program.trim()) || !destination.is_absolute() || !pdf {
        return Err(WorkspaceError::InvalidPath);
    }
    converter.convert(program.trim(), args, markdown, folder, destination)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// Records the last call instead of running pandoc.
    #[derive(Default)]
    struct Recorder(Mutex<Option<(String, Vec<String>, String)>>);
    impl PdfConverter for Recorder {
        /// Remember the program, arguments and stdin text.
        fn convert(
            &self,
            program: &str,
            args: &[String],
            markdown: &str,
            _folder: &Path,
            _destination: &Path,
        ) -> Result<(), WorkspaceError> {
            *self.0.lock().unwrap() = Some((program.into(), args.to_vec(), markdown.into()));
            Ok(())
        }
    }

    /// Only pandoc runs, and only into an absolute `.pdf` path.
    #[test]
    fn only_pandoc_writes_absolute_pdf_files() {
        let recorder = Recorder::default();
        let out = std::env::temp_dir().join("note.pdf");
        let args = vec!["--toc".to_owned()];
        for program in ["pandoc", "C:\\Tools\\pandoc.exe", "/usr/bin/pandoc"] {
            assert!(export_pdf(&recorder, "# x", Path::new("."), &out, program, &args).is_ok());
        }
        assert_eq!(
            recorder.0.lock().unwrap().clone(),
            Some(("/usr/bin/pandoc".into(), args.clone(), "# x".into()))
        );
        for program in ["cmd", "pandoc2", "C:\\pandoc\\sh.exe", ""] {
            assert!(export_pdf(&recorder, "", Path::new("."), &out, program, &args).is_err());
        }
        let relative = Path::new("note.pdf");
        assert!(export_pdf(&recorder, "", Path::new("."), relative, "pandoc", &args).is_err());
        let html = std::env::temp_dir().join("note.html");
        assert!(export_pdf(&recorder, "", Path::new("."), &html, "pandoc", &args).is_err());
    }
}
