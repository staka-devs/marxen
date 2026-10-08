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

use crate::ai_contracts::{IsolatedCopyId, PromptContext, PromptMode, ProposalText};
use crate::contracts::{
    ContractError, DocumentId, DocumentSnapshot, EditRequest, EditSource, Revision, TextEdit,
    Utf16Offset, Utf16Range, WorkspaceError,
};
use crate::document::DocumentActor;
use crate::storage::{self, Fingerprint};
use crate::workspace::Workspace;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use ts_rs::TS;

/// One document captured into an isolated copy, with its registered scopes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IsolatedCopyDoc {
    pub document_id: DocumentId,
    pub revision: Revision,
    pub path: Option<String>,
    pub ranges: Vec<Utf16Range>,
    pub full_document: bool,
}

/// Created copy handle returned to the AI panel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IsolatedCopyInfo {
    pub copy_id: IsolatedCopyId,
    pub documents: Vec<IsolatedCopyDoc>,
}

/// Reviewable diff of one registered scope: base slice vs staged section.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IsolationDiff {
    pub document_id: DocumentId,
    pub path: Option<String>,
    pub range: Utf16Range,
    pub base_revision: Revision,
    pub live_revision: Revision,
    /// Live buffer moved since the copy; approve will refuse until resync.
    pub drifted: bool,
    pub changed: bool,
    pub unified: String,
    pub staging_chars: u32,
    pub live_chars: u32,
}

/// Per-document outcome of an approval. Apply-phase failures never imply
/// all-or-nothing: each entry states what happened, including rollback.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApproveDocOutcome {
    pub document_id: DocumentId,
    pub applied: bool,
    pub revision: Revision,
    pub error: Option<String>,
    pub rolled_back: bool,
    pub rollback_error: Option<String>,
}

/// Structured approval result across all documents in the copy.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApproveResult {
    pub copy_id: IsolatedCopyId,
    pub outcomes: Vec<ApproveDocOutcome>,
}

/// Result of staging a validated text proposal into a copy.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StagedProposal {
    pub copy_id: IsolatedCopyId,
    pub updated: Vec<DocumentId>,
    pub chars: u32,
}

pub fn typescript() -> String {
    let cfg = ts_rs::Config::default();
    let declarations = [
        IsolatedCopyDoc::decl(&cfg),
        IsolatedCopyInfo::decl(&cfg),
        IsolationDiff::decl(&cfg),
        ApproveDocOutcome::decl(&cfg),
        ApproveResult::decl(&cfg),
        StagedProposal::decl(&cfg),
    ];
    let mut output = "// Generated from src-tauri/src/isolation.rs. Run npm run isolation-contracts:generate.\n// Do not edit by hand. Isolation IPC schema version 2.\n".to_owned();
    output.push_str("import type { DocumentId, Revision, Utf16Range } from \"./contracts\";\n");
    output.push_str("import type { IsolatedCopyId } from \"./ai-contracts\";\n");
    for declaration in declarations {
        output.push_str("export ");
        output.push_str(&declaration);
        output.push('\n');
    }
    output
        .lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n")
        + "\n"
}

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
    workspace_root: PathBuf,
    staging_dir: PathBuf,
    bases: Vec<CopyBase>,
    status: CopyStatus,
}

/// Owner of staging directories. One manager serves all workspaces; each copy
/// records its own workspace root and is validated against it on every call.
/// `pins` counts live runs (ACP process or HTTP stream) per copy; pinned
/// copies refuse approve/reject/cancel until the run settles and releases.
pub struct IsolationManager {
    staging_root: PathBuf,
    next: u64,
    copies: HashMap<String, IsolatedCopy>,
    pins: HashMap<String, u32>,
    /// Explicit test-support configuration: when set, that document's apply
    /// fails deterministically AFTER native preflight and any earlier
    /// applies, so tests exercise partial outcomes and rollback. Production
    /// IPC paths never set this; it exists so tests need no global env var.
    apply_fault_for_tests: Option<String>,
}

