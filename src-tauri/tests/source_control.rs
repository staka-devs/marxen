//! Issue #121: the native Git adapter against a real temporary repository.
use marxen_lib::application::source_control::{change_diff, head_text, SourceControl};
use marxen_lib::contracts::WorkspaceError;
use marxen_lib::infrastructure::git::NativeGit;
use std::path::Path;
use std::process::Command;

/// Run one git command in `root`, failing the test on error.
fn git(root: &Path, args: &[&str]) {
    let status = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["-c", "user.name=t", "-c", "user.email=t@example.invalid"])
        .args(args)
        .status()
        .expect("git available");
    assert!(status.success(), "git {args:?}");
}

#[test]
/// Report modified and untracked files and diff each against HEAD or empty.
fn status_and_diffs_follow_the_work_tree() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    git(root, &["init", "-q", "-b", "main"]);
    std::fs::write(root.join("a.md"), "old\n").unwrap();
    git(root, &["add", "a.md"]);
    git(root, &["commit", "-q", "-m", "init"]);
    std::fs::write(root.join("a.md"), "new\n").unwrap();
    std::fs::create_dir(root.join("docs")).unwrap();
    std::fs::write(root.join("docs/新規.md"), "hello\n").unwrap();

    let status = NativeGit.status(root).unwrap();
    assert!(status.repository);
    assert_eq!(status.branch.as_deref(), Some("main"));
    let pairs: Vec<_> = status
        .changes
        .iter()
        .map(|change| (change.path.as_str(), change.status.as_str()))
        .collect();
    assert_eq!(pairs, [("a.md", "M"), ("docs/新規.md", "?")]);

    let modified = change_diff(&NativeGit, root, "a.md", "M").unwrap();
    assert!(
        modified.contains("-old") && modified.contains("+new"),
        "{modified}"
    );
    let untracked = change_diff(&NativeGit, root, "docs/新規.md", "?").unwrap();
    assert!(untracked.contains("+hello"), "{untracked}");
    assert!(matches!(
        change_diff(&NativeGit, root, "../outside.md", "M"),
        Err(WorkspaceError::InvalidPath)
    ));
    // Issue #124: the editor gutter compares against the committed text.
    assert_eq!(
        head_text(&NativeGit, root, "a.md").unwrap().as_deref(),
        Some("old\n")
    );
    assert_eq!(head_text(&NativeGit, root, "docs/新規.md").unwrap(), None);
    assert!(matches!(
        head_text(&NativeGit, root, "../a.md"),
        Err(WorkspaceError::InvalidPath)
    ));
}

#[test]
/// A plain folder reports `repository: false` instead of an error.
fn plain_folder_is_not_a_repository() {
    let dir = tempfile::tempdir().unwrap();
    let status = NativeGit.status(dir.path()).unwrap();
    assert!(!status.repository);
    assert!(status.changes.is_empty());
}
