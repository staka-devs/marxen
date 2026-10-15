//! Folder-scoped document registry. Every edit/save uses the owned Neovim actor.
use crate::application::document::DocumentActor;
use crate::contracts::*;
use crate::domain::storage::{self, Fingerprint, RecoveryRecord};
use std::collections::BTreeMap;

use crate::application::ports::*;
use std::path::{Path, PathBuf};
use std::sync::Arc;

static NEXT_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

pub struct Workspace {
    storage: Arc<dyn WorkspaceStorage>,
    services: DocumentServices,
    clock: Arc<dyn Clock>,
    root: PathBuf,
    scope: RootScope,
    next_document: u64,
    recovery: PathBuf,
    actors: BTreeMap<String, DocumentActor>,
    observed: BTreeMap<String, Option<Fingerprint>>,
    errors: BTreeMap<String, WorkspaceError>,
}

impl Workspace {
    /// Report whether any registered authoritative buffer process remains alive.
    pub fn has_live_documents(&self) -> bool {
        self.actors
            .values()
            .any(|actor| actor.is_alive().unwrap_or(false))
    }

    /// Validate a folder root and create a separate recovery namespace with injected services.
    pub fn open(
        root: &Path,
        recovery_home: &Path,
        services: DocumentServices,
        storage: Arc<dyn WorkspaceStorage>,
        clock: Arc<dyn Clock>,
    ) -> Result<Self, WorkspaceError> {
        let root = storage.canonicalize(root)?;
        if !storage.metadata(&root).is_ok_and(|m| m.directory) {
            return Err(WorkspaceError::InvalidPath);
        }
        let namespace =
            storage::fingerprint(root.to_str().ok_or(WorkspaceError::InvalidPath)?.as_bytes()).0;
        let scope = RootScope {
            root_id: RootId(format!("root-{namespace}")),
            generation: format!(
                "{}-{}",
                clock.nanos(),
                NEXT_GENERATION.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            ),
        };
        let recovery = recovery_home.join(namespace);
        storage.create_dir_all(&recovery)?;
        if storage.metadata(&recovery)?.file_type().is_symlink() {
            return Err(WorkspaceError::OutsideWorkspace);
        }
        Ok(Self {
            storage,
            services,
            clock,
            root,
            scope,
            next_document: 0,
            recovery,
            actors: BTreeMap::new(),
            observed: BTreeMap::new(),
            errors: BTreeMap::new(),
        })
    }

    /// Return workspace identity and open document descriptors.
    pub fn info(&self) -> WorkspaceInfo {
        WorkspaceInfo {
            scope: self.scope.clone(),
            root: self.root.display().to_string(),
        }
    }
    /// Borrow the canonical workspace root used for path containment checks.
    pub fn root(&self) -> &Path {
        &self.root
    }
    /// Borrow the Rust-issued owner incarnation used by registry and staging checks.
    pub fn scope(&self) -> &RootScope {
        &self.scope
    }

    /// Reject mismatched owner, incarnation, or renamed document position.
    pub fn validate_location(
        &self,
        id: &str,
        location: &DocumentLocation,
    ) -> Result<(), WorkspaceError> {
        if location.scope.root_id != self.scope.root_id {
            return Err(WorkspaceError::WrongOwner);
        }
        if location.scope != self.scope {
            return Err(WorkspaceError::StaleRoot);
        }
        if self.actor(id)?.snapshot().location.as_ref() != Some(location) {
            return Err(WorkspaceError::StaleLocation);
        }
        Ok(())
    }
    /// Report whether the workspace has any registered documents.
    pub fn is_empty(&self) -> bool {
        self.actors.is_empty()
    }
    /// Look up the authoritative actor by stable document ID.
    pub fn actor(&self, id: &str) -> Result<&DocumentActor, WorkspaceError> {
        self.actors.get(id).ok_or(WorkspaceError::UnknownDocument)
    }
    /// Derive a recovery filename from the stable document ID.
    fn record_path(&self, id: &str) -> PathBuf {
        self.recovery
            .join(format!("{}.json", storage::fingerprint(id.as_bytes()).0))
    }
    /// Allocate a process-local document identifier using the injected clock.
    pub fn new_id(&mut self) -> String {
        loop {
            self.next_document += 1;
            let id = format!(
                "doc-{}-{}-{}",
                &self.scope.root_id.0[5..],
                self.scope.generation,
                self.next_document
            );
            if !self.actors.contains_key(&id) && !self.storage.exists(&self.record_path(&id)) {
                return id;
            }
        }
    }
    /// Build a document descriptor from its current authoritative snapshot and relative path.
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

