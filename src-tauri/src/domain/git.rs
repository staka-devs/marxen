//! Pure Git rules: porcelain status parsing and safe workspace-relative paths.

use crate::contracts::{GitChange, WorkspaceError};

/// Parse `git status --porcelain=v1 -z --branch` output into the branch and changes.
///
/// Renames list the new path; the original path record that follows is skipped.
pub fn parse_porcelain(output: &str) -> (Option<String>, Vec<GitChange>) {
    let mut branch = None;
    let mut changes = Vec::new();
    let mut records = output.split('\0').filter(|record| !record.is_empty());
    while let Some(record) = records.next() {
        if let Some(head) = record.strip_prefix("## ") {
            branch = branch_name(head);
            continue;
        }
        if record.len() < 4 || !record.is_char_boundary(3) {
            continue;
        }
        let (code, path) = (&record[..2], &record[3..]);
        if code.starts_with(['R', 'C']) {
            records.next();
        }
        changes.push(GitChange {
            path: path.to_owned(),
            status: status_letter(code).to_owned(),
        });
    }
    (branch, changes)
}

/// Read the branch from the `##` header, ignoring upstream and detached markers.
fn branch_name(head: &str) -> Option<String> {
    let head = head.strip_prefix("No commits yet on ").unwrap_or(head);
    let name = head.split("...").next().unwrap_or(head).trim();
    (!name.is_empty() && !name.starts_with("HEAD (")).then(|| name.to_owned())
}

/// Collapse the two-letter porcelain code into one display letter.
fn status_letter(code: &str) -> &'static str {
    match code {
        "??" => "?",
        "DD" | "AA" => "U",
        _ if code.contains('U') => "U",
        _ => match code.chars().find(|c| *c != ' ' && *c != '.') {
            Some('R') => "R",
            Some('A' | 'C') => "A",
            Some('D') => "D",
            _ => "M",
        },
    }
}

/// Accept only plain `/`-separated paths inside the root, as reported by `git status`.
pub fn validate_change_path(path: &str) -> Result<(), WorkspaceError> {
    let unsafe_component = path
        .split('/')
        .any(|part| part.is_empty() || part == "." || part == "..");
    if path.contains(['\\', '\0', ':']) || path.starts_with('/') || unsafe_component {
        return Err(WorkspaceError::InvalidPath);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    /// Parse branch, modified, untracked, renamed and conflicted entries.
    fn parses_porcelain_records() {
        let output = "## main...origin/main [ahead 1]\0 M a.md\0?? 新規.md\0R  new.md\0old.md\0UU c.md\0D  gone.md\0";
        let (branch, changes) = parse_porcelain(output);
        assert_eq!(branch.as_deref(), Some("main"));
        let pairs: Vec<_> = changes
            .iter()
            .map(|change| (change.path.as_str(), change.status.as_str()))
            .collect();
        assert_eq!(
            pairs,
            [
                ("a.md", "M"),
                ("新規.md", "?"),
                ("new.md", "R"),
                ("c.md", "U"),
                ("gone.md", "D")
            ]
        );
    }

    #[test]
    /// Report no branch for a detached HEAD and the branch before the first commit.
    fn reads_detached_and_unborn_branches() {
        assert_eq!(parse_porcelain("## HEAD (no branch)\0").0, None);
        assert_eq!(
            parse_porcelain("## No commits yet on main\0").0.as_deref(),
            Some("main")
        );
    }

    #[test]
    /// Refuse traversal, absolute, drive and pathspec-magic paths.
    fn rejects_unsafe_paths() {
        for path in [
            "../x.md",
            "/etc/passwd",
            "C:/x.md",
            "a\\b.md",
            ":(top)x",
            "a//b",
            "",
        ] {
            assert!(validate_change_path(path).is_err(), "{path}");
        }
        assert!(validate_change_path("docs/a b.md").is_ok());
    }
}