impl IsolationManager {
    /// Arm a deterministic apply-phase failure for one document id. Test
    /// support only: no production path calls this.
    pub fn inject_apply_failure_for_tests(&mut self, document_id: Option<DocumentId>) {
        self.apply_fault_for_tests = document_id.map(|id| id.0);
    }
}

pub fn validate_copy_id_string(id: &str) -> Result<(), WorkspaceError> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(WorkspaceError::InvalidPath);
    }
    Ok(())
}

/// Join a relative candidate under root without escapes, devices, or links.
pub fn guard_staging_path(root: &Path, candidate: &Path) -> Result<PathBuf, WorkspaceError> {
    if root.as_os_str().is_empty() {
        return Err(WorkspaceError::InvalidPath);
    }
    let mut normalized = PathBuf::new();
    for component in candidate.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    return Err(WorkspaceError::OutsideWorkspace);
                }
            }
            Component::Normal(part) => normalized.push(part),
            Component::RootDir | Component::Prefix(_) => {
                return Err(WorkspaceError::OutsideWorkspace);
            }
        }
    }
    if normalized.as_os_str().is_empty() {
        return Err(WorkspaceError::InvalidPath);
    }
    let joined = root.join(&normalized);
    if !joined.starts_with(root) {
        return Err(WorkspaceError::OutsideWorkspace);
    }
    Ok(joined)
}

fn check_no_symlink(path: &Path, root: &Path) -> Result<(), WorkspaceError> {
    // Every existing prefix must be a real directory inside root, never a link.
    let mut current = root.to_owned();
    // Validate the root itself once.
    if fs::symlink_metadata(&current)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err(WorkspaceError::OutsideWorkspace);
    }
    if let Ok(rel) = path.strip_prefix(root) {
        for part in rel.components() {
            if let Component::Normal(name) = part {
                current.push(name);
                match fs::symlink_metadata(&current) {
                    Ok(meta) => {
                        if meta.file_type().is_symlink() {
                            return Err(WorkspaceError::OutsideWorkspace);
                        }
                        if current != path && !meta.is_dir() && meta.is_file() {
                            // Intermediate file where a directory is expected.
                            return Err(WorkspaceError::InvalidPath);
                        }
                        if fs::canonicalize(&current)
                            .map(|p| !p.starts_with(root))
                            .unwrap_or(true)
                            && meta.is_dir()
                        {
                            // Canonical check for junctions/reparse points.
                            return Err(WorkspaceError::OutsideWorkspace);
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                        // Missing suffix is fine; remaining components are new.
                        break;
                    }
                    Err(e) => return Err(e.into()),
                }
            }
        }
    }
    Ok(())
}

fn utf16_len(text: &str) -> u32 {
    u32::try_from(text.encode_utf16().count()).unwrap_or(u32::MAX)
}

fn utf16_slice(text: &str, range: &Utf16Range) -> Result<String, ContractError> {
    let start = crate::validation::utf16_to_utf8(text, range.start)?.0 as usize;
    let end = crate::validation::utf16_to_utf8(text, range.end)?.0 as usize;
    Ok(text[start..end].to_owned())
}

/// Reject staging names outside the selected Markdown scope: .git, .env,
/// reserved transfer files, and non-Markdown writes are never applied.
fn reject_forbidden_relative(rel: &str) -> Result<(), WorkspaceError> {
    let path = Path::new(rel);
    for part in path.components() {
        let name = match part {
            Component::Normal(name) => name.to_string_lossy().to_ascii_lowercase(),
            _ => return Err(WorkspaceError::OutsideWorkspace),
        };
        if name == ".git"
            || name == ".env"
            || name.starts_with(".marxen-")
            || name == "credentials"
            || name == ".credentials"
        {
            return Err(WorkspaceError::OutsideWorkspace);
        }
    }
    if !storage::markdown(path) {
        return Err(WorkspaceError::NotMarkdown);
    }
    Ok(())
}

