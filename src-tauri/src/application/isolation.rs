//! Exact-scope isolated workspace copies for CLI AI (Issue #8).
//!
//! Agents never see live paths or unselected text. [`IsolationManager`]
//! copies only Rust-validated selected excerpts (unsaved authoritative
//! Neovim snapshots, never disk reads) into a staging directory, records the
//! exact sent scope (document, revision, source ranges, disk fingerprint),
//! diffs staging against live per scope, stages validated text proposals,
//! and applies only approved range patches through the Neovim actor
//! ([`DocumentActor`]) with the shared save contract
//! (`validation::validate_edit` inside `apply_edits`). Rejection and
//! cancellation only delete staging; live buffers and disk stay exact. Stale
//! revisions and disk changes refuse with resync (re-create the copy).
//!
//! Isolation is a copy, not an OS sandbox: staging lives on the same machine
//! and the agent subprocess runs with the user's privileges. The guarantee
//! is that live buffers and disk change only through approved Ai range
//! patches confined to registered scopes; extra staging files, non-Markdown,
//! .git/.env, and widened ranges are never applied. Production IPC holds the
//! workspace mutex across preflight and apply, so no other edit can
//! interleave between validation and mutation.
use crate::contracts::isolation::*;
use crate::domain::isolation::*;

use crate::application::document::DocumentActor;
use crate::application::workspace::Workspace;
use crate::contracts::ai::{IsolatedCopyId, PromptContext, PromptMode, ProposalText};
use crate::contracts::{
    ContractError, DocumentId, DocumentSnapshot, EditRequest, EditSource, Revision, TextEdit,
    Utf16Offset, Utf16Range, WorkspaceError,
};
use crate::domain::storage::{self, Fingerprint};

use std::collections::{HashMap, HashSet};

use crate::application::ports::*;
use std::path::{Path, PathBuf};
use std::sync::Arc;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CopyStatus {
    Active,
    Approved,
    Rejected,
    Cancelled,
    Failed,
}

#[derive(Debug, Clone)]
struct CopyBase {
    location: crate::contracts::DocumentLocation,
    document_id: DocumentId,
    revision: Revision,
    relative_path: Option<String>,
    staging_rel: String,
    base_disk: Option<Fingerprint>,
    base_text: String,
    scopes: Vec<Utf16Range>,
    full_document: bool,
}

#[derive(Debug)]
struct IsolatedCopy {
    scope: crate::contracts::RootScope,
    workspace_root: PathBuf,
    staging_dir: PathBuf,
    bases: Vec<CopyBase>,
    status: CopyStatus,
}

/// Owner of staging directories. One manager serves all workspaces; each copy
/// records its own workspace root and is validated against it on every call.
/// `pins` counts live runs (ACP process or HTTP stream) per copy; pinned
/// copies refuse approve/reject/cancel until the run settles and releases.
/// `retired_imports` remembers approved copies with their original workspace
/// root and not-yet-imported staged files, so staged new-file imports stay
/// bound to the approving workspace even after the copy is consumed; records
/// clear only once every pending file imports on a fully successful request.
pub struct IsolationManager {
    conversations: HashMap<String, crate::contracts::RootScope>,
    storage: Arc<dyn StagingStorage>,
    clock: Arc<dyn Clock>,
    staging_root: PathBuf,
    next: u64,
    copies: HashMap<String, IsolatedCopy>,
    pins: HashMap<String, u32>,
    retired_imports: HashMap<String, RetiredCopy>,
    /// Explicit test-support configuration: when set, that document's apply
    /// fails deterministically AFTER native preflight and any earlier
    /// applies, so tests exercise partial outcomes and rollback. Production
    /// IPC paths never set this; it exists so tests need no global env var.
    apply_fault_for_tests: Option<String>,
}

/// Original workspace binding of one approved copy with its pending imports.
///
/// `root` is the workspace the copy was approved from; `pending` maps each
/// not-yet-imported staged new file to its authoritative content captured at
/// approval. Both are captured before the staging directory is consumed, so
/// later import requests are validated against Rust-owned state instead of
/// trusting caller-supplied paths and content.
#[derive(Debug, Clone)]
struct RetiredCopy {
    scope: crate::contracts::RootScope,
    root: PathBuf,
    pending: HashMap<String, String>,
}

impl IsolationManager {
    /// Arm a deterministic apply-phase failure for one document id. Test
    /// support only: no production path calls this.
    pub fn inject_apply_failure_for_tests(&mut self, document_id: Option<DocumentId>) {
        self.apply_fault_for_tests = document_id.map(|id| id.0);
    }
}

impl IsolationManager {
    /// Create the guarded staging root with injected storage and identifier clock.
    pub fn open(
        staging_root: &Path,
        storage: Arc<dyn StagingStorage>,
        clock: Arc<dyn Clock>,
    ) -> Result<Self, WorkspaceError> {
        storage.create_dir_all(staging_root)?;
        let staging_root = storage.canonicalize(staging_root)?;
        if !storage.metadata(&staging_root).is_ok_and(|m| m.directory) {
            return Err(WorkspaceError::InvalidPath);
        }
        if storage.metadata(&staging_root)?.file_type().is_symlink() {
            return Err(WorkspaceError::OutsideWorkspace);
        }
        Ok(Self {
            conversations: HashMap::new(),
            storage,
            clock,
            staging_root,
            next: 1,
            copies: HashMap::new(),
            pins: HashMap::new(),
            retired_imports: HashMap::new(),
            apply_fault_for_tests: None,
        })
    }

    /// Borrow the canonical guarded staging root.
    pub fn staging_root(&self) -> &Path {
        &self.staging_root
    }

    /// Resolve the owner captured by an active copy or its approved pending imports.
    pub fn owner(
        &self,
        copy_id: &IsolatedCopyId,
    ) -> Result<crate::contracts::RootScope, WorkspaceError> {
        validate_copy_id_string(&copy_id.0)?;
        self.copies
            .get(&copy_id.0)
            .map(|copy| copy.scope.clone())
            .or_else(|| {
                self.retired_imports
                    .get(&copy_id.0)
                    .map(|record| record.scope.clone())
            })
            .ok_or(WorkspaceError::NotFound)
    }

