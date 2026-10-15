//! Isolation IPC data, independent of runtime adapters.
use crate::contracts::ai::IsolatedCopyId;
use crate::contracts::{DocumentId, DocumentSnapshot, Revision, Utf16Range};
use serde::{Deserialize, Serialize};
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

/// One new Markdown file created by the agent inside the staging copy.
///
/// Only relative contained `.md` paths are reported; forbidden names
/// (`.git`/`.env`/credentials) and non-Markdown files are never importable.
/// The content is staged text, not yet applied to any live document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StagedNewFile {
    pub rel: String,
    pub chars: u32,
    pub content: String,
}

/// One staged new file offered for import into its original workspace.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportFileRequest {
    pub rel: String,
    pub content: String,
}

/// Per-file outcome of importing staged new files into the copy's workspace.
///
/// Successes carry the opened snapshot for session registration; failures
/// carry the refusal detail with no file created or modified.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StagedImportOutcome {
    pub rel: String,
    pub snapshot: Option<DocumentSnapshot>,
    pub error: Option<String>,
}

/// Return exported isolation IPC TypeScript declarations with document/AI imports.
/// Trim trailing whitespace from each line and finish with one LF; no files are written.
pub fn typescript() -> String {
    let cfg = ts_rs::Config::default();
    let declarations = [
        IsolatedCopyDoc::decl(&cfg),
        IsolatedCopyInfo::decl(&cfg),
        IsolationDiff::decl(&cfg),
        ApproveDocOutcome::decl(&cfg),
        ApproveResult::decl(&cfg),
        StagedProposal::decl(&cfg),
        StagedNewFile::decl(&cfg),
        ImportFileRequest::decl(&cfg),
        StagedImportOutcome::decl(&cfg),
    ];
    let mut output = "// Generated from src-tauri/src/contracts/isolation.rs. Run npm run isolation-contracts:generate.\n// Do not edit by hand. Isolation IPC schema version 4.\n".to_owned();
    output.push_str("import type { DocumentId, DocumentSnapshot, Revision, Utf16Range } from \"./contracts\";\n");
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
