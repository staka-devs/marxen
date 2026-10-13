//! Folder-scoped document registry. Every edit/save uses the owned Neovim actor.
use crate::contracts::*;
use crate::document::DocumentActor;
use crate::storage::{self, Fingerprint, RecoveryRecord};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub struct Workspace {
    root: PathBuf,
    recovery: PathBuf,
    actors: BTreeMap<String, DocumentActor>,
    observed: BTreeMap<String, Option<Fingerprint>>,
    errors: BTreeMap<String, WorkspaceError>,
}

impl Workspace {
    pub fn has_live_documents(&self) -> bool {
        self.actors
            .values()
            .any(|actor| actor.is_alive().unwrap_or(false))
    }

    pub fn open(root: &Path, recovery_home: &Path) -> Result<Self, WorkspaceError> {
        let root = fs::canonicalize(root)?;
        if !root.is_dir() {
            return Err(WorkspaceError::InvalidPath);
        }
        let namespace = storage::fingerprint(root.to_string_lossy().as_bytes()).0;
        let recovery = recovery_home.join(namespace);
        fs::create_dir_all(&recovery)?;
        if fs::symlink_metadata(&recovery)?.file_type().is_symlink() {
            return Err(WorkspaceError::OutsideWorkspace);
        }
        Ok(Self {
            root,
            recovery,
            actors: BTreeMap::new(),
            observed: BTreeMap::new(),
            errors: BTreeMap::new(),
        })
    }

    pub fn info(&self) -> WorkspaceInfo {
        WorkspaceInfo {
            root: self.root.display().to_string(),
        }
    }
    pub fn root(&self) -> &Path {
        &self.root
    }
    pub fn is_empty(&self) -> bool {
        self.actors.is_empty()
    }
    pub fn actor(&self, id: &str) -> Result<&DocumentActor, WorkspaceError> {
        self.actors.get(id).ok_or(WorkspaceError::UnknownDocument)
    }
    fn record_path(&self, id: &str) -> PathBuf {
        self.recovery
            .join(format!("{}.json", storage::fingerprint(id.as_bytes()).0))
    }
    fn new_id(&self) -> String {
        format!(
            "doc-{}-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos(),
            self.actors.len()
        )
    }
    fn description(&self, actor: &DocumentActor) -> Result<OpenDocument, WorkspaceError> {
        Ok(OpenDocument {
            path: actor
                .path()
                .as_ref()
                .map(|p| storage::relative(&self.root, p))
                .transpose()?,
            snapshot: actor.snapshot(),
        })
    }

    pub fn documents(&self) -> Result<Vec<OpenDocument>, WorkspaceError> {
        self.actors
            .values()
            .map(|actor| self.description(actor))
            .collect()
    }