    /// Report whether an active copy of this root touches a workspace folder.
    ///
    /// Used to refuse folder renames that would invalidate an AI working
    /// copy; the caller rejects with a reason instead of moving the folder.
    pub fn has_active_copy_under(&self, scope: &crate::contracts::RootScope, folder: &str) -> bool {
        self.copies.values().any(|copy| {
            copy.status == CopyStatus::Active
                && copy.scope == *scope
                && copy.bases.iter().any(|base| {
                    base.relative_path
                        .as_ref()
                        .is_some_and(|rel| std::path::Path::new(rel).starts_with(folder))
                })
        })
    }

    /// Allocate a process-local copy identifier without exposing a live document path.
    fn new_copy_id(&mut self) -> IsolatedCopyId {
        let nanos = self.clock.nanos();
        let id = format!("copy_{nanos:x}_{}", self.next);
        self.next += 1;
        IsolatedCopyId(id)
    }

    /// Return a registered active copy or reject a consumed or unknown handle.
    fn get_active(&self, copy_id: &IsolatedCopyId) -> Result<&IsolatedCopy, WorkspaceError> {
        validate_copy_id_string(&copy_id.0)?;
        let copy = self
            .copies
            .get(&copy_id.0)
            .ok_or(WorkspaceError::NotFound)?;
        if copy.status != CopyStatus::Active {
            return Err(WorkspaceError::InvalidPath);
        }
        Ok(copy)
    }

    /// Borrow an active copy for a scoped proposal update.
    fn get_active_mut(
        &mut self,
        copy_id: &IsolatedCopyId,
    ) -> Result<&mut IsolatedCopy, WorkspaceError> {
        validate_copy_id_string(&copy_id.0)?;
        let copy = self
            .copies
            .get_mut(&copy_id.0)
            .ok_or(WorkspaceError::NotFound)?;
        if copy.status != CopyStatus::Active {
            return Err(WorkspaceError::InvalidPath);
        }
        Ok(copy)
    }

    /// Report whether a running provider still owns this copy's settlement pin.
    fn pinned(&self, copy_id: &IsolatedCopyId) -> bool {
        self.pins.get(&copy_id.0).is_some_and(|count| *count > 0)
    }

    /// Reject review mutations while the copy is owned by a running provider.
    fn refuse_if_pinned(&self, copy_id: &IsolatedCopyId) -> Result<(), WorkspaceError> {
        if self.pinned(copy_id) {
            return Err(invalid_scope(
                "実行中のため操作できません。実行の完了後に差分を取り直してください",
            ));
        }
        Ok(())
    }

    /// Pin a copy for a live run (ACP process or HTTP stream). The pin is
    /// released only when the run actually settles (child reap / HTTP
    /// completion); a bare cancellation request never releases it.
    pub fn pin_for_run(&mut self, copy_id: &IsolatedCopyId) -> Result<(), WorkspaceError> {
        self.get_active(copy_id)?;
        *self.pins.entry(copy_id.0.clone()).or_insert(0) += 1;
        Ok(())
    }

    /// Release one run pin. Missing entries are tolerated so settlement paths
    /// stay infallible.
    pub fn unpin_for_run(&mut self, copy_id: &IsolatedCopyId) {
        if let Some(count) = self.pins.get_mut(&copy_id.0) {
            if *count > 1 {
                *count -= 1;
            } else {
                self.pins.remove(&copy_id.0);
            }
        }
    }

