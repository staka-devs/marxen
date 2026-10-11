//! Mock file-editing CLI for isolation tests. Simulates a CLI AI that edits
//! only the isolated staging copy: it never receives live paths.
//!
//! Usage: `mock-isolation-agent --staging-dir <DIR> --file <relative> --text <content>`
//! Exits non-zero on invalid paths, a symlink at the target, or filesystem errors.
use std::path::{Component, Path, PathBuf};

/// Read the first matching `--flag value` or `--flag=value` command-line argument.
/// Return `None` if absent or if the separate flag has no following value.
fn arg_value(name: &str) -> Option<String> {
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == name {
            return args.next();
        }
        if let Some(rest) = arg.strip_prefix(&format!("{name}=")) {
            return Some(rest.to_owned());
        }
    }
    None
}

/// Normalize a relative candidate lexically under a nonempty staging root.
/// Reject empty/absolute targets and parent traversal beyond the root; symlinks
/// are not resolved here, and the caller separately checks the final target.
fn guard(root: &Path, candidate: &Path) -> Result<PathBuf, String> {
    if root.as_os_str().is_empty() {
        return Err("empty root".into());
    }
    let portable = candidate.as_os_str().to_string_lossy();
    let bytes = portable.as_bytes();
    if portable.starts_with('\\')
        || (bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':')
    {
        return Err("absolute path rejected".into());
    }
    let mut normalized = PathBuf::new();
    for component in candidate.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    return Err("traversal outside staging".into());
                }
            }
            Component::Normal(part) => normalized.push(part),
            Component::RootDir | Component::Prefix(_) => {
                return Err("absolute path rejected".into());
            }
        }
    }
    if normalized.as_os_str().is_empty() {
        return Err("empty file".into());
    }
    let joined = root.join(&normalized);
    if !joined.starts_with(root) {
        return Err("outside staging".into());
    }
    Ok(joined)
}

/// Write the supplied UTF-8 text into a guarded staging target, creating parent directories.
/// Exit 2 for missing required arguments, 3 for rejected paths/final symlinks,
/// and 1 for mkdir/write failures; successful writes print the target path.
fn main() {
    let staging = arg_value("--staging-dir").unwrap_or_default();
    let file = arg_value("--file").unwrap_or_default();
    let text = arg_value("--text").unwrap_or_default();
    if staging.is_empty() || file.is_empty() {
        eprintln!("mock-isolation-agent: --staging-dir and --file are required");
        std::process::exit(2);
    }
    let root = Path::new(&staging);
    let target = guard(root, Path::new(&file)).unwrap_or_else(|e| {
        eprintln!("mock-isolation-agent: rejected: {e}");
        std::process::exit(3);
    });
    if std::fs::symlink_metadata(&target)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
    {
        eprintln!("mock-isolation-agent: symlink rejected");
        std::process::exit(3);
    }
    if let Some(parent) = target.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            eprintln!("mock-isolation-agent: mkdir failed: {e}");
            std::process::exit(1);
        }
    }
    if let Err(e) = std::fs::write(&target, text.as_bytes()) {
        eprintln!("mock-isolation-agent: write failed: {e}");
        std::process::exit(1);
    }
    println!("wrote {}", target.display());
}