    /// List registered document descriptors in stable identifier order.
    pub fn documents(&self) -> Result<Vec<OpenDocument>, WorkspaceError> {
        self.actors
            .values()
            .map(|actor| self.description(actor))
            .collect()
    }

    /// Enumerate supported text, image and directory entries while rejecting links and unsafe paths.
    pub fn list(&self, path: &str) -> Result<Vec<WorkspaceEntry>, WorkspaceError> {
        let folder = self.storage.resolve(&self.root, path)?;
        if !self.storage.metadata(&folder).is_ok_and(|m| m.directory) {
            return Err(WorkspaceError::InvalidPath);
        }
        let mut entries = Vec::new();
        for entry in self.storage.read_dir(&folder)? {
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
            if self.storage.resolve(&self.root, &relative).is_err() {
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
                if self
                    .storage
                    .read_disk(&entry.path())?
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

    /// Open a contained Markdown file in a real authoritative buffer.
    pub fn open_markdown(&mut self, path: &str) -> Result<OpenDocument, WorkspaceError> {
        let target = self.storage.resolve(&self.root, path)?;
        if !storage::markdown(&target) {
            return Err(WorkspaceError::NotMarkdown);
        }
        self.open_text_file(path)
    }

    /// Open a contained supported UTF-8 text file with the same revision contract.
    pub fn open_text_file(&mut self, path: &str) -> Result<OpenDocument, WorkspaceError> {
        let target = self.storage.resolve(&self.root, path)?;
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
        let bytes = self
            .storage
            .read_disk(&target)?
            .ok_or(WorkspaceError::NotFound)?;
        let baseline = storage::fingerprint(&bytes);
        let text = storage::utf8_text(bytes)?;
        let id = self.new_id();
        let actor = DocumentActor::open(
            DocumentId(id.clone()),
            text,
            Some(target),
            self.services.clone(),
        )?;
        // Catch external mutation between disk read and actor creation.
        if actor.baseline() != Some(baseline) {
            return Err(WorkspaceError::Conflict { path: path.into() });
        }
        actor.attach_storage(self.root.clone(), self.record_path(&id), self.scope.clone())?;
        let result = self.description(&actor)?;
        self.observed.insert(id.clone(), actor.baseline());
        self.actors.insert(id, actor);
        Ok(result)
    }

    /// Register a new pathless authoritative buffer and its recovery checkpoint.
    pub fn open_untitled(
        &mut self,
        id: DocumentId,
        text: String,
    ) -> Result<OpenDocument, WorkspaceError> {
        if self.actors.contains_key(&id.0) {
            return Err(WorkspaceError::AlreadyExists);
        }
        let actor = DocumentActor::open(id.clone(), text, None, self.services.clone())?;
        actor.attach_storage(
            self.root.clone(),
            self.record_path(&id.0),
            self.scope.clone(),
        )?;
        // Untitled initial content is unsaved and must be recoverable.
        actor.mark_unsaved()?;
        let result = self.description(&actor)?;
        self.actors.insert(id.0, actor);
        Ok(result)
    }

    /// Create a new contained Markdown file without overwriting an existing destination.
    pub fn create(&mut self, path: &str, text: &str) -> Result<OpenDocument, WorkspaceError> {
        let target = self.storage.resolve(&self.root, path)?;
        if !storage::markdown(&target) {
            return Err(WorkspaceError::NotMarkdown);
        }
        if self.storage.read_disk(&target)?.is_some() {
            return Err(WorkspaceError::AlreadyExists);
        }
        self.storage
            .atomic_write(&target, text.as_bytes(), None, Some(&self.root))?;
        self.open_markdown(path)
    }

    /// Create one contained directory under an existing parent without opening a buffer.
    /// Existing entries and the workspace root are never replaced or accepted as new folders.
    pub fn create_folder(&self, path: &str) -> Result<WorkspaceEntry, WorkspaceError> {
        let target = self.storage.resolve(&self.root, path)?;
        if target == self.root {
            return Err(WorkspaceError::InvalidPath);
        }
        if self.storage.exists(&target) {
            return Err(WorkspaceError::AlreadyExists);
        }
        self.storage.create_dir(&target)?;
        Ok(WorkspaceEntry {
            path: storage::relative(&self.root, &target)?,
            name: target
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or(WorkspaceError::InvalidPath)?
                .to_owned(),
            directory: true,
            markdown: false,
            kind: None,
        })
    }

    /// Rename a Markdown or supported UTF-8 text document at the acknowledged revision.
    ///
    /// Reuses the existing actor rename so the stable document ID, revision,
    /// unsaved content, and native Undo history are preserved.
    pub fn rename(
        &mut self,
        request: SaveRequest,
        path: &str,
    ) -> Result<OpenDocument, WorkspaceError> {
        let target = self.storage.resolve(&self.root, path)?;
        if !storage::markdown(&target) && !storage::text_family(&target) {
            return Err(WorkspaceError::NotText);
        }
        let actor = self.actor(&request.document_id.0)?;
        actor.rename(request, target)?;
        self.description(actor)
    }

    /// Rename a workspace image without creating a text actor.
    ///
    /// Requires the captured native fingerprint so a changed file
    /// refuses with a conflict instead of renaming stale bytes. Never
    /// overwrites an existing destination and never escapes the workspace.
    pub fn rename_image(
        &self,
        source: &str,
        dest: &str,
        expected: Fingerprint,
    ) -> Result<WorkspaceEntry, WorkspaceError> {
        let source_abs = self.storage.resolve(&self.root, source)?;
        let target_abs = self.storage.resolve(&self.root, dest)?;
        if source_abs == self.root || target_abs == self.root {
            return Err(WorkspaceError::InvalidPath);
        }
        if !storage::image_family(&source_abs) || !storage::image_family(&target_abs) {
            return Err(WorkspaceError::InvalidImage);
        }
        let bytes = self.storage.read_image_bytes(&source_abs)?;
        image_mime(&source_abs, &bytes)?;
        image_mime(&target_abs, &bytes)?;
        if storage::fingerprint(&bytes) != expected {
            return Err(WorkspaceError::Conflict {
                path: source.into(),
            });
        }
        if source_abs == target_abs {
            return Err(WorkspaceError::AlreadyExists);
        }
        self.storage.hard_link(&source_abs, &target_abs)?;
        if let Err(error) = self.storage.remove_file(&source_abs) {
            let _ = self.storage.remove_file(&target_abs);
            return Err(error);
        }
        Ok(WorkspaceEntry {
            path: storage::relative(&self.root, &target_abs)?,
            name: target_abs
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or(WorkspaceError::InvalidPath)?
                .to_owned(),
            directory: false,
            markdown: false,
            kind: Some(WorkspaceFileKind::Image),
        })
    }

    /// Rename a workspace folder through the storage port without moving open descendants.
    ///
    /// Refuses the workspace root, existing destinations, link escapes, moves
    /// into itself, and folders with open descendant documents. Unsaved
    /// documents are never closed by this operation.
    pub fn rename_folder(
        &self,
        source: &str,
        dest: &str,
    ) -> Result<WorkspaceEntry, WorkspaceError> {
        let source_abs = self.storage.resolve(&self.root, source)?;
        let target_abs = self.storage.resolve(&self.root, dest)?;
        if source_abs == self.root || target_abs == self.root {
            return Err(WorkspaceError::InvalidPath);
        }
        if source_abs == target_abs {
            return Err(WorkspaceError::AlreadyExists);
        }
        if target_abs.starts_with(&source_abs) {
            return Err(WorkspaceError::InvalidPath);
        }
        let meta = self.storage.metadata(&source_abs).map_err(|e| match e {
            WorkspaceError::Io { .. } => WorkspaceError::NotFound,
            other => other,
        })?;
        if !meta.is_dir() {
            return Err(WorkspaceError::InvalidPath);
        }
        for actor in self.actors.values() {
            if actor
                .path()
                .as_ref()
                .is_some_and(|path| path.starts_with(&source_abs))
            {
                return Err(WorkspaceError::FolderOpenDocuments);
            }
        }
        self.storage.rename_dir(&source_abs, &target_abs)?;
        Ok(WorkspaceEntry {
            path: storage::relative(&self.root, &target_abs)?,
            name: target_abs
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or(WorkspaceError::InvalidPath)?
                .to_owned(),
            directory: true,
            markdown: false,
            kind: None,
        })
    }

    /// Honor the caller's save, discard or cancel decision before removing the actor.
    pub fn close(
        &mut self,
        request: SaveRequest,
        action: CloseAction,
    ) -> Result<bool, WorkspaceError> {
        let id = request.document_id.0.clone();
        let actor = self.actor(&id)?;
        let snapshot = actor.sync_from_nvim().unwrap_or_else(|_| actor.snapshot());
        crate::domain::validation::validate_save(&snapshot, &request)
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
                return Err(WorkspaceError::UnsavedChanges {
                    snapshot: Box::new(snapshot),
                });
            }
        }
        Ok(())
    }

    /// Preserve literal callers while refusing to return incomplete results as exhaustive.
    pub fn search(&self, query: &str) -> Result<Vec<SearchMatch>, WorkspaceError> {
        let result =
            self.search_with_options(query, &SearchOptions::default(), &self.info().root)?;
        if result.limit.is_some() {
            return Err(WorkspaceError::SearchIncomplete);
        }
        Ok(result.matches)
    }

    /// Search authoritative buffers and bounded disk text with one native matching policy.
    pub fn search_with_options(
        &self,
        query: &str,
        options: &SearchOptions,
        root: &str,
    ) -> Result<SearchResults, WorkspaceError> {
        use crate::domain::search::{self, MatchPositions, Matcher, MAX_MATCHES, MAX_TEXT_BYTES};
        if self.info().root != root {
            return Err(WorkspaceError::StaleSearch);
        }
        let matcher = Matcher::compile(query, options)?;
        let began = self.clock.nanos();
        let mut result = SearchResults {
            matches: Vec::new(),
            limit: None,
        };
        let mut pending = vec![String::new()];
        let mut files = Vec::new();
        let mut entries = 0;
        'folders: while let Some(folder) = pending.pop() {
            if self.clock.nanos().saturating_sub(began) > 2_000_000_000 {
                result.limit = Some(SearchLimit::Time);
                break;
            }
            let directory = if folder.is_empty() {
                self.root.clone()
            } else {
                self.storage.resolve(&self.root, &folder)?
            };
            let (children, omitted) = self
                .storage
                .read_search_entries(&directory, 5000 - entries)?;
            if omitted {
                result.limit = Some(SearchLimit::Files);
            }
            for entry in children {
                entries += 1;
                let name = entry.file_name().to_string_lossy().to_string();
                if name == ".git" || name.starts_with(".marxen-") || entry.info.is_symlink() {
                    continue;
                }
                let path = storage::relative(&self.root, &entry.path())?;
                if self.storage.resolve(&self.root, &path).is_err() {
                    continue;
                }
                if entry.info.is_dir() {
                    pending.push(path);
                } else if entry.info.is_file() && storage::text_family(&entry.path()) {
                    if files.len() >= 2000 {
                        result.limit = Some(SearchLimit::Files);
                        break 'folders;
                    }
                    files.push(path);
                }
            }
            if entries >= 5000 && !pending.is_empty() {
                result.limit = Some(SearchLimit::Files);
                break;
            }
        }
        files.sort();
        let mut bytes = 0;
        'files: for path in files {
            if self.clock.nanos().saturating_sub(began) > 2_000_000_000 {
                result.limit = Some(SearchLimit::Time);
                break;
            }
            let target = self.storage.resolve(&self.root, &path)?;
            let actor = self
                .actors
                .values()
                .find(|a| a.path().as_ref() == Some(&target));
            let (text, id, revision, location) = if let Some(actor) = actor {
                let snapshot = actor.sync_from_nvim()?;
                (
                    snapshot.text,
                    Some(snapshot.document_id),
                    Some(snapshot.revision),
                    snapshot.location,
                )
            } else {
                match self.storage.read_search_text(&target, MAX_TEXT_BYTES) {
                    Ok(text) => (text, None, None, None),
                    Err(WorkspaceError::SearchIncomplete) => {
                        result.limit = Some(SearchLimit::FileBytes);
                        continue;
                    }
                    Err(WorkspaceError::InvalidUtf8) => continue,
                    Err(error) => return Err(error),
                }
            };
            bytes += text.len();
            if bytes > 32 * 1024 * 1024 {
                result.limit = Some(SearchLimit::WorkspaceBytes);
                break;
            }
            let found = matcher.find(&text, MAX_MATCHES - result.matches.len());
            let content_token = storage::fingerprint(text.as_bytes()).0;
            let mut positions = MatchPositions::new();
            for range in found.ranges {
                if self.clock.nanos().saturating_sub(began) > 2_000_000_000 {
                    result.limit = Some(SearchLimit::Time);
                    break 'files;
                }
                let (coordinates, line, line_start) = positions.next(&text, &range);
                let (preview, preview_range) = search::preview(&text, &range, line_start);
                result.matches.push(SearchMatch {
                    location: location.clone(),
                    scope: Some(self.scope.clone()),
                    path: path.clone(),
                    document_id: id.clone(),
                    revision,
                    range: coordinates,
                    line,
                    preview,
                    preview_range,
                    content_token: content_token.clone(),
                });
            }
            if let Some(limit) = found.limit {
                let stop = limit == SearchLimit::Matches;
                result.limit = Some(limit);
                if stop {
                    break;
                }
            }
        }
        Ok(result)
    }

    /// Plan exact literal edits against unchanged searched content and a real Neovim revision.
    pub fn plan_search_replacement(
        &mut self,
        request: SearchReplaceRequest,
    ) -> Result<SearchReplacePlan, WorkspaceError> {
        use crate::domain::search::{MatchPositions, Matcher, MAX_MATCHES, MAX_TEXT_BYTES};
        if let Some(location) = &request.location {
            if location.path.as_ref() != Some(&request.path) {
                return Err(WorkspaceError::StaleLocation);
            }
            self.validate_location(
                &request
                    .document_id
                    .as_ref()
                    .ok_or(WorkspaceError::WrongOwner)?
                    .0,
                location,
            )?;
        }
        if self.info().root != request.root
            || request
                .scope
                .as_ref()
                .is_some_and(|scope| scope != &self.scope)
        {
            return Err(WorkspaceError::StaleSearch);
        }
        let matcher = Matcher::compile(&request.query, &request.options)?;
        let target = self.storage.resolve(&self.root, &request.path)?;
        if !storage::text_family(&target) {
            return Err(WorkspaceError::NotText);
        }
        // Validate closed-file content before opening a native actor.
        if !self
            .actors
            .values()
            .any(|a| a.path().as_ref() == Some(&target))
        {
            let text = self.storage.read_search_text(&target, MAX_TEXT_BYTES)?;
            if storage::fingerprint(text.as_bytes()).0 != request.content_token {
                return Err(WorkspaceError::StaleSearch);
            }
        }
        let mut document = self.open_text_file(&request.path)?;
        document.snapshot = self
            .actor(&document.snapshot.document_id.0)?
            .sync_from_nvim()?;
        let snapshot = &document.snapshot;
        if storage::fingerprint(snapshot.text.as_bytes()).0 != request.content_token
            || request
                .revision
                .is_some_and(|revision| revision != snapshot.revision)
        {
            return Err(WorkspaceError::StaleSearch);
        }
        let found = matcher.find(&snapshot.text, MAX_MATCHES);
        if found.limit.is_some() && request.range.is_none() {
            return Err(WorkspaceError::SearchIncomplete);
        }
        let mut positions = MatchPositions::new();
        let edits: Vec<TextEdit> = found
            .ranges
            .iter()
            .map(|range| positions.next(&snapshot.text, range).0)
            .filter(|range| {
                request
                    .range
                    .as_ref()
                    .is_none_or(|selected| selected == range)
            })
            .map(|range| TextEdit {
                range,
                text: request.replacement.clone(),
            })
            .collect();
        if edits.is_empty() {
            return Err(WorkspaceError::StaleSearch);
        }
        Ok(SearchReplacePlan { document, edits })
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
                let current = self
                    .storage
                    .check_target(Some(&self.root), &path)
                    .and_then(|_| self.storage.disk_fingerprint(&path));
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

    /// Read valid recovery records from the workspace's separate recovery directory.
    fn records(&self) -> Result<Vec<RecoveryRecord>, WorkspaceError> {
        let mut records = Vec::new();
        for entry in self.storage.read_dir(&self.recovery)? {
            if entry.path().extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let bytes = self
                .storage
                .read_disk(&entry.path())?
                .ok_or(WorkspaceError::NotFound)?;
            let record: RecoveryRecord =
                serde_json::from_slice(&bytes).map_err(|e| WorkspaceError::Io {
                    detail: format!("invalid recovery {}: {e}", entry.path().display()),
                })?;
            if !matches!(record.version, 1 | 2)
                || record.root != self.root
                || !record.snapshot.dirty
            {
                return Err(WorkspaceError::InvalidPath);
            }
            if record.version == 2 && record.root_id.as_ref() != Some(&self.scope.root_id) {
                return Err(WorkspaceError::WrongOwner);
            }
            if record.version == 2 {
                let id = &record.snapshot.document_id.0;
                let root = &self.scope.root_id.0[5..];
                if !(id.starts_with(&format!("doc-{root}-"))
                    || id.starts_with(&format!("legacy-{root}-")))
                    || record.snapshot.location.as_ref().is_none_or(|location| {
                        location.scope.root_id != self.scope.root_id || location.path != record.path
                    })
                {
                    return Err(WorkspaceError::WrongOwner);
                }
            }
            crate::domain::validation::validate_document_id(&record.snapshot.document_id)
                .map_err(|error| WorkspaceError::Contract { error })?;
            if entry.path() != self.record_path(&record.snapshot.document_id.0) {
                return Err(WorkspaceError::InvalidPath);
            }
            if let Some(path) = &record.path {
                let path = self.storage.resolve(&self.root, path)?;
                if !storage::text_family(&path) {
                    return Err(WorkspaceError::NotText);
                }
            }
            records.push(record);
        }
        Ok(records)
    }

    /// List recoverable documents with current disk conflict information.
    pub fn recovery_entries(&self) -> Result<Vec<RecoveryEntry>, WorkspaceError> {
        self.records()?
            .into_iter()
            .map(|r| {
                let current = r
                    .path
                    .as_ref()
                    .map(|p| {
                        self.storage
                            .resolve(&self.root, p)
                            .and_then(|p| self.storage.disk_fingerprint(&p))
                    })
                    .transpose()?
                    .flatten();
                Ok(RecoveryEntry {
                    location: DocumentLocation {
                        scope: self.scope.clone(),
                        path: r.path.clone(),
                        position: 0,
                    },
                    document_id: r.snapshot.document_id,
                    path: r.path,
                    revision: r.snapshot.revision,
                    conflict: current != r.baseline,
                })
            })
            .collect()
    }

    /// Restore a valid recovery record while retaining conflict checks against the captured baseline.
    pub fn restore(&mut self, id: &str) -> Result<OpenDocument, WorkspaceError> {
        if self.actors.contains_key(id) {
            return Err(WorkspaceError::AlreadyExists);
        }
        let mut record = self
            .records()?
            .into_iter()
            .find(|r| r.snapshot.document_id.0 == id)
            .ok_or(WorkspaceError::NotFound)?;
        let path = record
            .path
            .as_ref()
            .map(|p| self.storage.resolve(&self.root, p))
            .transpose()?;
        if self
            .actors
            .values()
            .any(|a| path.is_some() && a.path() == path)
        {
            return Err(WorkspaceError::AlreadyExists);
        }
        // Legacy IDs are mapped into this root namespace before the old bytes are retired.
        let restored_id = if record.version == 1 {
            format!(
                "legacy-{}-{}",
                &self.scope.root_id.0[5..],
                &storage::fingerprint(id.as_bytes()).0[..32]
            )
        } else {
            id.to_owned()
        };
        if self.actors.contains_key(&restored_id)
            || (restored_id != id && self.storage.exists(&self.record_path(&restored_id)))
        {
            return Err(WorkspaceError::AlreadyExists);
        }
        record.snapshot.document_id = DocumentId(restored_id.clone());
        let actor = DocumentActor::open(
            record.snapshot.document_id.clone(),
            record.snapshot.text.clone(),
            path,
            self.services.clone(),
        )?;
        actor.restore_record(&record)?;
        actor.attach_storage(
            self.root.clone(),
            self.record_path(&restored_id),
            self.scope.clone(),
        )?;
        if restored_id != id {
            self.storage.remove_checkpoint(&self.record_path(id))?;
        }
        let result = self.description(&actor)?;
        self.observed.insert(restored_id.clone(), actor.baseline());
        self.actors.insert(restored_id, actor);
        Ok(result)
    }

    /// Delete the selected recovery record without changing live text or disk content.
    pub fn discard_recovery(&self, id: &str) -> Result<(), WorkspaceError> {
        if self.actors.contains_key(id) {
            return Err(WorkspaceError::AlreadyExists);
        }
        self.storage.remove_checkpoint(&self.record_path(id))
    }

    /// Resolve a document-relative image and return bounded bytes with verified image MIME type.
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
        let target = self.storage.resolve(&self.root, &parts.join("/"))?;
        let bytes = self.storage.read_image_bytes(&target)?;
        let mime = image_mime(&target, &bytes)?;
        Ok(ImageData {
            mime: mime.into(),
            fingerprint: storage::fingerprint(&bytes).0,
            bytes,
        })
    }

    /// Read a contained workspace image for the explorer viewer.
    pub fn load_workspace_image(&self, path: &str) -> Result<ImageData, WorkspaceError> {
        let target = self.storage.resolve(&self.root, path)?;
        let bytes = self.storage.read_image_bytes(&target)?;
        Ok(ImageData {
            mime: image_mime(&target, &bytes)?.into(),
            fingerprint: storage::fingerprint(&bytes).0,
            bytes,
        })
    }

    /// Insert a contained image reference through a revision-checked Markdown range edit.
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

    /// Validate bounded external image bytes before importing them into the workspace.
    pub fn import_external_image(
        &self,
        request: SaveRequest,
        path: &Path,
        range: Utf16Range,
    ) -> Result<PasteResult, WorkspaceError> {
        if !path.is_absolute() {
            return Err(WorkspaceError::InvalidPath);
        }
        let bytes = self.storage.read_image_bytes(path)?;
        image_mime(path, &bytes)?;
        let name = path
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or(WorkspaceError::InvalidPath)?;
        self.paste_image(request, name, &bytes, range)
    }

    /// Import image bytes into the attachment folder and replace the exact GUI range atomically.
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
        crate::domain::validation::validate_edit(
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
        self.storage.resolve(&self.root, &relative_folder)?;
        if !self.storage.exists(&folder) {
            self.storage.create_dir(&folder)?;
        }
        let path = format!("{relative_folder}/{name}");
        let target = self.storage.resolve(&self.root, &path)?;
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
        crate::domain::validation::validate_edit(&snapshot, &edits)
            .map_err(|error| WorkspaceError::Contract { error })?;
        if self.storage.read_disk(&target)?.is_some() {
            return Err(WorkspaceError::AlreadyExists);
        }
        self.storage
            .atomic_write(&target, bytes, None, Some(&self.root))?;
        // IPC holds the workspace mutex, so no other GUI edit can interleave.
        match actor.apply_edits(edits) {
            Ok(snapshot) => Ok(PasteResult { path, snapshot }),
            Err(error) => Err(error.into()),
        }
    }
}

/// Percent-encode image reference characters that would break Markdown URLs.
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

/// Determine supported image MIME from its extension and validated byte signature.
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

/// Decode safe relative image URLs while rejecting absolute, remote and traversal targets.
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