fn stale(received: Revision, expected: Revision) -> WorkspaceError {
    WorkspaceError::Contract {
        error: ContractError::StaleRevision { expected, received },
    }
}

fn invalid_scope(detail: &str) -> WorkspaceError {
    WorkspaceError::Io {
        detail: detail.to_owned(),
    }
}

/// Validate one context against the authoritative snapshot: revision match,
/// ordered non-overlapping ranges with surrogate-safe boundaries, and an
/// excerpt that exactly equals the concatenated source slices.
fn validate_context_against_snapshot(
    snapshot: &DocumentSnapshot,
    context: &PromptContext,
) -> Result<(), WorkspaceError> {
    if snapshot.revision != context.revision {
        return Err(stale(context.revision, snapshot.revision));
    }
    if context.text.len() > crate::ai::MAX_EXCERPT_BYTES {
        return Err(WorkspaceError::InvalidPath);
    }
    if context.ranges.is_empty() || context.ranges.len() > crate::ai::MAX_RANGES_PER_CONTEXT {
        return Err(WorkspaceError::InvalidPath);
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
        let slice = utf16_slice(&snapshot.text, range)
            .map_err(|error| WorkspaceError::Contract { error })?;
        assembled.push_str(&slice);
        previous = Some(range);
    }
    if assembled != context.text {
        return Err(invalid_scope("送信抜粋が原文の選択範囲と一致しません"));
    }
    Ok(())
}

// ---- Scoped staging file format ----
//
// Scoped files carry one section per registered range so the agent only ever
// sees selected text. Full-document copies (a single explicitly selected
// [0, len) range) are stored as raw Markdown with no headers.
// A document line that happens to look like a header can never match the
// registered scopes, so it fails closed at parse time instead of aliasing.

const SCOPE_MARK: &str = "--- marxen-scope";
const PATCH_MARK: &str = "--- marxen-patch";

fn scope_header(document_id: &DocumentId, range: &Utf16Range) -> String {
    format!(
        "--- marxen-scope document={} range=[{}, {}) ---",
        document_id.0, range.start.0, range.end.0
    )
}

fn parse_range_suffix(text: &str) -> Option<Utf16Range> {
    let (start, end) = text
        .strip_prefix("range=[")?
        .strip_suffix(")")?
        .split_once(", ")?;
    Some(Utf16Range {
        start: Utf16Offset(start.parse().ok()?),
        end: Utf16Offset(end.parse().ok()?),
    })
}

fn parse_scope_header(line: &str) -> Option<(String, Utf16Range)> {
    let rest = line.strip_prefix(SCOPE_MARK)?.strip_suffix(" ---")?.trim();
    let (doc_part, range_part) = rest.split_once(' ')?;
    let document_id = doc_part.strip_prefix("document=")?.to_owned();
    if document_id.is_empty() {
        return None;
    }
    Some((document_id, parse_range_suffix(range_part)?))
}

/// Split a scoped file into (document, range, body) sections. Bodies use the
/// render rule: sections are header + slice + exactly one added newline, so
/// parsing strips exactly one trailing newline from non-empty bodies.
fn parse_scoped_file(text: &str) -> Result<Vec<(String, Utf16Range, String)>, String> {
    let mut sections = Vec::new();
    let mut current: Option<(String, Utf16Range, Vec<String>)> = None;
    for (index, line) in text.split('\n').enumerate() {
        if line.starts_with(SCOPE_MARK) {
            if let Some((doc, range, body)) = current.take() {
                sections.push((doc, range, join_body(body)));
            }
            let (doc, range) = parse_scope_header(line)
                .ok_or_else(|| format!("{} 行目の scope 形式が正しくありません", index + 1))?;
            current = Some((doc, range, Vec::new()));
        } else if let Some((_, _, body)) = current.as_mut() {
            body.push(line.to_owned());
        } else {
            return Err(format!(
                "先頭が scope ヘッダーではありません ({} 行目)",
                index + 1
            ));
        }
    }
    if let Some((doc, range, body)) = current.take() {
        // A rendered file always ends with a newline, leaving one empty
        // trailing line from the final split; drop it before joining.
        let mut body = body;
        if body.last().is_some_and(|line| line.is_empty()) {
            body.pop();
        }
        sections.push((doc, range, join_body(body)));
    }
    if sections.is_empty() {
        return Err("scope が一つもありません".into());
    }
    Ok(sections)
}

