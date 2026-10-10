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
/// Start row/byte column, exclusive end row/byte column and replacement text.
/// Rows are zero-based; columns are UTF-8 byte offsets, never UTF-16 offsets.
pub type PositionedEdit = (u32, u32, u32, u32, String);
/// Authoritative buffer operations used by the serialized document actor.
pub trait Buffer: Send {
    /// Determine whether the authoritative buffer process remains available.
    fn is_alive(&self) -> Result<bool, BufferError>;
    /// Read complete buffer text with LF separators and preserved final newline.
    fn get_text(&self) -> Result<String, BufferError>;
    /// Replace buffer contents during initialization or explicit reload.
    fn set_text(&self, text: &str) -> Result<(), BufferError>;
    /// Assign the native buffer path used by mappings and write interception.
    fn set_buf_name(&self, name: &str) -> Result<(), BufferError>;
    /// Feed Vim key notation and return the number of accepted input bytes.
    fn input(&self, keys: &str) -> Result<usize, BufferError>;
    /// Read the current native editing mode.
    fn mode(&self) -> Result<VimMode, BufferError>;
    /// Read native mode and whether Vim awaits an unfinished command.
    fn mode_state(&self) -> Result<(VimMode, bool), BufferError>;
    /// Report queued input before attempting a deferred buffer read.
    fn input_pending(&self) -> Result<bool, BufferError>;
    /// Return native anchor/head positions plus linewise and reversed flags.
    fn visual_selection(&self) -> Result<(u32, u32, u32, u32, bool, bool), BufferError>;
    /// Read the native one-based row and zero-based UTF-8 byte column.
    fn win_cursor(&self) -> Result<(u64, u64), BufferError>;
    /// Undo one change in the authoritative native history.
    fn undo(&self) -> Result<(), BufferError>;
    /// Redo one change in the authoritative native history.
    fn redo(&self) -> Result<(), BufferError>;
    /// Read validated post-yank copy-format key bindings.
    fn copy_keys(&self) -> Result<BTreeMap<String, String>, BufferError>;
    /// Read copy-format bindings together with configuration errors.
    fn copy_config(&self) -> Result<(BTreeMap<String, String>, Vec<String>), BufferError>;
    /// Compare key notation after native termcode normalization.
    fn same_key(&self, left: &str, right: &str) -> Result<bool, BufferError>;
    /// Return the selected configuration source and its boot diagnostics.
    fn config_report(&self) -> &ConfigReport;
    /// Determine whether the selected mode has a mapping for the supplied prefix.
    fn has_mapping(&self, mode: &str, lhs: &str) -> Result<bool, BufferError>;
    /// Apply validated row/byte edits as one native undo entry, from tail to head.
    fn apply_ranges(&self, edits: &[PositionedEdit]) -> Result<(), BufferError>;
    /// Read whether the native selection excludes its final character.
    fn selection_exclusive(&self) -> Result<bool, BufferError>;
    /// Capture native virtual cursor behavior before a GUI selection override.
    fn virtualedit(&self) -> Result<String, BufferError>;
    /// Restore the captured native virtual cursor configuration.
    fn restore_virtualedit(&self, original: &str) -> Result<(), BufferError>;
    /// Install zero-based GUI row/byte anchor and head as a native character or line selection.
    fn install_selection(
        &self,
        anchor: (u32, u32),
        head: (u32, u32),
        linewise: bool,
    ) -> Result<(), BufferError>;
    /// Leave the native Visual selection before changing the GUI cursor.
    fn exit_visual(&self) -> Result<(), BufferError>;
    /// Move the native cursor using a zero-based row and UTF-8 byte column.
    fn set_cursor(&self, row: u32, col: u32) -> Result<(), BufferError>;
    /// Resize the native grid to the requested cell dimensions.
    fn resize_grid(&self, width: u32, height: u32) -> Result<(), BufferError>;
    /// Clear the native modified flag after Rust successfully saves.
    fn clear_modified(&self) -> Result<(), BufferError>;
    /// Route native write requests to Rust without allowing Neovim to write files.
    fn install_save_intercept(&self) -> Result<(), BufferError>;
    #[cfg(feature = "dev-tools")]
    /// Execute a fixture-only Ex command when dev-tools is explicitly enabled.
    fn command_for_fixture(&self, command: &str) -> Result<(), BufferError>;
    /// Take pending intercepted save notifications in arrival order.
    fn drain_save_requests(&self) -> Vec<String>;
    /// Take native yank, save and redraw notifications in arrival order.
    fn drain_notifications(&self) -> Vec<BufferNotification>;
}
pub trait BufferFactory: Send + Sync {
    /// Create an authoritative buffer with the selected config and initial clean state.
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
    /// Supply a process-local timestamp for collision-resistant temporary identifiers.
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
/// File content and conflict baselines shared by document and staging use cases.
pub trait FileReader: Send + Sync {
    /// Read file bytes, distinguishing a missing file from an I/O error.
    fn read_disk(&self, path: &Path) -> Result<Option<Vec<u8>>, WorkspaceError>;
    /// Read the current content fingerprint, returning None for a missing file.
    fn disk_fingerprint(&self, path: &Path) -> Result<Option<Fingerprint>, WorkspaceError>;
}
/// Durable document saves, renames and recovery checkpoints.
pub trait DocumentStorage: FileReader {
    /// Create a non-overwriting hard link for rename or image import.
    fn hard_link(&self, source: &Path, target: &Path) -> Result<(), WorkspaceError>;
    /// Remove one guarded file after its replacement or rename succeeds.
    fn remove_file(&self, path: &Path) -> Result<(), WorkspaceError>;
    /// Reject unsafe save destinations and paths outside an optional workspace root.
    fn check_target(&self, root: Option<&Path>, path: &Path) -> Result<(), WorkspaceError>;
    /// Replace a file atomically only if its fingerprint matches the expected baseline.
    fn atomic_write(
        &self,
        path: &Path,
        bytes: &[u8],
        expected: Option<&Fingerprint>,
        root: Option<&Path>,
    ) -> Result<Fingerprint, WorkspaceError>;
    /// Persist a recoverable authoritative snapshot without writing the live document.
    fn checkpoint(&self, path: &Path, record: &RecoveryRecord) -> Result<(), WorkspaceError>;
    /// Remove the recovery record after save, discard or explicit dismissal.
    fn remove_checkpoint(&self, path: &Path) -> Result<(), WorkspaceError>;
}
/// Directory structure and path inspection shared by folder and staging use cases.
pub trait DirectoryStorage: Send + Sync {
    /// Resolve a native path to its absolute canonical target.
    fn canonicalize(&self, path: &Path) -> Result<PathBuf, WorkspaceError>;
    /// Create the required directory hierarchy, propagating native errors.
    fn create_dir_all(&self, path: &Path) -> Result<(), WorkspaceError>;
    /// Create one new directory without silently accepting an existing file.
    fn create_dir(&self, path: &Path) -> Result<(), WorkspaceError>;
    /// Inspect the entry itself, retaining link information for containment checks.
    fn metadata(&self, path: &Path) -> Result<FileInfo, WorkspaceError>;
    /// Check whether a path exists without leaking filesystem access into use cases.
    fn exists(&self, path: &Path) -> bool;
}
/// Folder browsing and image reads in addition to the document save contract.
pub trait WorkspaceStorage: DocumentStorage + DirectoryStorage {
    /// Resolve a workspace-relative path and reject escapes or external link targets.
    fn resolve(&self, root: &Path, relative: &str) -> Result<PathBuf, WorkspaceError>;
    /// Read supported image bytes within the product size limit.
    fn read_image_bytes(&self, path: &Path) -> Result<Vec<u8>, WorkspaceError>;
    /// Enumerate direct children with their captured file kinds.
    fn read_dir(&self, path: &Path) -> Result<Vec<DirectoryEntry>, WorkspaceError>;
}
/// Guarded isolated copy access without live document save capabilities.
pub trait StagingStorage: FileReader + DirectoryStorage {
    /// Write proposal bytes exclusively to an already guarded staging path.
    fn write_staging(&self, path: &Path, bytes: &[u8]) -> Result<(), WorkspaceError>;
    /// Remove a completed or rejected copy inside the managed staging root.
    fn remove_staging(&self, path: &Path) -> Result<(), WorkspaceError>;
    /// Resolve a staging-relative path while rejecting traversal and link escapes.
    fn guard_staging_path(&self, root: &Path, candidate: &Path) -> Result<PathBuf, WorkspaceError>;
    /// Reject links in a path between the candidate and its staging root.
    fn check_no_symlink(&self, path: &Path, root: &Path) -> Result<(), WorkspaceError>;
}
