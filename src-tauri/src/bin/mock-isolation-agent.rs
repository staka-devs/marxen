//! Mock file-editing CLI for isolation tests. Simulates a CLI AI that edits
//! only the isolated staging copy: it never receives live paths.
//!
//! Usage: mock-isolation-agent --staging-dir <DIR> --file <relative> --text <content>
//! Exits non-zero on traversal, absolute paths, or symlink escapes.
use std::path::{Component, Path, PathBuf};

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
