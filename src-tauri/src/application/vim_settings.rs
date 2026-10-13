//! Managed vim-settings file use case with fingerprint-guarded writes.
//!
//! Pure orchestration over a small file port: path resolution, UTF-8 checks,
//! managed-block parsing, and stale-file rejection. Native I/O stays behind
//! [`VimSettingsFiles`]; document buffers are never touched here so unsaved
//! text survives config saves and applies.

use crate::contracts::vim_settings::{VimConfigRead, VimConfigWrite, VimSettings};
use crate::contracts::WorkspaceError;
use crate::domain::storage::Fingerprint;
use crate::domain::vim_settings;
use std::path::{Path, PathBuf};

/// Minimal file access required by the vim-settings use case.
pub trait VimSettingsFiles: Send + Sync {
    /// Read raw file bytes, returning `None` only for a missing file.
    fn read_raw(&self, path: &Path) -> Result<Option<Vec<u8>>, WorkspaceError>;
    /// Read the current content fingerprint, returning `None` for a missing file.
    fn fingerprint_raw(&self, path: &Path) -> Result<Option<Fingerprint>, WorkspaceError>;
    /// Replace file bytes only when the current fingerprint matches `expected`.
    fn write_raw_guarded(
        &self,
        path: &Path,
        bytes: &[u8],
        expected: Option<&Fingerprint>,
    ) -> Result<Fingerprint, WorkspaceError>;
    /// Create the parent directory hierarchy when it is missing.
    fn ensure_parent(&self, path: &Path) -> Result<(), WorkspaceError>;
}

/// Resolve the effective config path from an explicit selection or the app standard.
///
/// An empty selection uses the app-specific `<app_data>/marxen/vimrc` so the
/// GUI never writes a user-global file by accident. Explicit paths must be
/// absolute with a supported vimrc/init.lua basename.
pub fn resolve_settings_path(
    explicit: Option<&str>,
    app_data: &Path,
) -> Result<PathBuf, WorkspaceError> {
    match explicit.map(str::trim) {
        None | Some("") => Ok(app_data.join("marxen").join("vimrc")),
        Some(selected) => {
            if selected.contains('\0') {
                return Err(WorkspaceError::InvalidPath);
            }
            let path = PathBuf::from(selected);
            if !path.is_absolute() {
                return Err(WorkspaceError::InvalidPath);
            }
            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or(WorkspaceError::InvalidPath)?;
            if !vim_settings::is_vimrc_name(name) && !vim_settings::is_lua_name(name) {
                return Err(WorkspaceError::InvalidPath);
            }
            Ok(path)
        }
    }
}

/// Decode config bytes as UTF-8 text without newline or BOM conversion.
fn decode_config(bytes: &[u8]) -> Result<String, WorkspaceError> {
    String::from_utf8(bytes.to_vec()).map_err(|_| WorkspaceError::InvalidUtf8)
}

/// Read a config file with its fingerprint, Lua flag, and managed parse state.
///
/// Missing files report defaults with `exists == false`. Undecodable bytes
/// and oversized files are file errors; an unparsable managed block is
/// returned as `managed_error` while the raw text stays inspectable.
pub fn read_settings(
    files: &dyn VimSettingsFiles,
    path: &Path,
) -> Result<VimConfigRead, WorkspaceError> {
    let bytes = files.read_raw(path)?;
    let Some(bytes) = bytes else {
        return Ok(VimConfigRead {
            path: path.display().to_string(),
            fingerprint: None,
            exists: false,
            is_lua: vim_settings::is_lua_path(path),
            raw: String::new(),
            settings: vim_settings::default_settings(),
            managed_error: None,
        });
    };
    if bytes.len() > vim_settings::MAX_CONFIG_BYTES {
        return Err(WorkspaceError::Io {
            detail: "設定ファイルが大きすぎます。".into(),
        });
    }
    let raw = decode_config(&bytes)?;
    let fingerprint = Some(crate::domain::storage::fingerprint(&bytes).0);
    let is_lua = vim_settings::is_lua_path(path);
    match vim_settings::parse_managed(&raw) {
        Ok(None) => Ok(VimConfigRead {
            path: path.display().to_string(),
            fingerprint,
            exists: true,
            is_lua,
            raw,
            settings: vim_settings::default_settings(),
            managed_error: None,
        }),
        Ok(Some(settings)) => {
            let failures = vim_settings::validate_settings(&settings);
            Ok(VimConfigRead {
                path: path.display().to_string(),
                fingerprint,
                exists: true,
                is_lua,
                raw,
                settings,
                managed_error: failures.into_iter().next(),
            })
        }
        Err(detail) => Ok(VimConfigRead {
            path: path.display().to_string(),
            fingerprint,
            exists: true,
            is_lua,
            raw,
            settings: vim_settings::default_settings(),
            managed_error: Some(detail),
        }),
    }
}

