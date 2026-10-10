//! Dedicated vs user Neovim configuration selection and error reporting.
//!
//! The default is an isolated embedded session (`-u NONE -i NONE -n
//! --noplugin`) so tests and the editor never read the user's `~/.config`.
//! Users may explicitly pick one of `vimrc` / `_vimrc` / `init.vim` /
//! `init.lua`; that file is passed as `-u <path>` and any load failure is
//! surfaced instead of silently falling back.

use std::path::{Path, PathBuf};

pub use crate::application::ports::{ConfigReport, ConfigSource};

/// Supported user config file names (case-sensitive on disk, matched
/// case-insensitively for Windows `_vimrc` conventions).
pub fn is_supported_config_name(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    matches!(
        name.to_ascii_lowercase().as_str(),
        "vimrc" | "_vimrc" | ".vimrc" | "init.vim" | "init.lua"
    )
}

pub fn describe_source(source: &ConfigSource) -> String {
    match source {
        ConfigSource::Isolated => "isolated(-u NONE)".into(),
        ConfigSource::UserFile(path) => format!("user:{}", path.display()),
    }
}

/// Extra argv for `nvim --embed` for a validated source.
pub fn argv_for(source: &ConfigSource) -> Result<Vec<String>, String> {
    match source {
        ConfigSource::Isolated => Ok(vec![
            "-u".into(),
            "NONE".into(),
            "-i".into(),
            "NONE".into(),
            "-n".into(),
            "--noplugin".into(),
        ]),
        ConfigSource::UserFile(path) => {
            if !path.is_file() {
                return Err(format!("config not found: {}", path.display()));
            }
            if !is_supported_config_name(path) {
                return Err(format!(
                    "unsupported config name (want vimrc/_vimrc/init.vim/init.lua): {}",
                    path.display()
                ));
            }
            Ok(vec![
                "-u".into(),
                path.to_string_lossy().into_owned(),
                "-i".into(),
                "NONE".into(),
                "-n".into(),
            ])
        }
    }
}

/// Collect boot errors from child stderr text plus `:messages` output.
pub fn collect_errors(stderr_text: &str, messages_output: &str) -> Vec<String> {
    let mut errors = Vec::new();
    for line in stderr_text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        // Neovim echoes config failures on stderr as E-numbers / lua errors.
        if line.contains('E') || line.to_ascii_lowercase().contains("error") || line.contains("lua")
        {
            errors.push(format!("stderr: {line}"));
        }
    }
    for line in messages_output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        let lower = line.to_ascii_lowercase();
        if line.contains('E') || lower.contains("error") || lower.contains("failed") {
            errors.push(format!("messages: {line}"));
        }
    }
    errors.sort();
    errors.dedup();
    errors
}

#[cfg(test)]
mod unit {
    use super::*;

    #[test]
    fn accepts_supported_names() {
        for name in ["vimrc", "_vimrc", "init.vim", "init.lua", ".vimrc"] {
            assert!(is_supported_config_name(Path::new(name)), "{name}");
        }
        assert!(!is_supported_config_name(Path::new("init.toml")));
        assert!(!is_supported_config_name(Path::new("plugin.vim")));
    }

    #[test]
    fn isolated_argv_never_touches_home() {
        let argv = argv_for(&ConfigSource::Isolated).unwrap().join(" ");
        assert!(argv.contains("-u NONE"));
        assert!(argv.contains("--noplugin"));
    }

    #[test]
    fn surfaces_error_lines() {
        let errors = collect_errors(
            "E492: Not an editor command: BogusCmd\nlistening on pipe",
            "E492: Not an editor command: BogusCmd",
        );
        assert!(errors.iter().any(|line| line.contains("E492")));
    }
}