fn join_body(lines: Vec<String>) -> String {
    if lines.is_empty() {
        return String::new();
    }
    let mut out = lines.join("\n");
    out.push('\n');
    // Render added exactly one newline after the slice; remove it so an
    // unedited section round-trips to the registered slice exactly.
    out.strip_suffix('\n').unwrap_or(&out).to_owned()
}

fn render_scoped_file(document_id: &DocumentId, scopes: &[(Utf16Range, String)]) -> String {
    let mut out = String::new();
    for (range, slice) in scopes {
        out.push_str(&scope_header(document_id, range));
        out.push('\n');
        out.push_str(slice);
        out.push('\n');
    }
    out
}

/// Minimal single range patch turning `base` into `staging`, preserving all
/// bytes outside the differing span (BOM/CRLF/spacing stay exact). Returns
/// None when the texts are equal.
fn minimal_edit(base: &str, staging: &str) -> Option<TextEdit> {
    if base == staging {
        return None;
    }
    let base_bytes = base.as_bytes();
    let staging_bytes = staging.as_bytes();
    let mut prefix = 0usize;
    while prefix < base_bytes.len()
        && prefix < staging_bytes.len()
        && base_bytes[prefix] == staging_bytes[prefix]
    {
        prefix += 1;
    }
    while prefix > 0 && !base.is_char_boundary(prefix) {
        prefix -= 1;
    }
    let mut suffix = 0usize;
    while suffix < base_bytes.len() - prefix
        && suffix < staging_bytes.len() - prefix
        && base_bytes[base_bytes.len() - 1 - suffix]
            == staging_bytes[staging_bytes.len() - 1 - suffix]
    {
        suffix += 1;
    }
    while suffix > 0
        && (!base.is_char_boundary(base_bytes.len() - suffix)
            || !staging.is_char_boundary(staging_bytes.len() - suffix))
    {
        suffix -= 1;
    }
    let start =
        crate::validation::utf8_to_utf16(base, crate::contracts::Utf8ByteOffset(prefix as u32))
            .ok()?;
    let end = crate::validation::utf8_to_utf16(
        base,
        crate::contracts::Utf8ByteOffset((base_bytes.len() - suffix) as u32),
    )
    .ok()?;
    Some(TextEdit {
        range: Utf16Range { start, end },
        text: staging[prefix..staging_bytes.len() - suffix].to_owned(),
    })
}

/// Minimal line diff: common prefix/suffix lines, middle as -/+ block.
pub fn unified_diff(live_text: &str, staging_text: &str, label: &str) -> String {
    if live_text == staging_text {
        return format!("--- live:{label}\n+++ staging:{label}\n (変更なし)\n");
    }
    let live_lines: Vec<&str> = live_text.split('\n').collect();
    let staging_lines: Vec<&str> = staging_text.split('\n').collect();
    let mut prefix = 0usize;
    while prefix < live_lines.len()
        && prefix < staging_lines.len()
        && live_lines[prefix] == staging_lines[prefix]
    {
        prefix += 1;
    }
    let mut suffix = 0usize;
    while suffix < live_lines.len() - prefix
        && suffix < staging_lines.len() - prefix
        && live_lines[live_lines.len() - 1 - suffix]
            == staging_lines[staging_lines.len() - 1 - suffix]
    {
        suffix += 1;
    }
    let mut out = format!("--- live:{label}\n+++ staging:{label}\n");
    for (i, line) in live_lines.iter().enumerate() {
        if i < prefix || i >= live_lines.len() - suffix {
            continue;
        }
        out.push('-');
        out.push_str(line);
        out.push('\n');
    }
    for (i, line) in staging_lines.iter().enumerate() {
        if i < prefix || i >= staging_lines.len() - suffix {
            continue;
        }
        out.push('+');
        out.push_str(line);
        out.push('\n');
    }
    out
}