    pub fn list(&self, path: &str) -> Result<Vec<WorkspaceEntry>, WorkspaceError> {
        let folder = storage::resolve(&self.root, path)?;
        if !folder.is_dir() {
            return Err(WorkspaceError::InvalidPath);
        }
        let mut entries = Vec::new();
        for entry in fs::read_dir(folder)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with(".marxen-") || name == ".git" {
                continue;
            }
            let meta = entry.file_type()?;
            if meta.is_symlink() {
                continue;
            }
            let relative = storage::relative(&self.root, &entry.path())?;
            // Junctions/reparse points must also remain contained.
            if storage::resolve(&self.root, &relative).is_err() {
                continue;
            }
            let kind = if meta.is_dir() {
                None
            } else if meta.is_file() && storage::image_family(&entry.path()) {
                if self.load_workspace_image(&relative).is_err() {
                    continue;
                }
                Some(WorkspaceFileKind::Image)
            } else if meta.is_file() && storage::text_family(&entry.path()) {
                if storage::read_disk(&entry.path())?
                    .and_then(|b| storage::utf8_text(b).ok())
                    .is_none()
                {
                    continue;
                }
                Some(if storage::markdown(&entry.path()) {
                    WorkspaceFileKind::Markdown
                } else {
                    WorkspaceFileKind::Text
                })
            } else {
                continue;
            };
            entries.push(WorkspaceEntry {
                path: relative,
                name,
                directory: meta.is_dir(),
                markdown: meta.is_file() && storage::markdown(&entry.path()),
                kind,
            });
        }
        entries.sort_by(|a, b| b.directory.cmp(&a.directory).then(a.name.cmp(&b.name)));
        Ok(entries)
    }

    pub fn open_markdown(&mut self, path: &str) -> Result<OpenDocument, WorkspaceError> {
        let target = storage::resolve(&self.root, path)?;
        if !storage::markdown(&target) {
            return Err(WorkspaceError::NotMarkdown);
        }
        self.open_text_file(path)
    }

    pub fn open_text_file(&mut self, path: &str) -> Result<OpenDocument, WorkspaceError> {
        let target = storage::resolve(&self.root, path)?;
        if !storage::text_family(&target) {
            return Err(WorkspaceError::NotText);
        }
        if let Some(actor) = self
            .actors
            .values()
            .find(|actor| actor.path().as_ref() == Some(&target))
        {
            return self.description(actor);
        }
        let bytes = storage::read_disk(&target)?.ok_or(WorkspaceError::NotFound)?;
        let baseline = storage::fingerprint(&bytes);
        let text = storage::utf8_text(bytes)?;
        let id = self.new_id();
        let actor = DocumentActor::open(DocumentId(id.clone()), text, Some(target))?;
        // Catch external mutation between disk read and actor creation.
        if actor.baseline() != Some(baseline) {
            return Err(WorkspaceError::Conflict { path: path.into() });
        }
        actor.attach_storage(self.root.clone(), self.record_path(&id))?;
        let result = self.description(&actor)?;
        self.observed.insert(id.clone(), actor.baseline());
        self.actors.insert(id, actor);
        Ok(result)
    }

    pub fn open_untitled(
        &mut self,
        id: DocumentId,
        text: String,
    ) -> Result<OpenDocument, WorkspaceError> {
        if self.actors.contains_key(&id.0) {
            return Err(WorkspaceError::AlreadyExists);
        }
        let actor = DocumentActor::open(id.clone(), text, None)?;
        actor.attach_storage(self.root.clone(), self.record_path(&id.0))?;
        // Untitled initial content is unsaved and must be recoverable.
        actor.mark_unsaved()?;
        let result = self.description(&actor)?;
        self.actors.insert(id.0, actor);
        Ok(result)
    }

    pub fn create(&mut self, path: &str, text: &str) -> Result<OpenDocument, WorkspaceError> {
        let target = storage::resolve(&self.root, path)?;
        if !storage::markdown(&target) {
            return Err(WorkspaceError::NotMarkdown);
        }
        if storage::read_disk(&target)?.is_some() {
            return Err(WorkspaceError::AlreadyExists);
        }
        storage::atomic_write(&target, text.as_bytes(), None, Some(&self.root))?;
        self.open_markdown(path)
    }

    pub fn rename(
        &mut self,
        request: SaveRequest,
        path: &str,
    ) -> Result<OpenDocument, WorkspaceError> {
        let target = storage::resolve(&self.root, path)?;
        if !storage::markdown(&target) {
            return Err(WorkspaceError::NotMarkdown);
        }
        let actor = self.actor(&request.document_id.0)?;
        actor.rename(request, target)?;
        self.description(actor)
    }

    pub fn close(
        &mut self,
        request: SaveRequest,
        action: CloseAction,
    ) -> Result<bool, WorkspaceError> {
        let id = request.document_id.0.clone();
        let actor = self.actor(&id)?;
        let snapshot = actor.sync_from_nvim().unwrap_or_else(|_| actor.snapshot());
        crate::validation::validate_save(&snapshot, &request)
            .map_err(|error| WorkspaceError::Contract { error })?;
        if action == CloseAction::Cancel {
            return Ok(false);
        }
        if snapshot.dirty && action == CloseAction::Save {
            actor.save(request)?;
        }
        actor.discard_recovery()?;
        self.actors.remove(&id);
        self.observed.remove(&id);
        self.errors.remove(&id);
        Ok(true)
    }

    /// Explicitly refuses workspace switches while any document has unsaved text.
    pub fn ensure_clean(&self) -> Result<(), WorkspaceError> {
        for actor in self.actors.values() {
            let snapshot = actor.sync_from_nvim().unwrap_or_else(|_| actor.snapshot());
            if snapshot.dirty {
                return Err(WorkspaceError::UnsavedChanges { snapshot });
            }
        }
        Ok(())
    }

    pub fn search(&self, query: &str) -> Result<Vec<SearchMatch>, WorkspaceError> {
        if query.is_empty() {
            return Err(WorkspaceError::InvalidPath);
        }
        let mut pending = vec![String::new()];
        let mut files = Vec::new();
        while let Some(folder) = pending.pop() {
            for entry in self.list(&folder)? {
                if entry.directory {
                    pending.push(entry.path);
                } else if matches!(
                    entry.kind,
                    Some(WorkspaceFileKind::Markdown | WorkspaceFileKind::Text)
                ) {
                    files.push(entry.path);
                }
            }
        }
        files.sort();
        let mut matches = Vec::new();
        for path in files {
            let target = storage::resolve(&self.root, &path)?;
            let actor = self
                .actors
                .values()
                .find(|a| a.path().as_ref() == Some(&target));
            let (text, id, revision) = if let Some(actor) = actor {
                let snapshot = actor.sync_from_nvim()?;
                (
                    snapshot.text,
                    Some(snapshot.document_id),
                    Some(snapshot.revision),
                )
            } else {
                let bytes = storage::read_disk(&target)?.ok_or(WorkspaceError::NotFound)?;
                let text = String::from_utf8(bytes).map_err(|_| WorkspaceError::InvalidUtf8)?;
                (text, None, None)
            };
            for (byte, _) in text.match_indices(query) {
                let start = crate::validation::utf8_to_utf16(&text, Utf8ByteOffset(byte as u32))
                    .map_err(|error| WorkspaceError::Contract { error })?;
                let end = crate::validation::utf8_to_utf16(
                    &text,
                    Utf8ByteOffset((byte + query.len()) as u32),
                )
                .map_err(|error| WorkspaceError::Contract { error })?;
                let line_start = text[..byte].rfind('\n').map_or(0, |n| n + 1);
                let line_end = text[byte..].find('\n').map_or(text.len(), |n| byte + n);
                matches.push(SearchMatch {
                    path: path.clone(),
                    document_id: id.clone(),
                    revision,
                    range: Utf16Range { start, end },
                    line: text[..byte].bytes().filter(|b| *b == b'\n').count() as u32 + 1,
                    preview: text[line_start..line_end].into(),
                });
            }
        }
        Ok(matches)
    }

    /// Polling emits changed fingerprints once; neither dirty nor clean buffers
    /// are silently overwritten. Frontend may explicitly reload a clean buffer.
    pub fn poll(&mut self) -> Vec<WorkspaceEvent> {
        let mut events = Vec::new();
        for (id, actor) in &self.actors {
            let before = actor.snapshot();
            match actor.sync_from_nvim().map_err(WorkspaceError::from) {
                Ok(snapshot) => {
                    self.errors.remove(id);
                    if snapshot != before {
                        events.push(WorkspaceEvent::Snapshot(snapshot));
                    }
                    events.extend(actor.take_saved().into_iter().map(WorkspaceEvent::Saved));
                }
                Err(error) => {
                    if self.errors.get(id) != Some(&error) {
                        events.push(WorkspaceEvent::Error {
                            document_id: DocumentId(id.clone()),
                            error: error.clone(),
                        });
                    }
                    self.errors.insert(id.clone(), error);
                }
            }
            if let Some(path) = actor.path() {
                let current = storage::check_target(Some(&self.root), &path)
                    .and_then(|_| storage::disk_fingerprint(&path));
                match current {
                    Ok(current) => {
                        // Own Rust saves are acknowledged before disk observation.
                        if current == actor.baseline() {
                            self.observed.insert(id.clone(), current);
                        } else if self.observed.get(id) != Some(&current) {
                            events.push(WorkspaceEvent::ExternalChange {
                                document_id: DocumentId(id.clone()),
                                path: storage::relative(&self.root, &path).unwrap_or_default(),
                                dirty: actor.snapshot().dirty,
                                deleted: current.is_none(),
                            });
                            self.observed.insert(id.clone(), current);
                        }
                    }
                    Err(error) => events.push(WorkspaceEvent::Error {
                        document_id: DocumentId(id.clone()),
                        error,
                    }),
                }
            }
        }
        events
    }

    fn records(&self) -> Result<Vec<RecoveryRecord>, WorkspaceError> {
        let mut records = Vec::new();
        for entry in fs::read_dir(&self.recovery)? {
            let entry = entry?;
            if entry.path().extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let bytes = storage::read_disk(&entry.path())?.ok_or(WorkspaceError::NotFound)?;
            let record: RecoveryRecord =
                serde_json::from_slice(&bytes).map_err(|e| WorkspaceError::Io {
                    detail: format!("invalid recovery {}: {e}", entry.path().display()),
                })?;
            if record.version != 1 || record.root != self.root || !record.snapshot.dirty {
                return Err(WorkspaceError::InvalidPath);
            }
            crate::validation::validate_document_id(&record.snapshot.document_id)
                .map_err(|error| WorkspaceError::Contract { error })?;
            if entry.path() != self.record_path(&record.snapshot.document_id.0) {
                return Err(WorkspaceError::InvalidPath);
            }
            if let Some(path) = &record.path {
                let path = storage::resolve(&self.root, path)?;
                if !storage::text_family(&path) {
                    return Err(WorkspaceError::NotText);
                }
            }
            records.push(record);
        }
        Ok(records)
    }

    pub fn recovery_entries(&self) -> Result<Vec<RecoveryEntry>, WorkspaceError> {
        self.records()?
            .into_iter()
            .map(|r| {
                let current = r
                    .path
                    .as_ref()
                    .map(|p| {
                        storage::resolve(&self.root, p).and_then(|p| storage::disk_fingerprint(&p))
                    })
                    .transpose()?
                    .flatten();
                Ok(RecoveryEntry {
                    document_id: r.snapshot.document_id,
                    path: r.path,
                    revision: r.snapshot.revision,
                    conflict: current != r.baseline,
                })
            })
            .collect()
    }

    pub fn restore(&mut self, id: &str) -> Result<OpenDocument, WorkspaceError> {
        if self.actors.contains_key(id) {
            return Err(WorkspaceError::AlreadyExists);
        }
        let record = self
            .records()?
            .into_iter()
            .find(|r| r.snapshot.document_id.0 == id)
            .ok_or(WorkspaceError::NotFound)?;
        let path = record
            .path
            .as_ref()
            .map(|p| storage::resolve(&self.root, p))
            .transpose()?;
        if self
            .actors
            .values()
            .any(|a| path.is_some() && a.path() == path)
        {
            return Err(WorkspaceError::AlreadyExists);
        }
        let actor = DocumentActor::open(
            record.snapshot.document_id.clone(),
            record.snapshot.text.clone(),
            path,
        )?;
        actor.attach_storage(self.root.clone(), self.record_path(id))?;
        actor.restore_record(&record)?;
        let result = self.description(&actor)?;
        self.observed.insert(id.into(), actor.baseline());
        self.actors.insert(id.into(), actor);
        Ok(result)
    }

    pub fn discard_recovery(&self, id: &str) -> Result<(), WorkspaceError> {
        if self.actors.contains_key(id) {
            return Err(WorkspaceError::AlreadyExists);
        }
        storage::remove_checkpoint(&self.record_path(id))
    }

    pub fn load_image(&self, id: &str, relative: &str) -> Result<ImageData, WorkspaceError> {
        let document = self.actor(id)?.path().ok_or(WorkspaceError::InvalidPath)?;
        let decoded = decode_image_path(relative)?;
        let relative = decoded.as_str();
        // Relative image references may use ../ provided the final path is contained.
        if relative.contains(['\\', ':', '\0']) || Path::new(relative).is_absolute() {
            return Err(WorkspaceError::InvalidPath);
        }
        let mut parts = document
            .parent()
            .ok_or(WorkspaceError::InvalidPath)?
            .strip_prefix(&self.root)
            .map_err(|_| WorkspaceError::OutsideWorkspace)?
            .components()
            .map(|p| p.as_os_str().to_string_lossy().to_string())
            .collect::<Vec<_>>();
        for part in Path::new(relative).components() {
            match part {
                std::path::Component::Normal(s) => parts.push(s.to_string_lossy().to_string()),
                std::path::Component::ParentDir => {
                    if parts.pop().is_none() {
                        return Err(WorkspaceError::OutsideWorkspace);
                    }
                }
                std::path::Component::CurDir => {}
                _ => return Err(WorkspaceError::InvalidPath),
            }
        }
        let target = storage::resolve(&self.root, &parts.join("/"))?;
        let bytes = storage::read_image_bytes(&target)?;
        let mime = image_mime(&target, &bytes)?;
        Ok(ImageData {
            mime: mime.into(),
            bytes,
        })
    }

    pub fn load_workspace_image(&self, path: &str) -> Result<ImageData, WorkspaceError> {
        let target = storage::resolve(&self.root, path)?;
        let bytes = storage::read_image_bytes(&target)?;
        Ok(ImageData {
            mime: image_mime(&target, &bytes)?.into(),
            bytes,
        })
    }

    pub fn insert_workspace_image(
        &self,
        request: SaveRequest,
        path: &str,
        range: Utf16Range,
    ) -> Result<DocumentSnapshot, WorkspaceError> {
        self.load_workspace_image(path)?;
        let actor = self.actor(&request.document_id.0)?;
        let document = actor.path().ok_or(WorkspaceError::InvalidPath)?;
        if !storage::markdown(&document) {
            return Err(WorkspaceError::NotMarkdown);
        }
        let parent = storage::relative(
            &self.root,
            document.parent().ok_or(WorkspaceError::InvalidPath)?,
        )?;
        let from: Vec<_> = parent.split('/').filter(|s| !s.is_empty()).collect();
        let to: Vec<_> = path.split('/').collect();
        let common = from.iter().zip(&to).take_while(|(a, b)| a == b).count();
        let mut parts = vec!["..".to_owned(); from.len() - common];
        parts.extend(to[common..].iter().map(|p| encode_image_name(p)));
        Ok(actor.apply_edits(EditRequest {
            document_id: request.document_id,
            base_revision: request.base_revision,
            source: EditSource::Gui,
            edits: vec![TextEdit {
                range,
                text: format!("![]({})", parts.join("/")),
            }],
        })?)
    }

    pub fn import_external_image(
        &self,
        request: SaveRequest,
        path: &Path,
        range: Utf16Range,
    ) -> Result<PasteResult, WorkspaceError> {
        if !path.is_absolute() {
            return Err(WorkspaceError::InvalidPath);
        }
        let bytes = storage::read_image_bytes(path)?;
        image_mime(path, &bytes)?;
        let name = path
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or(WorkspaceError::InvalidPath)?;
        self.paste_image(request, name, &bytes, range)
    }

    pub fn paste_image(
        &self,
        request: SaveRequest,
        name: &str,
        bytes: &[u8],
        range: Utf16Range,
    ) -> Result<PasteResult, WorkspaceError> {
        if name.contains(['/', '\\']) || bytes.len() > storage::MAX_IMAGE_BYTES {
            return Err(WorkspaceError::InvalidImage);
        }
        let actor = self.actor(&request.document_id.0)?;
        let snapshot = actor.sync_from_nvim()?;
        let document = actor.path().ok_or(WorkspaceError::InvalidPath)?;
        if !storage::markdown(&document) {
            return Err(WorkspaceError::NotMarkdown);
        }
        image_mime(Path::new(name), bytes)?;
        crate::validation::validate_edit(
            &snapshot,
            &EditRequest {
                document_id: request.document_id.clone(),
                base_revision: request.base_revision,
                source: EditSource::Gui,
                edits: vec![TextEdit {
                    range: range.clone(),
                    text: String::new(),
                }],
            },
        )
        .map_err(|error| WorkspaceError::Contract { error })?;
        let parent = document.parent().ok_or(WorkspaceError::InvalidPath)?;
        let folder = parent.join("images");
        let relative_folder = storage::relative(&self.root, &folder)?;
        storage::resolve(&self.root, &relative_folder)?;
        if !folder.exists() {
            fs::create_dir(&folder)?;
        }
        let path = format!("{relative_folder}/{name}");
        let target = storage::resolve(&self.root, &path)?;
        image_mime(&target, bytes)?;
        let encoded = encode_image_name(name);
        let edits = EditRequest {
            document_id: request.document_id,
            base_revision: request.base_revision,
            source: EditSource::Gui,
            edits: vec![TextEdit {
                range,
                text: format!("![](images/{encoded})"),
            }],
        };
        crate::validation::validate_edit(&snapshot, &edits)
            .map_err(|error| WorkspaceError::Contract { error })?;
        if storage::read_disk(&target)?.is_some() {
            return Err(WorkspaceError::AlreadyExists);
        }
        storage::atomic_write(&target, bytes, None, Some(&self.root))?;
        // IPC holds the workspace mutex, so no other GUI edit can interleave.
        match actor.apply_edits(edits) {
            Ok(snapshot) => Ok(PasteResult { path, snapshot }),
            Err(error) => Err(error.into()),
        }
    }
}

fn encode_image_name(name: &str) -> String {
    name.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.') {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

fn image_mime(path: &Path, bytes: &[u8]) -> Result<&'static str, WorkspaceError> {
    let extension = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    match extension.as_str() {
        "png" if bytes.starts_with(b"\x89PNG\r\n\x1a\n") => Ok("image/png"),
        "jpg" | "jpeg" if bytes.starts_with(b"\xff\xd8\xff") => Ok("image/jpeg"),
        "gif" if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") => Ok("image/gif"),
        "webp" if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") => {
            Ok("image/webp")
        }
        _ => Err(WorkspaceError::InvalidImage),
    }
}

fn decode_image_path(path: &str) -> Result<String, WorkspaceError> {
    let mut decoded = Vec::with_capacity(path.len());
    let bytes = path.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let pair = bytes
                .get(index + 1..index + 3)
                .ok_or(WorkspaceError::InvalidPath)?;
            let hex = std::str::from_utf8(pair).map_err(|_| WorkspaceError::InvalidPath)?;
            decoded.push(u8::from_str_radix(hex, 16).map_err(|_| WorkspaceError::InvalidPath)?);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).map_err(|_| WorkspaceError::InvalidPath)
}
