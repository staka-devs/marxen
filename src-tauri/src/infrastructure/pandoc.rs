//! Run pandoc as a child process for PDF export.

use crate::application::ports::PdfConverter;
use crate::contracts::WorkspaceError;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

/// Pandoc found by name on PATH or at the configured path.
pub struct PandocConverter;

impl PdfConverter for PandocConverter {
    /// Pipe Markdown to pandoc and report its stderr tail when it fails.
    fn convert(
        &self,
        program: &str,
        args: &[String],
        markdown: &str,
        folder: &Path,
        destination: &Path,
    ) -> Result<(), WorkspaceError> {
        let mut command = Command::new(program);
        command
            .args(args)
            .arg("-o")
            .arg(destination)
            .current_dir(folder)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let mut child = command.spawn().map_err(|error| WorkspaceError::Io {
            detail: match error.kind() {
                std::io::ErrorKind::NotFound => {
                    format!("{program} が見つかりません。pandoc をインストールするか、設定でパスを指定してください。")
                }
                _ => error.to_string(),
            },
        })?;
        // A failed write means pandoc exited early; its status and stderr explain why.
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(markdown.as_bytes());
        }
        let output = child
            .wait_with_output()
            .map_err(|error| WorkspaceError::Io {
                detail: error.to_string(),
            })?;
        if output.status.success() {
            return Ok(());
        }
        let stderr = String::from_utf8_lossy(&output.stderr);
        let tail: Vec<&str> = stderr.lines().rev().take(8).collect();
        Err(WorkspaceError::Io {
            detail: tail.into_iter().rev().collect::<Vec<_>>().join("\n"),
        })
    }
}