impl IsolationManager {
    pub fn open(staging_root: &Path) -> Result<Self, WorkspaceError> {
        fs::create_dir_all(staging_root)?;
        let staging_root = fs::canonicalize(staging_root)?;
        if !staging_root.is_dir() {
            return Err(WorkspaceError::InvalidPath);
        }
        if fs::symlink_metadata(&staging_root)?
            .file_type()
            .is_symlink()
        {
            return Err(WorkspaceError::OutsideWorkspace);
        }
        Ok(Self {
            staging_root,
            next: 1,
            copies: HashMap::new(),
            pins: HashMap::new(),
            apply_fault_for_tests: None,
        })
    }

    /// Default staging under the OS temp dir (desktop runtime).
    pub fn open_default() -> Result<Self, WorkspaceError> {
        let root = std::env::temp_dir().join("marxen-staging");
        Self::open(&root)
    }

    pub fn staging_root(&self) -> &Path {
        &self.staging_root
    }

    fn new_copy_id(&mut self) -> IsolatedCopyId {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let id = format!("copy_{nanos:x}_{}", self.next);
        self.next += 1;
        IsolatedCopyId(id)
    }

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

    fn pinned(&self, copy_id: &IsolatedCopyId) -> bool {
        self.pins.get(&copy_id.0).is_some_and(|count| *count > 0)
    }

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
        if contexts.is_empty() || contexts.len() > crate::ai::MAX_CONTEXTS {
            return Err(WorkspaceError::InvalidPath);
        }
        // Group by document; contradictory duplicates (different revisions for
        // the same document) are refused below.
        let mut order: Vec<String> = Vec::new();
        let mut grouped: HashMap<String, Vec<&PromptContext>> = HashMap::new();
        for context in contexts {
            crate::validation::validate_document_id(&context.document_id)
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
        let staging_dir = guard_staging_path(&self.staging_root, Path::new(&copy_id.0))?;
        if staging_dir.exists() {
            return Err(WorkspaceError::AlreadyExists);
        }
        fs::create_dir_all(&staging_dir)?;
        check_no_symlink(&staging_dir, &self.staging_root)?;
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
                    Some(path) => storage::disk_fingerprint(path)?,
                    None => None,
                };
                let staging_rel = match &relative_path {
                    Some(rel) => rel.clone(),
                    None => format!("{doc_key}.md"),
                };
                let staging_file = guard_staging_path(&staging_dir, Path::new(&staging_rel))?;
                check_no_symlink(&staging_file, &self.staging_root)?;
                if let Some(parent) = staging_file.parent() {
                    fs::create_dir_all(parent)?;
                }
                if fs::symlink_metadata(&staging_file).is_ok() {
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
                fs::write(&staging_file, &staged_bytes)?;
                check_no_symlink(&staging_file, &self.staging_root)?;
                bases.push(CopyBase {
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
                let _ = fs::remove_dir_all(&staging_dir);
                return Err(error);
            }
        };

        self.copies.insert(
            copy_id.0.clone(),
            IsolatedCopy {
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
        let dir = guard_staging_path(&self.staging_root, Path::new(&copy_id.0))?;
        if dir != copy.staging_dir {
            return Err(WorkspaceError::OutsideWorkspace);
        }
        check_no_symlink(&dir, &self.staging_root)?;
        // Junction/ADS detours surface here even when names look contained.
        if fs::canonicalize(&dir)
            .map(|canonical| canonical != dir)
            .unwrap_or(true)
            && dir.is_dir()
        {
            let canonical = fs::canonicalize(&dir)?;
            if !canonical.starts_with(&self.staging_root) {
                return Err(WorkspaceError::OutsideWorkspace);
            }
        }
        if !dir.is_dir() {
            return Err(WorkspaceError::NotFound);
        }
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
        request: &crate::ai_contracts::AiPromptRequest,
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
                    return Err(invalid_scope("送信抜粋が原文の選択範囲と一致しません"));
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

    fn read_staging_bytes(
        &self,
        copy: &IsolatedCopy,
        base: &CopyBase,
    ) -> Result<Vec<u8>, WorkspaceError> {
        let file = guard_staging_path(&copy.staging_dir, Path::new(&base.staging_rel))?;
        if !file.starts_with(&copy.staging_dir) {
            return Err(WorkspaceError::OutsideWorkspace);
        }
        check_no_symlink(&file, &self.staging_root)?;
        let bytes = storage::read_disk(&file)?.ok_or(WorkspaceError::NotFound)?;
        check_no_symlink(&file, &self.staging_root)?;
        Ok(bytes)
    }

    fn check_workspace(
        &self,
        copy: &IsolatedCopy,
        workspace: &Workspace,
    ) -> Result<(), WorkspaceError> {
        if workspace.root() != copy.workspace_root {
            return Err(WorkspaceError::OutsideWorkspace);
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
                let file = guard_staging_path(&copy.staging_dir, Path::new(&base.staging_rel))?;
                check_no_symlink(&file, &self.staging_root)?;
                let current =
                    String::from_utf8(storage::read_disk(&file)?.ok_or(WorkspaceError::NotFound)?)
                        .map_err(|_| WorkspaceError::InvalidUtf8)?;
                let patched = apply_patch_to_text(&current, scope, body)?;
                fs::write(&file, patched.as_bytes())?;
            } else {
                let file = guard_staging_path(&copy.staging_dir, Path::new(&base.staging_rel))?;
                check_no_symlink(&file, &self.staging_root)?;
                let current =
                    String::from_utf8(storage::read_disk(&file)?.ok_or(WorkspaceError::NotFound)?)
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
                fs::write(&file, headered.as_bytes())?;
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
                    let current_disk = storage::disk_fingerprint(path)?;
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
            self.consume(copy_id, CopyStatus::Approved);
        }
        // Order outcomes by document for stable review display.
        outcomes.sort_by(|a, b| a.document_id.0.cmp(&b.document_id.0));
        Ok(ApproveResult {
            copy_id: copy_id.clone(),
            outcomes,
        })
    }

    fn consume(&mut self, copy_id: &IsolatedCopyId, status: CopyStatus) {
        if let Some(copy) = self.copies.get_mut(&copy_id.0) {
            copy.status = status;
            let dir = copy.staging_dir.clone();
            if dir.starts_with(&self.staging_root) && dir != self.staging_root {
                let _ = fs::remove_dir_all(&dir);
            }
        }
        self.copies.remove(&copy_id.0);
        self.pins.remove(&copy_id.0);
    }

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
            let _ = fs::remove_dir_all(&dir);
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

/// Apply one validated replacement to raw full-document text.
fn apply_patch_to_text(
    current: &str,
    range: &Utf16Range,
    body: &str,
) -> Result<String, WorkspaceError> {
    let start = crate::validation::utf16_to_utf8(current, range.start)
        .map_err(|error| WorkspaceError::Contract { error })?
        .0 as usize;
    let end = crate::validation::utf16_to_utf8(current, range.end)
        .map_err(|error| WorkspaceError::Contract { error })?
        .0 as usize;
    let mut out = String::with_capacity(current.len() + body.len());
    out.push_str(&current[..start]);
    out.push_str(body);
    out.push_str(&current[end..]);
    Ok(out)
}

fn render_scoped_sections(document_id: &DocumentId, sections: &[(Utf16Range, String)]) -> String {
    render_scoped_file(
        document_id,
        &sections
            .iter()
            .map(|(range, text)| (range.clone(), text.clone()))
            .collect::<Vec<_>>(),
    )
}

/// Tauri-shared isolation state (desktop). Single manager keyed by copy id.
#[cfg(feature = "desktop")]
pub struct IsolationState {
    pub manager: std::sync::Mutex<IsolationManager>,
}

#[cfg(feature = "desktop")]
impl Default for IsolationState {
    fn default() -> Self {
        let manager = IsolationManager::open_default().expect("staging dir");
        Self {
            manager: std::sync::Mutex::new(manager),
        }
    }
}

#[cfg(feature = "desktop")]
mod desktop {
    use super::*;
    use crate::ai_contracts::{IsolatedCopyId, PromptContext, PromptMode, ProposalText};
    use crate::contracts::WorkspaceError;
    use crate::ipc::ActorState;

    fn with_both<T>(
        workspace: &ActorState,
        isolation: &IsolationState,
        call: impl FnOnce(&Workspace, &mut IsolationManager) -> Result<T, WorkspaceError>,
    ) -> Result<T, WorkspaceError> {
        let mut wguard = workspace.workspace.lock().map_err(|_| WorkspaceError::Io {
            detail: "workspace lock poisoned".into(),
        })?;
        let workspace = wguard.as_mut().ok_or(WorkspaceError::NoWorkspace)?;
        let mut mguard = isolation.manager.lock().map_err(|_| WorkspaceError::Io {
            detail: "isolation lock poisoned".into(),
        })?;
        call(workspace, &mut mguard)
    }

    #[tauri::command(async)]
    pub fn isolation_create(
        workspace_state: tauri::State<'_, ActorState>,
        isolation: tauri::State<'_, IsolationState>,
        contexts: Vec<PromptContext>,
    ) -> Result<IsolatedCopyInfo, WorkspaceError> {
        with_both(&workspace_state, &isolation, |w, m| {
            m.create_copy(w, &contexts)
        })
    }

    #[tauri::command(async)]
    pub fn isolation_diff(
        workspace_state: tauri::State<'_, ActorState>,
        isolation: tauri::State<'_, IsolationState>,
        copy_id: String,
    ) -> Result<Vec<IsolationDiff>, WorkspaceError> {
        let id = IsolatedCopyId(copy_id);
        with_both(&workspace_state, &isolation, |w, m| m.diff(w, &id))
    }

    #[tauri::command(async)]
    pub fn isolation_stage_proposal(
        workspace_state: tauri::State<'_, ActorState>,
        isolation: tauri::State<'_, IsolationState>,
        copy_id: String,
        proposal: ProposalText,
        mode: PromptMode,
    ) -> Result<StagedProposal, WorkspaceError> {
        let id = IsolatedCopyId(copy_id);
        with_both(&workspace_state, &isolation, |w, m| {
            m.stage_proposal(w, &id, &proposal, mode)
        })
    }

    #[tauri::command(async)]
    pub fn isolation_approve(
        workspace_state: tauri::State<'_, ActorState>,
        isolation: tauri::State<'_, IsolationState>,
        copy_id: String,
    ) -> Result<ApproveResult, WorkspaceError> {
        let id = IsolatedCopyId(copy_id);
        with_both(&workspace_state, &isolation, |w, m| m.approve(w, &id))
    }

    #[tauri::command(async)]
    pub fn isolation_reject(
        workspace_state: tauri::State<'_, ActorState>,
        isolation: tauri::State<'_, IsolationState>,
        copy_id: String,
    ) -> Result<(), WorkspaceError> {
        let id = IsolatedCopyId(copy_id);
        with_both(&workspace_state, &isolation, |w, m| {
            let _ = w;
            m.reject(&id)
        })
    }

    #[tauri::command(async)]
    pub fn isolation_cancel(
        workspace_state: tauri::State<'_, ActorState>,
        isolation: tauri::State<'_, IsolationState>,
        copy_id: String,
    ) -> Result<(), WorkspaceError> {
        let id = IsolatedCopyId(copy_id);
        with_both(&workspace_state, &isolation, |w, m| {
            let _ = w;
            m.cancel(&id)
        })
    }
}

#[cfg(feature = "desktop")]
pub use desktop::*;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::{DocumentId, Revision};

    #[test]
    fn copy_ids_are_valid_handles() {
        assert!(validate_copy_id_string("copy_01").is_ok());
        assert!(validate_copy_id_string("").is_err());
        assert!(validate_copy_id_string("../live").is_err());
        assert!(validate_copy_id_string("/abs").is_err());
    }

    #[test]
    fn staging_guard_rejects_escapes() {
        let root = Path::new("/staging");
        assert!(guard_staging_path(root, Path::new("copy_01/notes.md")).is_ok());
        assert!(guard_staging_path(root, Path::new("../live/doc.md")).is_err());
        assert!(guard_staging_path(root, Path::new("/etc/passwd")).is_err());
        assert!(guard_staging_path(Path::new(""), Path::new("copy")).is_err());
    }

    #[test]
    fn scoped_sections_round_trip_exactly() {
        let doc = DocumentId("doc_01".into());
        let scopes = vec![
            (
                Utf16Range {
                    start: Utf16Offset(0),
                    end: Utf16Offset(5),
                },
                "hello".to_owned(),
            ),
            (
                Utf16Range {
                    start: Utf16Offset(5),
                    end: Utf16Offset(5),
                },
                String::new(),
            ),
            (
                Utf16Range {
                    start: Utf16Offset(6),
                    end: Utf16Offset(9),
                },
                "a\nb\n".to_owned(),
            ),
        ];
        let rendered = render_scoped_file(&doc, &scopes);
        let parsed = parse_scoped_file(&rendered).unwrap();
        assert_eq!(parsed.len(), 3);
        for ((parsed_doc, parsed_range, parsed_body), (range, slice)) in
            parsed.iter().zip(scopes.iter())
        {
            assert_eq!(parsed_doc, "doc_01");
            assert_eq!(parsed_range, range);
            assert_eq!(parsed_body, slice);
        }
    }

    #[test]
    fn scoped_parse_rejects_header_mismatch() {
        let bad = "--- marxen-scope document=other range=[0, 1) ---\nx\n";
        assert!(parse_scoped_file(bad).is_ok());
        let (doc, _, _) = &parse_scoped_file(bad).unwrap()[0];
        assert_eq!(doc, "other");
        assert!(parse_scoped_file("no header here\n").is_err());
        assert!(parse_scoped_file("").is_err());
    }

    #[test]
    fn minimal_edit_preserves_outside_bytes() {
        assert!(minimal_edit("abc", "abc").is_none());
        let edit = minimal_edit("\u{feff}a\r\nb\r\n", "\u{feff}a\r\nB\r\n").unwrap();
        assert_eq!(edit.range.start.0, 4);
        assert_eq!(edit.text, "B");
        let edit = minimal_edit("hello", "hello world").unwrap();
        assert_eq!(edit.range.start.0, 5);
        assert_eq!(edit.range.end.0, 5);
        assert_eq!(edit.text, " world");
    }

    #[test]
    fn unified_diff_marks_changes() {
        let same = unified_diff("a\nb\n", "a\nb\n", "a.md");
        assert!(same.contains("変更なし"));
        let diff = unified_diff("a\nb\nc\n", "a\nB\nc\n", "a.md");
        assert!(diff.contains("-b"));
        assert!(diff.contains("+B"));
    }

    #[test]
    fn revision_helper_reports_stale() {
        let error = stale(Revision(1), Revision(2));
        assert!(matches!(
            error,
            WorkspaceError::Contract {
                error: ContractError::StaleRevision { .. }
            }
        ));
    }
}
