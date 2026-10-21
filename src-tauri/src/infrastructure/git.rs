//! Native `git` CLI adapter for read-only source-control views.

use crate::application::source_control::SourceControl;
use crate::contracts::{GitStatus, WorkspaceError};
use crate::domain::git::parse_porcelain;
use std::path::Path;
use std::process::{Command, Output, Stdio};

/// Diffs beyond this size are cut so one huge file cannot stall the view.
const MAX_DIFF_BYTES: usize = 1024 * 1024;
/// HEAD texts beyond this size are not compared in the editor gutter.
const MAX_HEAD_BYTES: usize = 4 * 1024 * 1024;

/// Runs the user's `git` without a shell.
pub struct NativeGit;

/// Build a read-only `git -C root` command that never runs repository-configured programs.
fn git(root: &Path) -> Command {
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(root)
        .args(["-c", "core.fsmonitor=false"])
        .env("GIT_LITERAL_PATHSPECS", "1")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    command
}

/// Run a command, mapping a missing `git` and spawn failures to readable I/O errors.
fn run(mut command: Command) -> Result<Output, WorkspaceError> {
    command.output().map_err(|error| WorkspaceError::Io {
        detail: if error.kind() == std::io::ErrorKind::NotFound {
            "git が見つかりません。Git をインストールして PATH に追加してください。".into()
        } else {
            format!("git を起動できません: {error}")
        },
    })
}

/// Surface git's own stderr for a failed command.
fn failure(output: &Output) -> WorkspaceError {
    WorkspaceError::Io {
        detail: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
    }
}

impl SourceControl for NativeGit {
    /// Read branch and changes including every untracked file.
    fn status(&self, root: &Path) -> Result<GitStatus, WorkspaceError> {
        let mut command = git(root);
        command.args([
            "status",
            "--porcelain=v1",
            "-z",
            "--branch",
            "--untracked-files=all",
        ]);
        let output = run(command)?;
        if !output.status.success() {
            if String::from_utf8_lossy(&output.stderr).contains("not a git repository") {
                return Ok(GitStatus {
                    repository: false,
                    branch: None,
                    changes: Vec::new(),
                });
            }
            return Err(failure(&output));
        }
        let (branch, changes) = parse_porcelain(&String::from_utf8_lossy(&output.stdout));
        Ok(GitStatus {
            repository: true,
            branch,
            changes,
        })
    }

    /// Diff against HEAD, or against an empty file for untracked paths.
    fn diff(&self, root: &Path, path: &str, untracked: bool) -> Result<String, WorkspaceError> {
        let mut command = git(root);
        command.args(["diff", "--no-color", "--no-ext-diff", "--no-textconv"]);
        if untracked {
            command.args(["--no-index", "--", "/dev/null", path]);
        } else {
            command.args(["HEAD", "--", path]);
        }
        let output = run(command)?;
        // `--no-index` exits 1 when the files differ, which is the expected result here.
        let differ = untracked && output.status.code() == Some(1);
        if !output.status.success() && !differ {
            return Err(failure(&output));
        }
        let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
        if text.len() > MAX_DIFF_BYTES {
            let mut cut = MAX_DIFF_BYTES;
            while !text.is_char_boundary(cut) {
                cut -= 1;
            }
            text.truncate(cut);
            text.push_str("\n… (差分が大きいため省略しました)\n");
        }
        Ok(text)
    }

    /// Read the committed blob without filters, so no repository-configured program runs.
    fn head_text(&self, root: &Path, path: &str) -> Result<Option<String>, WorkspaceError> {
        let mut command = git(root);
        command.args(["cat-file", "blob", &format!("HEAD:./{path}")]);
        let output = run(command)?;
        // Untracked, unborn HEAD or outside a repository: nothing to compare against.
        if !output.status.success() || output.stdout.len() > MAX_HEAD_BYTES {
            return Ok(None);
        }
        Ok(String::from_utf8(output.stdout).ok())
    }
}