/// Compare the caller-observed fingerprint hex against current disk state.
fn check_fresh(
    files: &dyn VimSettingsFiles,
    path: &Path,
    expected: Option<&str>,
) -> Result<Option<Fingerprint>, WorkspaceError> {
    let current = files.fingerprint_raw(path)?;
    let current_hex = current.as_ref().map(|f| f.0.as_str());
    if current_hex != expected {
        return Err(WorkspaceError::Conflict {
            path: path.display().to_string(),
        });
    }
    Ok(current)
}

/// Save structured settings by rewriting only the managed block.
///
/// Rejects invalid settings, Lua targets, malformed existing blocks, and
/// stale baselines. Outside-block text is preserved; document buffers are
/// untouched so unsaved text survives.
pub fn write_managed_settings(
    files: &dyn VimSettingsFiles,
    path: &Path,
    expected_fingerprint: Option<&str>,
    settings: &VimSettings,
) -> Result<VimConfigWrite, WorkspaceError> {
    if let Some(first) = vim_settings::validate_settings(settings).into_iter().next() {
        return Err(WorkspaceError::Io { detail: first });
    }
    if vim_settings::is_lua_path(path) {
        return Err(WorkspaceError::InvalidPath);
    }
    let current = check_fresh(files, path, expected_fingerprint)?;
    let raw = match files.read_raw(path)? {
        Some(bytes) => decode_config(&bytes)?,
        None => String::new(),
    };
    let next = vim_settings::rewrite_managed(&raw, settings, false)
        .map_err(|detail| WorkspaceError::Io { detail })?;
    files.ensure_parent(path)?;
    let fingerprint = files.write_raw_guarded(path, next.as_bytes(), current.as_ref())?;
    Ok(VimConfigWrite {
        path: path.display().to_string(),
        fingerprint: fingerprint.0,
        raw: next,
    })
}

/// Save caller-edited raw text with a stale-file guard and no reinterpretation.
///
/// Both Vimscript and Lua targets are accepted; the text is stored verbatim
/// after UTF-8 and size checks. Managed blocks are never inserted here.
pub fn write_raw_settings(
    files: &dyn VimSettingsFiles,
    path: &Path,
    expected_fingerprint: Option<&str>,
    raw: &str,
) -> Result<VimConfigWrite, WorkspaceError> {
    if raw.len() > vim_settings::MAX_CONFIG_BYTES {
        return Err(WorkspaceError::Io {
            detail: "設定ファイルが大きすぎます。".into(),
        });
    }
    let current = check_fresh(files, path, expected_fingerprint)?;
    files.ensure_parent(path)?;
    let fingerprint = files.write_raw_guarded(path, raw.as_bytes(), current.as_ref())?;
    Ok(VimConfigWrite {
        path: path.display().to_string(),
        fingerprint: fingerprint.0,
        raw: raw.to_owned(),
    })
}

#[cfg(test)]
mod unit {
    use super::*;
    use std::collections::BTreeMap;
    use std::sync::Mutex;

    struct MemoryFiles {
        files: Mutex<BTreeMap<PathBuf, Vec<u8>>>,
    }

    impl MemoryFiles {
        /// Create an empty in-memory file store for use-case tests.
        fn empty() -> Self {
            Self {
                files: Mutex::new(BTreeMap::new()),
            }
        }
    }

