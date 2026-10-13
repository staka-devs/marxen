//! Native file adapter behind the vim-settings use-case port.
//!
//! All config side effects live here: explicit-path validation stays in the
//! use case, while this adapter only reads, fingerprints, guard-writes, and
//! creates parent directories through the shared storage helpers.

use crate::application::vim_settings::VimSettingsFiles;
use crate::contracts::WorkspaceError;
use crate::domain::storage::Fingerprint;
use std::path::Path;

/// Filesystem adapter satisfying the vim-settings port with native storage.
pub struct NativeVimSettingsFiles;

impl VimSettingsFiles for NativeVimSettingsFiles {
    /// Read raw config bytes, returning `None` only for a missing file.
    fn read_raw(&self, path: &Path) -> Result<Option<Vec<u8>>, WorkspaceError> {
        crate::infrastructure::storage::read_disk(path)
    }
    /// Fingerprint current config bytes for stale-file comparison.
    fn fingerprint_raw(&self, path: &Path) -> Result<Option<Fingerprint>, WorkspaceError> {
        crate::infrastructure::storage::disk_fingerprint(path)
    }
    /// Guarded atomic config replacement without a workspace containment root.
    fn write_raw_guarded(
        &self,
        path: &Path,
        bytes: &[u8],
        expected: Option<&Fingerprint>,
    ) -> Result<Fingerprint, WorkspaceError> {
        crate::infrastructure::storage::atomic_write(path, bytes, expected, None)
    }
    /// Create the config parent directory hierarchy when it is missing.
    fn ensure_parent(&self, path: &Path) -> Result<(), WorkspaceError> {
        let parent = path.parent().ok_or(WorkspaceError::InvalidPath)?;
        if !parent.exists() {
            std::fs::create_dir_all(parent)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod unit {
    use super::*;
    use crate::application::vim_settings::{
        read_settings, write_managed_settings, write_raw_settings,
    };
    use crate::domain::vim_settings::{default_settings, render_managed};

    /// Persist real leader characters without altering unmanaged bytes or bypassing stale guards.
    #[test]
    fn temp_fixture_leaders_preserve_bytes_and_fingerprints() {
        let files = NativeVimSettingsFiles;
        let path = temp_config("leader-bytes");
        for leader in [" ", "\\", ",", ";", "界"] {
            let _ = std::fs::remove_file(&path);
            let prefix = "\r\n\r\n";
            let suffix = "\" 外側 🎉 改行なし";
            let original = format!(
                "{prefix}{}\r\n{suffix}",
                render_managed(&default_settings()).join("\r\n")
            );
            let baseline = write_raw_settings(&files, &path, None, &original).unwrap();
            let mut settings = default_settings();
            settings.leader = leader.into();
            let written =
                write_managed_settings(&files, &path, Some(&baseline.fingerprint), &settings)
                    .unwrap();
            let expected = format!(
                "{prefix}{}\r\n{suffix}",
                render_managed(&settings).join("\r\n")
            );
            assert_eq!(std::fs::read(&path).unwrap(), expected.as_bytes());
            assert_eq!(
                read_settings(&files, &path).unwrap().settings.leader,
                leader
            );
            let external = format!("{expected}\r\n\" external");
            std::fs::write(&path, external.as_bytes()).unwrap();
            assert!(matches!(
                write_managed_settings(
                    &files,
                    &path,
                    Some(&written.fingerprint),
                    &default_settings()
                ),
                Err(WorkspaceError::Conflict { .. })
            ));
            assert_eq!(std::fs::read(&path).unwrap(), external.as_bytes());
        }
        let _ = std::fs::remove_file(&path);
    }

    /// Build a unique temporary config path without touching user-global files.
    fn temp_config(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "marxen-vim-settings-{}-{}",
            std::process::id(),
            name
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("vimrc")
    }

    /// Round-trip a managed save through real temp files with Unicode preserved.
    #[test]
    fn temp_fixture_round_trip() {
        let files = NativeVimSettingsFiles;
        let path = temp_config("roundtrip");
        let _ = std::fs::remove_file(&path);
        let written =
            write_raw_settings(&files, &path, None, "\" 日本語 🎉\nset number\n").unwrap();
        let read = read_settings(&files, &path).unwrap();
        assert_eq!(
            read.fingerprint.as_deref(),
            Some(written.fingerprint.as_str())
        );
        let managed = write_managed_settings(
            &files,
            &path,
            read.fingerprint.as_deref(),
            &default_settings(),
        )
        .unwrap();
        assert!(managed.raw.contains("\" 日本語 🎉"));
        assert!(managed.raw.contains("set number"));
        let _ = std::fs::remove_file(&path);
    }

    /// Surface a stale baseline from real temp files instead of overwriting.
    #[test]
    fn temp_fixture_stale_conflicts() {
        let files = NativeVimSettingsFiles;
        let path = temp_config("stale");
        let _ = std::fs::remove_file(&path);
        write_raw_settings(&files, &path, None, "set number\n").unwrap();
        let stale = write_managed_settings(&files, &path, None, &default_settings());
        assert!(matches!(stale, Err(WorkspaceError::Conflict { .. })));
        let _ = std::fs::remove_file(&path);
    }
}