    /// Capture only the selected Rust-validated excerpts into staging and
    /// persist the exact scopes in the registered copy. Excluded text never
    /// reaches the agent. Full-document staging happens only when the entire
    /// document is explicitly selected as a single [0, len) range.
    pub fn create_copy(
        &mut self,
        workspace: &Workspace,
        contexts: &[PromptContext],
    ) -> Result<IsolatedCopyInfo, WorkspaceError> {
        if contexts.is_empty() || contexts.len() > crate::domain::ai::MAX_CONTEXTS {
            return Err(WorkspaceError::InvalidPath);
        }
        // Group by document; contradictory duplicates (different revisions for
        // the same document) are refused below.
        let mut order: Vec<String> = Vec::new();
        let mut grouped: HashMap<String, Vec<&PromptContext>> = HashMap::new();
        for context in contexts {
            if let Some(location) = &context.location {
                workspace.validate_location(&context.document_id.0, location)?;
            }
            crate::domain::validation::validate_document_id(&context.document_id)
                .map_err(|_| WorkspaceError::InvalidPath)?;
            if !grouped.contains_key(&context.document_id.0) {
                order.push(context.document_id.0.clone());
            }
            grouped
                .entry(context.document_id.0.clone())
                .or_default()
                .push(context);
        }
        let workspace_root = workspace.root().to_owned();
        let copy_id = self.new_copy_id();
        validate_copy_id_string(&copy_id.0)?;
        let staging_dir = self
            .storage
            .guard_staging_path(&self.staging_root, Path::new(&copy_id.0))?;
        if self.storage.exists(&staging_dir) {
            return Err(WorkspaceError::AlreadyExists);
        }
        self.storage.create_dir_all(&staging_dir)?;
        self.storage
            .check_no_symlink(&staging_dir, &self.staging_root)?;
        // Any failure below removes the half-built staging dir so a failed
        // copy never leaves agent-visible residue behind.
        let built: Result<(Vec<CopyBase>, Vec<IsolatedCopyDoc>), WorkspaceError> = (|| {
            let mut bases = Vec::new();
            let mut documents = Vec::new();
            for doc_key in order {
                let group = &grouped[&doc_key];
                let actor = workspace.actor(&doc_key)?;
                let snapshot = actor.snapshot();
                // Every duplicate context must agree on the live revision.
                for context in group {
                    if snapshot.revision != context.revision {
                        return Err(stale(context.revision, snapshot.revision));
                    }
                    validate_context_against_snapshot(&snapshot, context)?;
                }
                // Merge scopes across duplicate contexts; overlaps refuse.
                let mut merged: Vec<Utf16Range> = Vec::new();
                for context in group {
                    merged.extend(context.ranges.iter().cloned());
                }
                merged.sort_by_key(|range| (range.start.0, range.end.0));
                for pair in merged.windows(2) {
                    if pair[1].start.0 < pair[0].end.0 || pair[1].start.0 <= pair[0].start.0 {
                        return Err(WorkspaceError::Contract {
                            error: ContractError::OverlappingEdits,
                        });
                    }
                }
                let full_document = merged.len() == 1
                    && merged[0].start.0 == 0
                    && merged[0].end.0 == utf16_len(&snapshot.text);
                let relative_path: Option<String> = actor
                    .path()
                    .as_ref()
                    .map(|p| storage::relative(&workspace_root, p))
                    .transpose()?;
                if let Some(rel) = &relative_path {
                    reject_forbidden_relative(rel)?;
                }
                let base_disk: Option<Fingerprint> = match actor.path().as_ref() {
                    Some(path) => self.storage.disk_fingerprint(path)?,
                    None => None,
                };
                let staging_rel = match &relative_path {
                    Some(rel) => rel.clone(),
                    None => format!("{doc_key}.md"),
                };
                let staging_file = self
                    .storage
                    .guard_staging_path(&staging_dir, Path::new(&staging_rel))?;
                self.storage
                    .check_no_symlink(&staging_file, &self.staging_root)?;
                if let Some(parent) = staging_file.parent() {
                    self.storage.create_dir_all(parent)?;
                }
                if self.storage.metadata(&staging_file).is_ok() {
                    return Err(WorkspaceError::AlreadyExists);
                }
                let slices: Vec<(Utf16Range, String)> = merged
                    .iter()
                    .map(|range| {
                        utf16_slice(&snapshot.text, range)
                            .map(|slice| (range.clone(), slice))
                            .map_err(|error| WorkspaceError::Contract { error })
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                let staged_bytes = if full_document {
                    snapshot.text.as_bytes().to_owned()
                } else {
                    render_scoped_file(&snapshot.document_id, &slices).into_bytes()
                };
                self.storage.write_staging(&staging_file, &staged_bytes)?;
                self.storage
                    .check_no_symlink(&staging_file, &self.staging_root)?;
                bases.push(CopyBase {
                    location: snapshot
                        .location
                        .clone()
                        .ok_or(WorkspaceError::WrongOwner)?,
                    document_id: snapshot.document_id.clone(),
                    revision: snapshot.revision,
                    relative_path: relative_path.clone(),
                    staging_rel,
                    base_disk,
                    base_text: snapshot.text.clone(),
                    scopes: merged.clone(),
                    full_document,
                });
                documents.push(IsolatedCopyDoc {
                    document_id: snapshot.document_id,
                    revision: snapshot.revision,
                    path: relative_path,
                    ranges: merged,
                    full_document,
                });
            }
            Ok((bases, documents))
        })();
        let (bases, documents) = match built {
            Ok(staged) => staged,
            Err(error) => {
                let _ = self.storage.remove_staging(&staging_dir);
                return Err(error);
            }
        };

        self.copies.insert(
            copy_id.0.clone(),
            IsolatedCopy {
                scope: workspace.scope().clone(),
                workspace_root,
                staging_dir,
                bases,
                status: CopyStatus::Active,
            },
        );
        Ok(IsolatedCopyInfo { copy_id, documents })
    }

    /// Resolve an active copy to its staging directory for ACP cwd.
    /// Binds workspace and copy; refuses tampering, links, and unknown or
    /// inactive IDs. Resolution alone never pins: the run entry point pins.
    pub fn resolve(&self, copy_id: &IsolatedCopyId) -> Result<PathBuf, WorkspaceError> {
        let copy = self.get_active(copy_id)?;
        let dir = self
            .storage
            .guard_staging_path(&self.staging_root, Path::new(&copy_id.0))?;
        if dir != copy.staging_dir {
            return Err(WorkspaceError::OutsideWorkspace);
        }
        self.storage.check_no_symlink(&dir, &self.staging_root)?;
        // Junction/ADS detours surface here even when names look contained.
        if self
            .storage
            .canonicalize(&dir)
            .map(|canonical| canonical != dir)
            .unwrap_or(true)
            && self.storage.metadata(&dir).is_ok_and(|m| m.directory)
        {
            let canonical = self.storage.canonicalize(&dir)?;
            if !canonical.starts_with(&self.staging_root) {
                return Err(WorkspaceError::OutsideWorkspace);
            }
        }
        if !self.storage.metadata(&dir).is_ok_and(|m| m.directory) {
            return Err(WorkspaceError::NotFound);
        }
        Ok(dir)
    }

    /// Resolve and authorize the captured scope before pinning a live run.
    /// Callers serialize workspace access before manager access. Failed
    /// resolution or authorization never acquires a pin; successful runs
    /// retain it until transport settlement, including cancellation.
    pub fn prepare_prompt_run(
        &mut self,
        workspace: &Workspace,
        request: &crate::contracts::ai::AiPromptRequest,
    ) -> Result<PathBuf, WorkspaceError> {
        // Each run creates a new ACP process/session. No resumed session has a proven owner.
        if request.session_id.is_some() {
            return Err(WorkspaceError::WrongOwner);
        }
        let dir = self.resolve(&request.staging.copy_id)?;
        self.authorize_prompt(workspace, request)?;
        if let Some(id) = &request.conversation_id {
            if id.is_empty() || id.len() > 128 {
                return Err(WorkspaceError::InvalidPath);
            }
            if self
                .conversations
                .get(id)
                .is_some_and(|scope| scope != workspace.scope())
            {
                return Err(WorkspaceError::WrongOwner);
            }
            self.conversations
                .insert(id.clone(), workspace.scope().clone());
        }
        self.pin_for_run(&request.staging.copy_id)?;
        Ok(dir)
    }

    /// Authorize an outgoing prompt against the captured Rust snapshots before
    /// any network or process side effect (both HTTP and ACP). The current
    /// request must equal the registered copy exactly: the same documents at
    /// the same revisions with the same ranges. Narrowing, omitted or extra
    /// documents, and contradictory duplicates are all refused; a changed
    /// selection needs a NEW copy. Excerpts must exactly equal the live
    /// source slices.
    pub fn authorize_prompt(
        &self,
        workspace: &Workspace,
        request: &crate::contracts::ai::AiPromptRequest,
    ) -> Result<(), WorkspaceError> {
        let copy = self.get_active(&request.staging.copy_id)?;
        self.check_workspace(copy, workspace)?;
        if request.contexts.len() != copy.bases.len() {
            return Err(invalid_scope("送信対象が登録した選択範囲と一致しません"));
        }
        for base in &copy.bases {
            let actor = workspace.actor(&base.document_id.0)?;
            let live = actor.snapshot();
            if live.revision != base.revision || live.text != base.base_text {
                return Err(stale(base.revision, live.revision));
            }
            let mut matched = 0usize;
            let mut merged: Vec<Utf16Range> = Vec::new();
            for context in request
                .contexts
                .iter()
                .filter(|context| context.document_id == base.document_id)
            {
                if let Some(location) = &context.location {
                    workspace.validate_location(&context.document_id.0, location)?;
                }
                matched += 1;
                if context.revision != base.revision {
                    return Err(stale(context.revision, base.revision));
                }
                let mut previous: Option<&Utf16Range> = None;
                let mut assembled = String::new();
                for range in &context.ranges {
                    if range.start.0 > range.end.0 {
                        return Err(WorkspaceError::Contract {
                            error: ContractError::ReversedRange,
                        });
                    }
                    if let Some(prev) = previous {
                        if range.start.0 < prev.end.0 || range.start.0 <= prev.start.0 {
                            return Err(WorkspaceError::Contract {
                                error: ContractError::OverlappingEdits,
                            });
                        }
                    }
                    assembled.push_str(
                        &utf16_slice(&live.text, range)
                            .map_err(|error| WorkspaceError::Contract { error })?,
                    );
                    previous = Some(range);
                }
                if assembled != context.text {
                    return Err(invalid_scope("送信した内容が対象範囲と一致しません"));
                }
                merged.extend(context.ranges.iter().cloned());
            }
            if matched == 0 {
                return Err(invalid_scope("登録した文書が送信対象にありません"));
            }
            merged.sort_by_key(|range| (range.start.0, range.end.0));
            if merged != base.scopes {
                return Err(invalid_scope("送信範囲が登録した選択範囲と一致しません"));
            }
        }
        Ok(())
    }

    /// Read only a guarded registered staging file and reject links before and after access.
    fn read_staging_bytes(
        &self,
        copy: &IsolatedCopy,
        base: &CopyBase,
    ) -> Result<Vec<u8>, WorkspaceError> {
        let file = self
            .storage
            .guard_staging_path(&copy.staging_dir, Path::new(&base.staging_rel))?;
        if !file.starts_with(&copy.staging_dir) {
            return Err(WorkspaceError::OutsideWorkspace);
        }
        self.storage.check_no_symlink(&file, &self.staging_root)?;
        let bytes = self
            .storage
            .read_disk(&file)?
            .ok_or(WorkspaceError::NotFound)?;
        self.storage.check_no_symlink(&file, &self.staging_root)?;
        Ok(bytes)
    }

    /// Refuse a copy whose captured workspace differs from the active workspace.
    fn check_workspace(
        &self,
        copy: &IsolatedCopy,
        workspace: &Workspace,
    ) -> Result<(), WorkspaceError> {
        if workspace.root() != copy.workspace_root {
            return Err(WorkspaceError::OutsideWorkspace);
        }
        if workspace.scope() != &copy.scope {
            return Err(WorkspaceError::StaleRoot);
        }
        for base in &copy.bases {
            workspace.validate_location(&base.document_id.0, &base.location)?;
        }
        Ok(())
    }

    /// Parse one document's staging content into scope replacements. Scoped
    /// files must carry exactly the registered sections in order; full
    /// documents are raw Markdown. Unknown or unselected staging files can
    /// never authorize live edits and are ignored by callers.
    fn scope_replacements(
        base: &CopyBase,
        staged: &str,
    ) -> Result<Vec<(Utf16Range, String)>, WorkspaceError> {
        if base.full_document {
            return Ok(vec![(
                Utf16Range {
                    start: Utf16Offset(0),
                    end: Utf16Offset(utf16_len(&base.base_text)),
                },
                staged.to_owned(),
            )]);
        }
        let sections = parse_scoped_file(staged)
            .map_err(|detail| invalid_scope(&format!("staging の形式が壊れています: {detail}")))?;
        if sections.len() != base.scopes.len() {
            return Err(invalid_scope("staging の scope 数が登録と一致しません"));
        }
        let mut out = Vec::new();
        for ((doc, range, body), expected) in sections.into_iter().zip(base.scopes.iter()) {
            if doc != base.document_id.0 || range != *expected {
                return Err(invalid_scope("staging の scope が登録と一致しません"));
            }
            out.push((range, body));
        }
        Ok(out)
    }

    /// Diff registered scopes against current staging (read-only). Allowed
    /// while a run is active, but the result may go stale as the agent keeps
    /// writing; always re-fetch after the run settles before approving.
    pub fn diff(
        &self,
        workspace: &Workspace,
        copy_id: &IsolatedCopyId,
    ) -> Result<Vec<IsolationDiff>, WorkspaceError> {
        let copy = self.get_active(copy_id)?;
        self.check_workspace(copy, workspace)?;
        let mut diffs = Vec::new();
        for base in &copy.bases {
            let actor = workspace.actor(&base.document_id.0)?;
            let live = actor.snapshot();
            let label = base
                .relative_path
                .clone()
                .unwrap_or_else(|| format!("{}.md", base.document_id.0));
            let staged_bytes = self.read_staging_bytes(copy, base)?;
            let staged_text =
                String::from_utf8(staged_bytes).map_err(|_| WorkspaceError::InvalidUtf8)?;
            let drifted = live.revision != base.revision || live.text != base.base_text;
            match Self::scope_replacements(base, &staged_text) {
                Ok(sections) => {
                    for (range, body) in sections {
                        let base_slice = utf16_slice(&base.base_text, &range)
                            .map_err(|error| WorkspaceError::Contract { error })?;
                        let range_label = format!("{label} [{}, {})", range.start.0, range.end.0);
                        diffs.push(IsolationDiff {
                            document_id: base.document_id.clone(),
                            path: base.relative_path.clone(),
                            range,
                            base_revision: base.revision,
                            live_revision: live.revision,
                            drifted,
                            changed: body != base_slice,
                            unified: unified_diff(&base_slice, &body, &range_label),
                            staging_chars: body.chars().count() as u32,
                            live_chars: base_slice.chars().count() as u32,
                        });
                    }
                }
                Err(error) => {
                    diffs.push(IsolationDiff {
                        document_id: base.document_id.clone(),
                        path: base.relative_path.clone(),
                        range: Utf16Range {
                            start: Utf16Offset(0),
                            end: Utf16Offset(0),
                        },
                        base_revision: base.revision,
                        live_revision: live.revision,
                        drifted,
                        changed: true,
                        unified: format!("承認できません: {error}"),
                        staging_chars: staged_text.chars().count() as u32,
                        live_chars: base.base_text.chars().count() as u32,
                    });
                }
            }
        }
        Ok(diffs)
    }

    /// List importable agent-created files as (relative path, content) pairs.
    ///
    /// Shared by review display (`staged_new_files`) and the approval-time
    /// pending capture, so the retired import record always matches what
    /// review offered: contained Markdown outside registered bases,
    /// size-capped, at most 16 entries, sorted for stable display.
    fn importable_staged_files(
        &self,
        copy: &IsolatedCopy,
    ) -> Result<Vec<(String, String)>, WorkspaceError> {
        let known: HashSet<String> = copy
            .bases
            .iter()
            .map(|base| base.staging_rel.clone())
            .collect();
        let mut out = Vec::new();
        for path in self.storage.list_staging_files(&copy.staging_dir)? {
            if !path.starts_with(&copy.staging_dir) {
                continue;
            }
            self.storage.check_no_symlink(&path, &self.staging_root)?;
            let Ok(rel) = path.strip_prefix(&copy.staging_dir) else {
                continue;
            };
            let rel_text = rel.to_string_lossy().replace('\\', "/");
            if rel_text.is_empty() || known.contains(&rel_text) {
                continue;
            }
            // Only importable Markdown survives; forbidden names are skipped
            // silently so agents cannot smuggle credentials or VCS data.
            if crate::domain::isolation::reject_forbidden_relative(&rel_text).is_err() {
                continue;
            }
            let bytes = self
                .storage
                .read_disk(&path)?
                .ok_or(WorkspaceError::NotFound)?;
            let content = String::from_utf8(bytes).map_err(|_| WorkspaceError::InvalidUtf8)?;
            if content.len() > crate::domain::ai::MAX_EXCERPT_BYTES {
                continue;
            }
            out.push((rel_text, content));
            if out.len() >= 16 {
                break;
            }
        }
        out.sort_by(|a, b| a.0.cmp(&b.0));
        Ok(out)
    }

    /// List new Markdown files the agent created inside the staging copy.
    ///
    /// Only relative contained `.md` paths not covered by registered bases are
    /// reported; `.git`/`.env`/credential names and non-Markdown files are
    /// never importable. Content is staged text, not yet applied. Allowed
    /// while a run is active but may go stale; re-fetch after settlement
    /// before importing. Rejects unknown/inactive copies and workspace
    /// mismatches without touching live buffers or disk.
    pub fn staged_new_files(
        &self,
        workspace: &Workspace,
        copy_id: &IsolatedCopyId,
    ) -> Result<Vec<crate::contracts::isolation::StagedNewFile>, WorkspaceError> {
        use crate::contracts::isolation::StagedNewFile;
        let copy = self.get_active(copy_id)?;
        self.check_workspace(copy, workspace)?;
        Ok(self
            .importable_staged_files(copy)?
            .into_iter()
            .map(|(rel, content)| StagedNewFile {
                rel,
                chars: content.chars().count() as u32,
                content,
            })
            .collect())
    }

    /// Stage a validated text proposal into the copy. Questions only display
    /// and are refused here. Single-scope rewrite/generate replaces that one
    /// scope exactly; workspace proposals carry unambiguous structured range
    /// patches (`--- marxen-patch document=<id> range=[s, e) ---`) that must
    /// match registered scopes exactly (scoped files) or valid document
    /// ranges (full documents). Malformed text, unknown IDs, stale revisions,
    /// and scope mismatches are refused with actionable errors.
    pub fn stage_proposal(
        &mut self,
        workspace: &Workspace,
        copy_id: &IsolatedCopyId,
        proposal: &ProposalText,
        mode: PromptMode,
    ) -> Result<StagedProposal, WorkspaceError> {
        if mode == PromptMode::Ask {
            return Err(invalid_scope(
                "質問への回答は表示のみです。取り込みはできません",
            ));
        }
        self.refuse_if_pinned(copy_id)?;
        // Bind the proposal to the registered scopes via base revisions.
        let staging_writes = {
            let copy = self.get_active(copy_id)?;
            self.check_workspace(copy, workspace)?;
            for base_ref in &proposal.base_contexts {
                let base = copy
                    .bases
                    .iter()
                    .find(|base| base.document_id == base_ref.document_id)
                    .ok_or(WorkspaceError::UnknownDocument)?;
                if base_ref.revision != base.revision {
                    return Err(stale(base_ref.revision, base.revision));
                }
            }
            match mode {
                PromptMode::Ask => unreachable!("refused above"),
                PromptMode::Rewrite | PromptMode::Generate => {
                    if copy.bases.len() != 1 || copy.bases[0].scopes.len() != 1 {
                        return Err(invalid_scope(
                            "書き換え・生成の取り込みは単一範囲の選択でのみ行えます",
                        ));
                    }
                    let base = &copy.bases[0];
                    if proposal.base_contexts.len() != 1
                        || proposal.base_contexts[0].document_id != base.document_id
                    {
                        return Err(invalid_scope("提案の基準文書が選択と一致しません"));
                    }
                    vec![(0usize, base.scopes[0].clone(), proposal.text.clone())]
                }
                PromptMode::Workspace => Self::parse_workspace_patches(copy, proposal)?,
            }
        };
        // Write the validated replacements into staging sections/files.
        // Full-document patches apply tail-first so earlier offsets stay valid.
        let mut updated: Vec<DocumentId> = Vec::new();
        let copy = self.get_active(copy_id)?;
        for (index, scope, body) in staging_writes.iter().rev() {
            let base = &copy.bases[*index];
            if base.full_document {
                let file = self
                    .storage
                    .guard_staging_path(&copy.staging_dir, Path::new(&base.staging_rel))?;
                self.storage.check_no_symlink(&file, &self.staging_root)?;
                let current = String::from_utf8(
                    self.storage
                        .read_disk(&file)?
                        .ok_or(WorkspaceError::NotFound)?,
                )
                .map_err(|_| WorkspaceError::InvalidUtf8)?;
                let patched = apply_patch_to_text(&current, scope, body)?;
                self.storage.write_staging(&file, patched.as_bytes())?;
            } else {
                let file = self
                    .storage
                    .guard_staging_path(&copy.staging_dir, Path::new(&base.staging_rel))?;
                self.storage.check_no_symlink(&file, &self.staging_root)?;
                let current = String::from_utf8(
                    self.storage
                        .read_disk(&file)?
                        .ok_or(WorkspaceError::NotFound)?,
                )
                .map_err(|_| WorkspaceError::InvalidUtf8)?;
                let mut sections = parse_scoped_file(&current).map_err(|detail| {
                    invalid_scope(&format!("staging の形式が壊れています: {detail}"))
                })?;
                let position = sections
                    .iter()
                    .position(|(doc, range, _)| *doc == base.document_id.0 && *range == *scope)
                    .ok_or_else(|| invalid_scope("staging の scope が登録と一致しません"))?;
                sections[position].2 = body.clone();
                let rendered = sections
                    .into_iter()
                    .map(|(_, range, text)| (range, text))
                    .collect::<Vec<_>>();
                let headered = render_scoped_sections(&base.document_id, &rendered);
                self.storage.write_staging(&file, headered.as_bytes())?;
            }
            if !updated.contains(&base.document_id) {
                updated.push(base.document_id.clone());
            }
        }
        updated.sort_by(|a, b| a.0.cmp(&b.0));
        let chars = proposal.text.chars().count() as u32;
        Ok(StagedProposal {
            copy_id: copy_id.clone(),
            updated,
            chars,
        })
    }

    /// Parse workspace-mode structured patches into (base index, scope, body).
    /// Scoped files require exact scope matches; full documents accept any
    /// valid non-overlapping ranges applied tail-first later.
    fn parse_workspace_patches(
        copy: &IsolatedCopy,
        proposal: &ProposalText,
    ) -> Result<Vec<(usize, Utf16Range, String)>, WorkspaceError> {
        let mut patches: Vec<(usize, Utf16Range, String)> = Vec::new();
        let mut current: Option<(String, Utf16Range, Vec<String>)> = None;
        let mut blocks = Vec::new();
        for (index, line) in proposal.text.split('\n').enumerate() {
            if line.starts_with(PATCH_MARK) {
                if let Some(block) = current.take() {
                    blocks.push(block);
                }
                let rest = line
                    .strip_prefix(PATCH_MARK)
                    .and_then(|rest| rest.strip_suffix(" ---"))
                    .ok_or_else(|| {
                        invalid_scope(&format!(
                            "{} 行目の patch 形式が正しくありません",
                            index + 1
                        ))
                    })?
                    .trim();
                let (doc_part, range_part) = rest.split_once(' ').ok_or_else(|| {
                    invalid_scope(&format!(
                        "{} 行目の patch 形式が正しくありません",
                        index + 1
                    ))
                })?;
                let document_id = doc_part.strip_prefix("document=").ok_or_else(|| {
                    invalid_scope(&format!(
                        "{} 行目の patch 形式が正しくありません",
                        index + 1
                    ))
                })?;
                if document_id.is_empty() {
                    return Err(invalid_scope("patch の文書 ID が空です"));
                }
                let range = parse_range_suffix(range_part).ok_or_else(|| {
                    invalid_scope(&format!(
                        "{} 行目の patch 範囲が正しくありません",
                        index + 1
                    ))
                })?;
                if range.start.0 > range.end.0 {
                    return Err(WorkspaceError::Contract {
                        error: ContractError::ReversedRange,
                    });
                }
                current = Some((document_id.to_owned(), range, Vec::new()));
            } else if let Some((_, _, body)) = current.as_mut() {
                body.push(line.to_owned());
            } else if line.trim().is_empty() {
                continue;
            } else {
                return Err(invalid_scope("patch ブロックの外に本文があります"));
            }
        }
        if let Some(block) = current.take() {
            blocks.push(block);
        }
        // The proposal's own trailing newline leaves one phantom empty line
        // on the final block; drop it exactly like scoped sections do.
        if let Some((_, _, body)) = blocks.last_mut() {
            if body.last().is_some_and(|line| line.is_empty()) {
                body.pop();
            }
        }
        if blocks.is_empty() {
            return Err(invalid_scope("workspace 提案に patch ブロックがありません"));
        }
        for (document_id, range, body_lines) in blocks {
            // Patch bodies are agent-authored lines: a non-empty body always
            // ends with exactly one newline, matching the usual shape of
            // replaced source lines. (Scoped staging sections use the
            // stricter render/strip rule so unedited sections round-trip.)
            let body = if body_lines.is_empty() {
                String::new()
            } else {
                let mut joined = body_lines.join("\n");
                joined.push('\n');
                joined
            };
            let position = copy
                .bases
                .iter()
                .position(|base| base.document_id.0 == document_id)
                .ok_or(WorkspaceError::UnknownDocument)?;
            let base = &copy.bases[position];
            let bound = proposal
                .base_contexts
                .iter()
                .find(|bound| bound.document_id.0 == document_id)
                .ok_or_else(|| invalid_scope("提案の基準にない文書への patch です"))?;
            if bound.revision != base.revision {
                return Err(stale(bound.revision, base.revision));
            }
            if base.full_document {
                utf16_slice(&base.base_text, &range)
                    .map_err(|error| WorkspaceError::Contract { error })?;
            } else if !base.scopes.contains(&range) {
                return Err(invalid_scope("patch 範囲が登録した選択範囲と一致しません"));
            }
            patches.push((position, range, body));
        }
        // Same-document overlaps refuse; ordering keeps file writes stable.
        patches.sort_by_key(|(index, range, _)| (*index, range.start.0, range.end.0));
        for pair in patches.windows(2) {
            if pair[0].0 == pair[1].0
                && (pair[1].1.start.0 < pair[0].1.end.0 || pair[1].1.start.0 <= pair[0].1.start.0)
            {
                return Err(WorkspaceError::Contract {
                    error: ContractError::OverlappingEdits,
                });
            }
        }
        Ok(patches)
    }

    /// Apply approved staging as Ai range patches via the Neovim actor.
    /// Preflights every document with the native-ready actor (pending input
    /// refused, real Vim drift synced, revision and ranges checked, text and
    /// Undo untouched) before touching any buffer. Apply-phase failures
    /// return structured per-document outcomes with best-effort native-Undo
    /// rollback; the copy is then consumed so a partial state can never be
    /// mistaken for all-or-nothing. Does not write disk; saving stays in the
    /// shared save contract.
    pub fn approve(
        &mut self,
        workspace: &Workspace,
        copy_id: &IsolatedCopyId,
    ) -> Result<ApproveResult, WorkspaceError> {
        self.refuse_if_pinned(copy_id)?;
        // Read all staging first (shared borrow).
        let staged: Vec<String> = {
            let copy = self.get_active(copy_id)?;
            self.check_workspace(copy, workspace)?;
            let mut staged = Vec::new();
            for base in &copy.bases {
                let bytes = self.read_staging_bytes(copy, base)?;
                staged.push(String::from_utf8(bytes).map_err(|_| WorkspaceError::InvalidUtf8)?);
            }
            staged
        };
        // Capture importable new files with their authoritative content before
        // any mutation: a listing failure refuses approval here with its detail,
        // never silently approving while losing the new-file capture.
        let pending_imports: HashMap<String, String> = {
            let copy = self.get_active(copy_id)?;
            self.importable_staged_files(copy)?.into_iter().collect()
        };

        struct Plan {
            index: usize,
            edits: Vec<TextEdit>,
            live: DocumentSnapshot,
        }
        // Preflight every document through the native-ready actor before any
        // mutation. Unchanged documents are preflighted too, so hidden Vim
        // drift anywhere refuses without touching the first document.
        let plans: Vec<Plan> = {
            let copy = self.get_active(copy_id)?;
            let mut plans = Vec::new();
            for (index, base) in copy.bases.iter().enumerate() {
                let actor: &DocumentActor = workspace.actor(&base.document_id.0)?;
                let sections = Self::scope_replacements(base, &staged[index])?;
                let mut edits = Vec::new();
                if base.full_document {
                    if let Some(edit) = minimal_edit(&base.base_text, &staged[index]) {
                        edits.push(edit);
                    }
                } else {
                    for (range, body) in sections {
                        let base_slice = utf16_slice(&base.base_text, &range)
                            .map_err(|error| WorkspaceError::Contract { error })?;
                        if body != base_slice {
                            edits.push(TextEdit { range, text: body });
                        }
                    }
                }
                let live = actor
                    .preflight_edits(&EditRequest {
                        document_id: base.document_id.clone(),
                        base_revision: base.revision,
                        source: EditSource::Ai,
                        edits: edits.clone(),
                    })
                    .map_err(WorkspaceError::from)?;
                if live.revision != base.revision || live.text != base.base_text {
                    return Err(stale(base.revision, live.revision));
                }
                if let Some(path) = actor.path().as_ref() {
                    let current_disk = self.storage.disk_fingerprint(path)?;
                    if current_disk != base.base_disk {
                        return Err(WorkspaceError::Conflict {
                            path: path.display().to_string(),
                        });
                    }
                }
                plans.push(Plan { index, edits, live });
            }
            plans
        };

        // Apply sequentially; one native Undo step per document.
        let mut outcomes: Vec<ApproveDocOutcome> = Vec::new();
        let mut applied_indices: Vec<usize> = Vec::new();
        let mut failed = false;
        {
            let copy = self.get_active(copy_id)?;
            for plan in &plans {
                let base = &copy.bases[plan.index];
                if plan.edits.is_empty() {
                    outcomes.push(ApproveDocOutcome {
                        document_id: base.document_id.clone(),
                        applied: false,
                        revision: plan.live.revision,
                        error: None,
                        rolled_back: false,
                        rollback_error: None,
                    });
                    continue;
                }
                if failed {
                    outcomes.push(ApproveDocOutcome {
                        document_id: base.document_id.clone(),
                        applied: false,
                        revision: plan.live.revision,
                        error: Some("先行文書の適用失敗のため未適用です".into()),
                        rolled_back: false,
                        rollback_error: None,
                    });
                    continue;
                }
                let actor = workspace.actor(&base.document_id.0)?;
                // Explicit test-support fault (never armed in production):
                // deterministic apply-phase failure after preflight and any
                // earlier applies, exercising the partial-outcome path.
                let fault = self.apply_fault_for_tests.as_ref() == Some(&base.document_id.0);
                let applied = if fault {
                    Err(WorkspaceError::Neovim {
                        detail: "injected apply failure for tests".into(),
                    })
                } else {
                    actor
                        .apply_edits(EditRequest {
                            document_id: base.document_id.clone(),
                            base_revision: plan.live.revision,
                            source: EditSource::Ai,
                            edits: plan.edits.clone(),
                        })
                        .map_err(WorkspaceError::from)
                };
                match applied {
                    Ok(next) => {
                        applied_indices.push(plan.index);
                        outcomes.push(ApproveDocOutcome {
                            document_id: base.document_id.clone(),
                            applied: true,
                            revision: next.revision,
                            error: None,
                            rolled_back: false,
                            rollback_error: None,
                        });
                    }
                    Err(detail) => {
                        failed = true;
                        outcomes.push(ApproveDocOutcome {
                            document_id: base.document_id.clone(),
                            applied: false,
                            revision: plan.live.revision,
                            error: Some(format!("{detail:?}")),
                            rolled_back: false,
                            rollback_error: None,
                        });
                    }
                }
            }
        }

        // Best-effort native-Undo rollback of what was applied, so live text
        // returns to the pre-approval state. Rollback failures are explicit.
        if failed {
            let copy = self.get_active(copy_id)?;
            for outcome in outcomes.iter_mut() {
                let position = copy
                    .bases
                    .iter()
                    .position(|base| base.document_id == outcome.document_id);
                let Some(position) = position else {
                    continue;
                };
                if !applied_indices.contains(&position) {
                    continue;
                }
                let base = &copy.bases[position];
                let actor = workspace.actor(&base.document_id.0)?;
                match actor.undo() {
                    Ok(restored) => {
                        outcome.rolled_back = restored.text == base.base_text;
                        outcome.revision = restored.revision;
                        if !outcome.rolled_back {
                            outcome.rollback_error =
                                Some("Undo 後の本文が承認前と一致しません".into());
                        }
                    }
                    Err(error) => {
                        let detail: WorkspaceError = error.into();
                        outcome.rollback_error = Some(format!("{detail:?}"));
                    }
                }
            }
            self.consume(copy_id, CopyStatus::Failed);
        } else {
            // Remember the original workspace root with the new files captured
            // before any mutation above, so staged new-file imports stay bound
            // to the approving workspace even after the copy is gone; a later
            // folder switch cannot redirect them elsewhere.
            if let Some(copy) = self.copies.get(&copy_id.0) {
                self.retired_imports.insert(
                    copy_id.0.clone(),
                    RetiredCopy {
                        scope: copy.scope.clone(),
                        root: copy.workspace_root.clone(),
                        pending: pending_imports,
                    },
                );
            }
            self.consume(copy_id, CopyStatus::Approved);
        }
        // Order outcomes by document for stable review display.
        outcomes.sort_by(|a, b| a.document_id.0.cmp(&b.document_id.0));
        Ok(ApproveResult {
            copy_id: copy_id.clone(),
            outcomes,
        })
    }

    /// Import staged new files into the approved copy's original workspace.
    ///
    /// Imports run only after approval: an active copy is refused with
    /// `InvalidPath` before any file is created, even when the workspace
    /// still matches. The approved copy's recorded workspace root is checked
    /// under the caller's workspace lock, so a folder switch since approval
    /// fails with `OutsideWorkspace` before any file is created. Each file
    /// must name a still-pending staged path with content exactly equal to
    /// the authoritative capture: unknown, already-imported, forbidden, and
    /// content-drifted requests are refused per file without touching live
    /// files, so callers can neither invent unstaged paths nor alter approved
    /// content. Successes carry the opened snapshot for session registration
    /// and drain the pending set. Continues per file so one refusal never
    /// hides the rest. Empty requests retain the record; the record clears
    /// only once a non-empty request drains every pending file with all
    /// outcomes successful, so unfinished imports stay retryable and retries
    /// never reapply document edits. Unknown copies never import.
    pub fn import_new_files(
        &mut self,
        workspace: &mut Workspace,
        copy_id: &IsolatedCopyId,
        files: &[crate::contracts::isolation::ImportFileRequest],
    ) -> Result<Vec<crate::contracts::isolation::StagedImportOutcome>, WorkspaceError> {
        use crate::contracts::isolation::StagedImportOutcome;
        validate_copy_id_string(&copy_id.0)?;
        if files.len() > 16 {
            return Err(WorkspaceError::InvalidPath);
        }
        // Active copies must approve first: refuse before any file mutation.
        if self.copies.contains_key(&copy_id.0) {
            return Err(WorkspaceError::InvalidPath);
        }
        let root = self
            .retired_imports
            .get(&copy_id.0)
            .map(|record| record.root.clone())
            .ok_or(WorkspaceError::NotFound)?;
        if workspace.root() != root.as_path() {
            return Err(WorkspaceError::OutsideWorkspace);
        }
        if self
            .retired_imports
            .get(&copy_id.0)
            .is_some_and(|record| &record.scope != workspace.scope())
        {
            return Err(WorkspaceError::StaleRoot);
        }
        if files.is_empty() {
            return Ok(Vec::new());
        }
        let mut outcomes = Vec::with_capacity(files.len());
        let mut succeeded = Vec::new();
        for file in files {
            if crate::domain::isolation::reject_forbidden_relative(&file.rel).is_err() {
                outcomes.push(StagedImportOutcome {
                    rel: file.rel.clone(),
                    snapshot: None,
                    error: Some(format!("{:?}", WorkspaceError::NotMarkdown)),
                });
                continue;
            }
            // Validate against the Rust-owned capture before any mutation:
            // only still-pending staged paths with unaltered content import.
            let approved = self
                .retired_imports
                .get(&copy_id.0)
                .and_then(|record| record.pending.get(&file.rel))
                .cloned();
            let Some(approved) = approved else {
                outcomes.push(StagedImportOutcome {
                    rel: file.rel.clone(),
                    snapshot: None,
                    error: Some(format!("{:?}", WorkspaceError::InvalidPath)),
                });
                continue;
            };
            if approved != file.content {
                outcomes.push(StagedImportOutcome {
                    rel: file.rel.clone(),
                    snapshot: None,
                    error: Some("staged content differs from the approved copy".into()),
                });
                continue;
            }
            match workspace.create(&file.rel, &file.content) {
                Ok(opened) => {
                    succeeded.push(file.rel.clone());
                    outcomes.push(StagedImportOutcome {
                        rel: file.rel.clone(),
                        snapshot: Some(opened.snapshot),
                        error: None,
                    });
                }
                Err(error) => outcomes.push(StagedImportOutcome {
                    rel: file.rel.clone(),
                    snapshot: None,
                    error: Some(format!("{error:?}")),
                }),
            }
        }
        // Drain only the pending files this request imported.
        if let Some(record) = self.retired_imports.get_mut(&copy_id.0) {
            for rel in &succeeded {
                record.pending.remove(rel);
            }
        }
        // Clear only once every pending file drained on a fully successful
        // request: empty calls and successful subsets retain the record.
        let drained = self
            .retired_imports
            .get(&copy_id.0)
            .is_some_and(|record| record.pending.is_empty());
        if drained && outcomes.iter().all(|outcome| outcome.error.is_none()) {
            self.retired_imports.remove(&copy_id.0);
        }
        Ok(outcomes)
    }

    /// Remove a settled copy and its staging directory after recording the review outcome.
    fn consume(&mut self, copy_id: &IsolatedCopyId, status: CopyStatus) {
        if let Some(copy) = self.copies.get_mut(&copy_id.0) {
            copy.status = status;
            let dir = copy.staging_dir.clone();
            if dir.starts_with(&self.staging_root) && dir != self.staging_root {
                let _ = self.storage.remove_staging(&dir);
            }
        }
        self.copies.remove(&copy_id.0);
        self.pins.remove(&copy_id.0);
    }

    /// Reject removal while pinned, then discard a guarded copy without editing live documents.
    fn forget(
        &mut self,
        copy_id: &IsolatedCopyId,
        status: CopyStatus,
    ) -> Result<(), WorkspaceError> {
        self.refuse_if_pinned(copy_id)?;
        let copy = self.get_active_mut(copy_id)?;
        copy.status = status;
        let dir = copy.staging_dir.clone();
        // Guard the removal: only inside our staging root.
        if dir.starts_with(&self.staging_root) && dir != self.staging_root {
            let _ = self.storage.remove_staging(&dir);
        }
        self.copies.remove(&copy_id.0);
        Ok(())
    }

    /// Discard staging after review; live buffers and disk stay exact.
    pub fn reject(&mut self, copy_id: &IsolatedCopyId) -> Result<(), WorkspaceError> {
        self.forget(copy_id, CopyStatus::Rejected)
    }

    /// Cancel a pending copy; same guarantee as reject. A bare cancellation
    /// request never settles a live run: pins release only in the run's own
    /// settlement path, so cancel-while-running is refused until reap.
    pub fn cancel(&mut self, copy_id: &IsolatedCopyId) -> Result<(), WorkspaceError> {
        self.forget(copy_id, CopyStatus::Cancelled)
    }
}
