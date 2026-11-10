//! Export a bundle folder to a `.marxenpack` file and import one back as real files.

use super::Workspace;
use crate::contracts::WorkspaceError;
use crate::domain::bundle_pack::{
    is_bundle, read_pack, write_pack, BUNDLE_SUFFIX, MAX_PACK_BYTES, MAX_PACK_FILES, PACK_EXTENSION,
};
use crate::domain::storage;
use std::path::Path;

/// Require an absolute path with the pack extension.
fn pack_path(path: &Path) -> Result<(), WorkspaceError> {
    let extension = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default();
    match path.is_absolute() && extension.eq_ignore_ascii_case(PACK_EXTENSION) {
        true => Ok(()),
        false => Err(WorkspaceError::InvalidPath),
    }
}

impl Workspace {
    /// Create a root-relative folder one level at a time, containing each level before it exists.
    fn ensure_folder(&self, relative: &str) -> Result<(), WorkspaceError> {
        let mut current = String::new();
        for segment in relative.split('/').filter(|s| !s.is_empty()) {
            current = match current.is_empty() {
                true => segment.to_owned(),
                false => format!("{current}/{segment}"),
            };
            let path = self.storage.resolve(&self.root, &current)?;
            if !self.storage.exists(&path) {
                self.storage.create_dir(&path)?;
            }
        }
        Ok(())
    }

    /// Pack the saved files of one bundle folder into `destination`.
    ///
    /// Open documents inside the bundle must be saved first, so the pack never
    /// silently differs from what the editor shows.
    pub fn export_bundle(&self, bundle: &str, destination: &Path) -> Result<(), WorkspaceError> {
        pack_path(destination)?;
        if !is_bundle(bundle) {
            return Err(WorkspaceError::InvalidPath);
        }
        let folder = self.storage.resolve(&self.root, bundle)?;
        if let Some(actor) = self.actors.values().find(|actor| {
            actor.path().is_some_and(|p| p.starts_with(&folder)) && actor.snapshot().dirty
        }) {
            return Err(WorkspaceError::UnsavedChanges {
                snapshot: Box::new(actor.snapshot()),
            });
        }
        let name = bundle.rsplit('/').next().unwrap_or(bundle);
        let mut files = Vec::new();
        let mut pending = vec![(folder, name.to_owned())];
        let mut total = 0;
        while let Some((directory, prefix)) = pending.pop() {
            for entry in self.storage.read_dir(&directory)? {
                let info = entry.file_type()?;
                let member = format!("{prefix}/{}", entry.file_name().to_string_lossy());
                // Links and anything outside the root are left out rather than followed.
                let relative = storage::relative(&self.root, &entry.path())?;
                if info.is_symlink() || self.storage.resolve(&self.root, &relative).is_err() {
                    continue;
                }
                if info.is_dir() {
                    pending.push((entry.path(), member));
                } else if info.is_file() {
                    let bytes = self
                        .storage
                        .read_disk(&entry.path())?
                        .ok_or(WorkspaceError::NotFound)?;
                    total += bytes.len();
                    if total > MAX_PACK_BYTES || files.len() >= MAX_PACK_FILES {
                        return Err(WorkspaceError::InvalidPath);
                    }
                    files.push((member, bytes));
                }
            }
        }
        files.sort_by(|a, b| a.0.cmp(&b.0));
        // The OS save dialog already confirmed replacing an existing pack.
        let existing = self.storage.disk_fingerprint(destination)?;
        self.storage
            .atomic_write(destination, &write_pack(&files)?, existing.as_ref(), None)?;
        Ok(())
    }

    /// Unpack a `.marxenpack` into `folder` as a new bundle and return its `index.md` path.
    ///
    /// Every member must sit under one `name.marxen/` folder; an existing
    /// bundle of that name is never overwritten, the copy gets `-1`, `-2`, ...
    pub fn import_bundle(&self, source: &Path, folder: &str) -> Result<String, WorkspaceError> {
        pack_path(source)?;
        // shortcut: the whole pack is read before its size is checked; stream it if packs grow large.
        let bytes = self
            .storage
            .read_disk(source)?
            .ok_or(WorkspaceError::NotFound)?;
        let files = read_pack(&bytes)?;
        let top = files
            .first()
            .and_then(|(name, _)| name.split('/').next())
            .ok_or(WorkspaceError::InvalidPath)?
            .to_owned();
        if !is_bundle(&top)
            || !files
                .iter()
                .any(|(name, _)| *name == format!("{top}/index.md"))
            || files
                .iter()
                .any(|(name, _)| !name.starts_with(&format!("{top}/")))
        {
            return Err(WorkspaceError::InvalidPath);
        }
        let stem = &top[..top.len() - BUNDLE_SUFFIX.len()];
        let prefix = match folder.trim_matches('/') {
            "" => String::new(),
            folder => format!("{folder}/"),
        };
        self.ensure_folder(folder.trim_matches('/'))?;
        let target = (0..1000)
            .map(|n| match n {
                0 => format!("{prefix}{top}"),
                n => format!("{prefix}{stem}-{n}{BUNDLE_SUFFIX}"),
            })
            .find(|candidate| {
                self.storage
                    .resolve(&self.root, candidate)
                    .is_ok_and(|path| !self.storage.exists(&path))
            })
            .ok_or(WorkspaceError::AlreadyExists)?;
        for (name, data) in &files {
            let relative = format!("{target}{}", &name[top.len()..]);
            if let Some((parent, _)) = relative.rsplit_once('/') {
                self.ensure_folder(parent)?;
            }
            let path = self.storage.resolve(&self.root, &relative)?;
            if self.storage.exists(&path) {
                return Err(WorkspaceError::AlreadyExists);
            }
            self.storage
                .atomic_write(&path, data, None, Some(&self.root))?;
        }
        Ok(format!("{target}/index.md"))
    }
}