    impl VimSettingsFiles for MemoryFiles {
        /// Read bytes from the in-memory store without touching the disk.
        fn read_raw(&self, path: &Path) -> Result<Option<Vec<u8>>, WorkspaceError> {
            Ok(self.files.lock().unwrap().get(path).cloned())
        }
        /// Fingerprint the in-memory bytes for conflict comparison.
        fn fingerprint_raw(&self, path: &Path) -> Result<Option<Fingerprint>, WorkspaceError> {
            Ok(self
                .files
                .lock()
                .unwrap()
                .get(path)
                .map(|bytes| crate::domain::storage::fingerprint(bytes)))
        }
        /// Guarded in-memory write comparing the expected baseline first.
        fn write_raw_guarded(
            &self,
            path: &Path,
            bytes: &[u8],
            expected: Option<&Fingerprint>,
        ) -> Result<Fingerprint, WorkspaceError> {
            let mut guard = self.files.lock().unwrap();
            let current = guard
                .get(path)
                .map(|b| crate::domain::storage::fingerprint(b));
            if current.as_ref() != expected {
                return Err(WorkspaceError::Conflict {
                    path: path.display().to_string(),
                });
            }
            guard.insert(path.to_owned(), bytes.to_vec());
            Ok(crate::domain::storage::fingerprint(bytes))
        }
        /// Accept every parent directory inside the memory store.
        fn ensure_parent(&self, _path: &Path) -> Result<(), WorkspaceError> {
            Ok(())
        }
    }

    /// Resolve an empty selection to the app-specific standard config path.
    #[test]
    fn standard_path_avoids_user_global() {
        let app = Path::new("/tmp/marxen-app");
        let resolved = resolve_settings_path(None, app).unwrap();
        assert_eq!(resolved, app.join("marxen").join("vimrc"));
        assert!(resolve_settings_path(Some("relative/vimrc"), app).is_err());
        assert!(resolve_settings_path(Some("/tmp/init.toml"), app).is_err());
    }

    /// Reject a stale baseline so external changes are never overwritten.
    #[test]
    fn stale_write_conflicts() {
        let files = MemoryFiles::empty();
        let path = Path::new("/tmp/standard/vimrc");
        files
            .files
            .lock()
            .unwrap()
            .insert(path.to_owned(), b"set number\n".to_vec());
        let result = write_managed_settings(&files, path, None, &vim_settings::default_settings());
        assert!(matches!(result, Err(WorkspaceError::Conflict { .. })));
    }

    /// Preserve outside text across a managed save and report the new fingerprint.
    #[test]
    fn managed_save_preserves_outside() {
        let files = MemoryFiles::empty();
        let path = Path::new("/tmp/standard/vimrc");
        files.files.lock().unwrap().insert(
            path.to_owned(),
            "\" 日本語 🎉\nset number\n".as_bytes().to_vec(),
        );
        let first = read_settings(&files, path).unwrap();
        assert!(first.managed_error.is_none());
        let written = write_managed_settings(
            &files,
            path,
            first.fingerprint.as_deref(),
            &vim_settings::default_settings(),
        )
        .unwrap();
        assert!(written.raw.contains("\" 日本語 🎉"));
        assert!(written.raw.contains("set number"));
        let second = read_settings(&files, path).unwrap();
        assert_eq!(
            second.fingerprint.as_deref(),
            Some(written.fingerprint.as_str())
        );
    }

    /// Accept raw Lua text while refusing managed writes to Lua targets.
    #[test]
    fn lua_raw_only() {
        let files = MemoryFiles::empty();
        let path = Path::new("/tmp/standard/init.lua");
        let written = write_raw_settings(&files, path, None, "vim.opt.number = true\n").unwrap();
        assert!(written.raw.contains("vim.opt.number"));
        let read = read_settings(&files, path).unwrap();
        assert!(read.is_lua);
        assert!(write_managed_settings(
            &files,
            path,
            read.fingerprint.as_deref(),
            &vim_settings::default_settings()
        )
        .is_err());
    }
}
