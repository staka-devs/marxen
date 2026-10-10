//! Ports consumed by document, workspace, and isolation use cases.
use crate::contracts::*;
use crate::domain::storage::{Fingerprint, RecoveryRecord};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfigSource {
    Isolated,
    UserFile(PathBuf),
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigReport {
    pub source: String,
    pub errors: Vec<String>,
}
impl ConfigReport {
    /// Report whether the explicitly selected configuration produced boot errors.
    pub fn has_errors(&self) -> bool {
        !self.errors.is_empty()
    }
}
#[derive(Debug)]
pub struct BufferError(pub String);
impl std::fmt::Display for BufferError {
    /// Preserve adapter diagnostics when a document operation returns an error.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for BufferError {}
pub enum BufferNotification {
    Yank(String),
    SaveRequested,
    Redraw(serde_json::Value),
}
pub type PositionedEdit = (u32, u32, u32, u32, String);
pub trait Buffer: Send {
    fn is_alive(&self) -> Result<bool, BufferError>;
    fn get_text(&self) -> Result<String, BufferError>;
    fn set_text(&self, text: &str) -> Result<(), BufferError>;
    fn set_buf_name(&self, name: &str) -> Result<(), BufferError>;
    fn input(&self, keys: &str) -> Result<usize, BufferError>;
    fn mode(&self) -> Result<VimMode, BufferError>;
    fn mode_state(&self) -> Result<(VimMode, bool), BufferError>;
    fn input_pending(&self) -> Result<bool, BufferError>;
    fn visual_selection(&self) -> Result<(u32, u32, u32, u32, bool, bool), BufferError>;
    fn win_cursor(&self) -> Result<(u64, u64), BufferError>;
    fn undo(&self) -> Result<(), BufferError>;
    fn redo(&self) -> Result<(), BufferError>;
    fn copy_keys(&self) -> Result<BTreeMap<String, String>, BufferError>;
    fn copy_config(&self) -> Result<(BTreeMap<String, String>, Vec<String>), BufferError>;
    fn same_key(&self, left: &str, right: &str) -> Result<bool, BufferError>;
    fn config_report(&self) -> &ConfigReport;
    fn has_mapping(&self, mode: &str, lhs: &str) -> Result<bool, BufferError>;
    fn apply_ranges(&self, edits: &[PositionedEdit]) -> Result<(), BufferError>;
    fn selection_exclusive(&self) -> Result<bool, BufferError>;
    fn virtualedit(&self) -> Result<String, BufferError>;
    fn restore_virtualedit(&self, original: &str) -> Result<(), BufferError>;
    fn install_selection(
        &self,
        anchor: (u32, u32),
        head: (u32, u32),
        linewise: bool,
    ) -> Result<(), BufferError>;
    fn exit_visual(&self) -> Result<(), BufferError>;
    fn set_cursor(&self, row: u32, col: u32) -> Result<(), BufferError>;
    fn resize_grid(&self, width: u32, height: u32) -> Result<(), BufferError>;
    fn clear_modified(&self) -> Result<(), BufferError>;
    fn install_save_intercept(&self) -> Result<(), BufferError>;
    #[cfg(feature = "dev-tools")]
    fn command_for_fixture(&self, command: &str) -> Result<(), BufferError>;
    fn drain_save_requests(&self) -> Vec<String>;
    fn drain_notifications(&self) -> Vec<BufferNotification>;
}
pub trait BufferFactory: Send + Sync {
    fn open(
        &self,
        config: ConfigSource,
        text: &str,
        path: Option<&Path>,
        clean: bool,
    ) -> Result<Box<dyn Buffer>, BufferError>;
}
#[derive(Clone)]
pub struct DocumentServices {
    pub storage: Arc<dyn DocumentStorage>,
    pub buffers: Arc<dyn BufferFactory>,
}
pub trait Clock: Send + Sync {
    fn nanos(&self) -> u128;
}
#[derive(Clone, Copy)]
pub struct FileInfo {
    pub directory: bool,
    pub regular: bool,
    pub link: bool,
}
impl FileInfo {
    /// Report whether metadata identifies a directory.
    pub fn is_dir(&self) -> bool {
        self.directory
    }
    /// Report whether metadata identifies a regular file.
    pub fn is_file(&self) -> bool {
        self.regular
    }
    /// Report whether the native entry is a link requiring rejection.
    pub fn is_symlink(&self) -> bool {
        self.link
    }
    /// Reuse metadata as the captured entry kind.
    pub fn file_type(&self) -> Self {
        *self
    }
}
pub struct DirectoryEntry {
    pub path: PathBuf,
    pub info: FileInfo,
}
impl DirectoryEntry {
    /// Return the enumerated native path without another filesystem read.
    pub fn path(&self) -> PathBuf {
        self.path.clone()
    }
    /// Return the enumerated leaf name without interpreting its encoding.
    pub fn file_name(&self) -> std::ffi::OsString {
        self.path.file_name().unwrap_or_default().to_owned()
    }
    /// Return the file kind captured by the native directory adapter.
    pub fn file_type(&self) -> Result<FileInfo, WorkspaceError> {
        Ok(self.info)
    }
}
pub trait FileReader: Send + Sync {
    fn read_disk(&self, path: &Path) -> Result<Option<Vec<u8>>, WorkspaceError>;
    fn disk_fingerprint(&self, path: &Path) -> Result<Option<Fingerprint>, WorkspaceError>;
}
pub trait DocumentStorage: FileReader {
    fn hard_link(&self, source: &Path, target: &Path) -> Result<(), WorkspaceError>;
    fn remove_file(&self, path: &Path) -> Result<(), WorkspaceError>;
    fn check_target(&self, root: Option<&Path>, path: &Path) -> Result<(), WorkspaceError>;
    fn atomic_write(
        &self,
        path: &Path,
        bytes: &[u8],
        expected: Option<&Fingerprint>,
        root: Option<&Path>,
    ) -> Result<Fingerprint, WorkspaceError>;
    fn checkpoint(&self, path: &Path, record: &RecoveryRecord) -> Result<(), WorkspaceError>;
    fn remove_checkpoint(&self, path: &Path) -> Result<(), WorkspaceError>;
}
pub trait DirectoryStorage: Send + Sync {
    fn canonicalize(&self, path: &Path) -> Result<PathBuf, WorkspaceError>;
    fn create_dir_all(&self, path: &Path) -> Result<(), WorkspaceError>;
    fn create_dir(&self, path: &Path) -> Result<(), WorkspaceError>;
    fn metadata(&self, path: &Path) -> Result<FileInfo, WorkspaceError>;
    /// Check whether a path exists without leaking filesystem access into use cases.
    fn exists(&self, path: &Path) -> bool;
}
pub trait WorkspaceStorage: DocumentStorage + DirectoryStorage {
    fn resolve(&self, root: &Path, relative: &str) -> Result<PathBuf, WorkspaceError>;
    fn read_image_bytes(&self, path: &Path) -> Result<Vec<u8>, WorkspaceError>;
    fn read_dir(&self, path: &Path) -> Result<Vec<DirectoryEntry>, WorkspaceError>;
}
pub trait StagingStorage: FileReader + DirectoryStorage {
    fn write_staging(&self, path: &Path, bytes: &[u8]) -> Result<(), WorkspaceError>;
    fn remove_staging(&self, path: &Path) -> Result<(), WorkspaceError>;
    fn guard_staging_path(&self, root: &Path, candidate: &Path) -> Result<PathBuf, WorkspaceError>;
    fn check_no_symlink(&self, path: &Path, root: &Path) -> Result<(), WorkspaceError>;
}
