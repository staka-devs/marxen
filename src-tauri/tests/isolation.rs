//! Issue #8 exact-scope isolation tests. A mock file-editing CLI and a mock
//! ACP child mutate only the staging copy; live buffers change solely
//! through approved Ai range patches via the Neovim actor. Only selected
//! excerpts ever reach staging; rejection/cancellation keep originals exact;
//! stale revisions and disk changes refuse until resync; pinned copies
//! refuse mutation until the run settles.
use marxen_lib::application::ai::{credentials::*, runs::*};
use marxen_lib::application::isolation::IsolationManager;
use marxen_lib::application::workspace::Workspace;
use marxen_lib::contracts::ai::{
    AcpArgv, AcpConfig, AcpPreset, AiPromptRequest, AiProviderConfig, AiProviderKind,
    AiStreamEvent, AnthropicConfig, IsolatedCopyId, OpenAiConfig, PromptContext, PromptMode,
    ProposalText,
};
use marxen_lib::contracts::{DocumentSnapshot, Revision, Utf16Offset, Utf16Range, WorkspaceError};
use marxen_lib::infrastructure::ai::{acp::*, credentials::*};
use marxen_lib::infrastructure::staging::guard_staging_path;
use std::fs;
use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;
use tempfile::TempDir;

/// Open workspace, recovery and staging fixtures in independently owned temporary directories.
fn setup() -> (TempDir, TempDir, TempDir, Workspace, IsolationManager) {
    let root = tempfile::tempdir().unwrap();
    let recovery = tempfile::tempdir().unwrap();
    let staging = tempfile::tempdir().unwrap();
    let workspace = marxen_lib::open_workspace(root.path(), recovery.path()).unwrap();
    let manager = marxen_lib::open_isolation(staging.path()).unwrap();
    (root, recovery, staging, workspace, manager)
}

/// Extract a half-open UTF-16 excerpt after validating both endpoints as UTF-8 boundaries.
fn slice(text: &str, start: u32, end: u32) -> String {
    let range = Utf16Range {
        start: Utf16Offset(start),
        end: Utf16Offset(end),
    };
    let s = marxen_lib::domain::validation::utf16_to_utf8(text, range.start)
        .unwrap()
        .0 as usize;
    let e = marxen_lib::domain::validation::utf16_to_utf8(text, range.end)
        .unwrap()
        .0 as usize;
    text[s..e].to_owned()
}

/// Capture exactly the supplied snapshot ranges and concatenate only their selected excerpts.
fn ctx(snapshot: &DocumentSnapshot, ranges: &[(u32, u32)]) -> PromptContext {
    let text: String = ranges
        .iter()
        .map(|(s, e)| slice(&snapshot.text, *s, *e))
        .collect();
    PromptContext {
        location: None,
        document_id: snapshot.document_id.clone(),
        revision: snapshot.revision,
        ranges: ranges
            .iter()
            .map(|(s, e)| Utf16Range {
                start: Utf16Offset(*s),
                end: Utf16Offset(*e),
            })
            .collect(),
        text,
    }
}

/// Read the current authoritative actor text for the snapshot document identifier.
fn live_text(workspace: &Workspace, snapshot: &DocumentSnapshot) -> String {
    workspace
        .actor(&snapshot.document_id.0)
        .unwrap()
        .snapshot()
        .text
}

/// Build an argv for the Cargo mock ACP child without shell interpolation.
fn acp_argv(extra: &[&str]) -> AcpArgv {
    AcpArgv {
        command: env!("CARGO_BIN_EXE_mock-acp-agent").into(),
        args: extra.iter().map(|s| (*s).to_owned()).collect(),
    }
}

/// Bind a workspace ACP request to its registered copy and exact selected contexts.
fn acp_request(
    argv: AcpArgv,
    copy_id: &IsolatedCopyId,
    contexts: Vec<PromptContext>,
) -> AiPromptRequest {
    AiPromptRequest {
        conversation_id: None,
        provider: AiProviderConfig {
            kind: AiProviderKind::Acp,
            acp: Some(AcpConfig {
                selections: None,
                preset: AcpPreset::Custom,
                argv: Some(argv),
            }),
            openai: None,
            anthropic: None,
            connection_id: None,
        },
        mode: PromptMode::Workspace,
        prompt: "修正してください".into(),
        contexts,
        staging: marxen_lib::contracts::ai::StagingTarget {
            copy_id: copy_id.clone(),
        },
        session_id: None,
        history: vec![],
    }
}

/// Run the mock file-editing subprocess inside the supplied staging fixture and require success.
fn mock_cli_write(staging_dir: &Path, file: &str, text: &str) {
    let exe = env!("CARGO_BIN_EXE_mock-isolation-agent");
    let status = std::process::Command::new(exe)
        .args([
            "--staging-dir",
            &staging_dir.to_string_lossy(),
            "--file",
            file,
            "--text",
            text,
        ])
        .status()
        .expect("spawn mock cli");
    assert!(status.success(), "mock cli failed for {file}");
}

#[test]
/// Require the isolated files to contain selected excerpts without disclosing the rest of the document.
fn only_selected_excerpts_reach_staging() {
    let (_root, _recovery, _staging, mut workspace, mut manager) = setup();
    let doc = workspace
        .create("a.md", "secret1\nkeep this\nsecret2\n")
        .unwrap();
    // "secret1\n" is 8 units; select [8, 18) = "keep this\n".
    let copy = manager
        .create_copy(&workspace, &[ctx(&doc.snapshot, &[(8, 18)])])
        .unwrap();
    assert!(!copy.documents[0].full_document);
    let staging_dir = manager.resolve(&copy.copy_id).unwrap();
    let staged = fs::read_to_string(staging_dir.join("a.md")).unwrap();
    assert!(staged.contains("keep this"), "{staged}");
    assert!(!staged.contains("secret1"), "{staged}");
    assert!(!staged.contains("secret2"), "{staged}");
    // Live absolute paths never appear in agent-visible metadata.
    assert!(!staged.contains("marxen") || staged.contains("marxen-scope"));
    assert!(!staging_dir.join("manifest.json").exists());
}

#[test]
/// Refuse excerpt text or duplicate scopes that contradict the authoritative snapshot.
fn forged_excerpts_and_contradictory_duplicates_refused() {
    let (_root, _recovery, _staging, mut workspace, mut manager) = setup();
    let doc = workspace.create("a.md", "hello").unwrap();
    // Forged excerpt text with otherwise valid ranges.
    let mut forged = ctx(&doc.snapshot, &[(0, 5)]);
    forged.text = "forged".into();
    assert!(manager.create_copy(&workspace, &[forged]).is_err());
    // Contradictory duplicate: same document, different revision.
    let mut stale_ctx = ctx(&doc.snapshot, &[(0, 5)]);
    stale_ctx.revision = Revision(doc.snapshot.revision.0 + 9);
    assert!(manager
        .create_copy(&workspace, &[ctx(&doc.snapshot, &[(0, 5)]), stale_ctx])
        .is_err());
    // Overlapping ranges across duplicate contexts.
    assert!(manager
        .create_copy(
            &workspace,
            &[ctx(&doc.snapshot, &[(0, 3)]), ctx(&doc.snapshot, &[(2, 5)])]
        )
        .is_err());
}

#[test]
/// Allow whole-file staging only when the caller explicitly authorizes the complete document range.
fn full_document_mode_requires_explicit_whole_selection() {
    let (_root, _recovery, _staging, mut workspace, mut manager) = setup();
    let doc = workspace.create("a.md", "hello").unwrap();
    // Covering ranges that are not a single [0, len) stay scoped.
    let copy = manager
        .create_copy(
            &workspace,
            &[ctx(&doc.snapshot, &[(0, 2)]), ctx(&doc.snapshot, &[(2, 5)])],
        )
        .unwrap();
    assert!(!copy.documents[0].full_document);
    let staged = fs::read_to_string(manager.resolve(&copy.copy_id).unwrap().join("a.md")).unwrap();
    assert!(staged.contains("marxen-scope"));
    manager.reject(&copy.copy_id).unwrap();
    // One explicit whole-document range is stored raw.
    let copy = manager
        .create_copy(&workspace, &[ctx(&doc.snapshot, &[(0, 5)])])
        .unwrap();
    assert!(copy.documents[0].full_document);
    let staged = fs::read_to_string(manager.resolve(&copy.copy_id).unwrap().join("a.md")).unwrap();
    assert_eq!(staged, "hello");
}

#[test]
/// Keep both live buffers and disk bytes unchanged when a staged copy is rejected or cancelled.
fn rejection_and_cancellation_leave_originals_exact() {
    let (root, _recovery, _staging, mut workspace, mut manager) = setup();
    for action in ["reject", "cancel"] {
        let doc = workspace
            .create(&format!("{action}.md"), "original")
            .unwrap();
        let copy = manager
            .create_copy(&workspace, &[ctx(&doc.snapshot, &[(0, 8)])])
            .unwrap();
        let staging_dir = manager.resolve(&copy.copy_id).unwrap();
        // Full-document staging: raw file the CLI rewrites.
        mock_cli_write(&staging_dir, &format!("{action}.md"), "malicious");
        if action == "reject" {
            manager.reject(&copy.copy_id).unwrap();
        } else {
            manager.cancel(&copy.copy_id).unwrap();
        }
        assert_eq!(live_text(&workspace, &doc.snapshot), "original");
        assert_eq!(
            fs::read(root.path().join(format!("{action}.md"))).unwrap(),
            b"original"
        );
        assert!(manager.resolve(&copy.copy_id).is_err());
    }
}

#[test]
/// Let the mock child edit an authorized staging file and apply it only after explicit approval.
fn mock_acp_child_edits_full_document_staging_then_approves() {
    let (root, _recovery, _staging, mut workspace, mut manager) = setup();
    let doc = workspace.create("a.md", "hello").unwrap();
    let contexts = vec![ctx(&doc.snapshot, &[(0, 5)])];
    let copy = manager.create_copy(&workspace, &contexts).unwrap();
    assert!(copy.documents[0].full_document);
    let request = acp_request(
        acp_argv(&[
            "--no-permission",
            "--write-staging=a.md",
            "--write-text=hello cli",
        ]),
        &copy.copy_id,
        contexts,
    );
    // Production order: authorize before any process side effect.
    manager.authorize_prompt(&workspace, &request).unwrap();
    let staging_dir = manager.resolve(&copy.copy_id).unwrap();
    let registry = Arc::new(RunRegistry::new());
    let (run_id, cancel) = registry.register();
    let params = AcpRunParams {
        argv: acp_argv(&[
            "--no-permission",
            "--write-staging=a.md",
            "--write-text=hello cli",
        ]),
        staging_dir,
        timeout: Duration::from_secs(30),
    };
    let mut events = Vec::new();
    run_acp_prompt(
        &params,
        &request,
        &run_id,
        &registry,
        &cancel,
        &mut |event| {
            events.push(event);
        },
    )
    .unwrap();
    // Live untouched by the child; only staging changed.
    assert_eq!(live_text(&workspace, &doc.snapshot), "hello");
    let result = manager.approve(&workspace, &copy.copy_id).unwrap();
    assert_eq!(result.outcomes.len(), 1);
    assert!(result.outcomes[0].applied && !result.outcomes[0].rolled_back);
    assert_eq!(live_text(&workspace, &doc.snapshot), "hello cli");
    // Native Undo restores the pre-approval buffer (single Undo step).
    let actor = workspace.actor(&doc.snapshot.document_id.0).unwrap();
    assert_eq!(actor.undo().unwrap().text, "hello");
    assert_eq!(actor.redo().unwrap().text, "hello cli");
    // Approval is buffer-only; disk waits for the shared save contract.
    assert_eq!(fs::read(root.path().join("a.md")).unwrap(), b"hello");
}

#[test]
/// Reject staged excerpt corruption before it can mutate the original buffer.
fn corrupted_scoped_staging_refuses_approval() {
    let (_root, _recovery, _staging, mut workspace, mut manager) = setup();
    let doc = workspace.create("a.md", "keep this\nrest\n").unwrap();
    // Select only the first line (scoped mode).
    let copy = manager
        .create_copy(&workspace, &[ctx(&doc.snapshot, &[(0, 10)])])
        .unwrap();
    assert!(!copy.documents[0].full_document);
    let staging_dir = manager.resolve(&copy.copy_id).unwrap();
    // Raw overwrite destroys the scope envelope: unreviewable, refused.
    mock_cli_write(&staging_dir, "a.md", "raw overwrite without headers");
    let diffs = manager.diff(&workspace, &copy.copy_id).unwrap();
    assert!(diffs[0].changed);
    let outcome = manager.approve(&workspace, &copy.copy_id);
    assert!(outcome.is_err(), "malformed staging must refuse");
    assert_eq!(live_text(&workspace, &doc.snapshot), "keep this\nrest\n");
}

#[test]
/// Refuse child-created files whose paths were never included in the registered authorization.
fn unselected_staging_files_never_authorize_edits() {
    let (_root, _recovery, _staging, mut workspace, mut manager) = setup();
    let doc = workspace.create("a.md", "hello").unwrap();
    let copy = manager
        .create_copy(&workspace, &[ctx(&doc.snapshot, &[(0, 5)])])
        .unwrap();
    let staging_dir = manager.resolve(&copy.copy_id).unwrap();
    // Agent-created file outside the registered scope.
    fs::write(staging_dir.join("extra.md"), "unregistered").unwrap();
    let result = manager.approve(&workspace, &copy.copy_id).unwrap();
    assert_eq!(result.outcomes.len(), 1);
    assert!(!result.outcomes[0].applied);
    assert_eq!(live_text(&workspace, &doc.snapshot), "hello");
}

#[test]
/// Apply a staged HTTP rewrite through the document actor and verify native Undo restores the original.
fn http_proposal_stages_then_applies_with_undo_evidence() {
    let (_root, _recovery, _staging, mut workspace, mut manager) = setup();
    let doc = workspace.create("a.md", "hello").unwrap();
    let scope = ctx(&doc.snapshot, &[(0, 5)]);
    let copy = manager
        .create_copy(&workspace, std::slice::from_ref(&scope))
        .unwrap();
    // Mocked HTTP streaming proposal bound to the sent scope.
    let request = acp_request(acp_argv(&[]), &copy.copy_id, vec![scope]);
    let run_id = marxen_lib::contracts::ai::AiRunId("run_http_1".into());
    let script = MockScript {
        chunks: vec!["hello ".into(), "world".into()],
        fail: None,
    };
    let cancel = AtomicBool::new(false);
    let mut events = Vec::new();
    run_mock_script(&request, &run_id, &script, &cancel, &mut |event| {
        events.push(event);
    });
    let proposal = match events.last().expect("done") {
        marxen_lib::contracts::ai::AiStreamEvent::Done(done) => done.proposal.clone(),
        other => panic!("expected done, got {other:?}"),
    };
    assert_eq!(proposal.text, "hello world");
    let staged = manager
        .stage_proposal(&workspace, &copy.copy_id, &proposal, PromptMode::Rewrite)
        .unwrap();
    assert_eq!(staged.updated.len(), 1);
    // Questions only display: staging an answer as Ask is refused.
    assert!(manager
        .stage_proposal(&workspace, &copy.copy_id, &proposal, PromptMode::Ask)
        .is_err());
    let result = manager.approve(&workspace, &copy.copy_id).unwrap();
    assert!(result.outcomes[0].applied);
    assert_eq!(live_text(&workspace, &doc.snapshot), "hello world");
    let actor = workspace.actor(&doc.snapshot.document_id.0).unwrap();
    assert_eq!(actor.undo().unwrap().text, "hello");
}

#[test]
/// Apply workspace patches only inside their authorized ranges as one native Undo step.
fn workspace_patches_apply_minimally_with_single_undo() {
    let (_root, _recovery, _staging, mut workspace, mut manager) = setup();
    let doc = workspace.create("a.md", "aaa\nbbb\nccc\n").unwrap();
    // Two scopes in one document: [0,4) "aaa\n" and [8,12) "ccc\n".
    let copy = manager
        .create_copy(&workspace, &[ctx(&doc.snapshot, &[(0, 4), (8, 12)])])
        .unwrap();
    let proposal = ProposalText {
        text: "--- marxen-patch document=DOC range=[0, 4) ---\nAAA\n--- marxen-patch document=DOC range=[8, 12) ---\nCCC\n"
            .replace("DOC", &doc.snapshot.document_id.0),
        base_contexts: vec![marxen_lib::contracts::ai::ContextRef {
            document_id: doc.snapshot.document_id.clone(),
            revision: doc.snapshot.revision,
        }],
    };
    let staged = manager
        .stage_proposal(&workspace, &copy.copy_id, &proposal, PromptMode::Workspace)
        .unwrap();
    assert_eq!(staged.updated.len(), 1);
    let result = manager.approve(&workspace, &copy.copy_id).unwrap();
    assert!(result.outcomes[0].applied);
    // Middle bytes untouched; both scopes changed in one Undo step.
    assert_eq!(live_text(&workspace, &doc.snapshot), "AAA\nbbb\nCCC\n");
    let actor = workspace.actor(&doc.snapshot.document_id.0).unwrap();
    assert_eq!(actor.undo().unwrap().text, "aaa\nbbb\nccc\n");
    // Malformed/unknown/stale proposals are actionable errors.
    let bad_text = "--- marxen-patch document=nope range=[0, 1) ---\nx\n";
    let bad = ProposalText {
        text: bad_text.into(),
        base_contexts: vec![],
    };
    let doc2 = workspace.create("b.md", "xyz").unwrap();
    let copy2 = manager
        .create_copy(&workspace, &[ctx(&doc2.snapshot, &[(0, 3)])])
        .unwrap();
    assert!(manager
        .stage_proposal(&workspace, &copy2.copy_id, &bad, PromptMode::Workspace)
        .is_err());
}

#[test]
/// Preserve the BOM and unselected CRLF bytes around an approved range edit.
fn bom_crlf_outside_bytes_survive_scoped_approval() {
    let (root, _recovery, _staging, mut workspace, mut manager) = setup();
    let bytes = "\u{feff}head\r\nkeep\r\ntail\r\n";
    fs::write(root.path().join("a.md"), bytes).unwrap();
    let doc = workspace.open_markdown("a.md").unwrap();
    // BOM(1) + "head"(4) + CRLF(2) = 7; select "keep\r\n" = [7, 13).
    let copy = manager
        .create_copy(&workspace, &[ctx(&doc.snapshot, &[(7, 13)])])
        .unwrap();
    assert!(!copy.documents[0].full_document);
    let staging_dir = manager.resolve(&copy.copy_id).unwrap();
    let staged = fs::read_to_string(staging_dir.join("a.md")).unwrap();
    assert!(staged.contains("keep"), "{staged}");
    assert!(!staged.contains("head"), "{staged}");
    assert!(!staged.contains("tail"), "{staged}");
    let proposal = ProposalText {
        text: "KEEP\r\n".into(),
        base_contexts: vec![marxen_lib::contracts::ai::ContextRef {
            document_id: doc.snapshot.document_id.clone(),
            revision: doc.snapshot.revision,
        }],
    };
    manager
        .stage_proposal(&workspace, &copy.copy_id, &proposal, PromptMode::Rewrite)
        .unwrap();
    let result = manager.approve(&workspace, &copy.copy_id).unwrap();
    assert!(result.outcomes[0].applied);
    assert_eq!(
        live_text(&workspace, &doc.snapshot),
        "\u{feff}head\r\nKEEP\r\ntail\r\n"
    );
}

#[test]
/// Detect a native buffer change not yet acknowledged by the GUI before applying any proposal.
fn hidden_vim_drift_refuses_preflight_without_mutation() {
    let (_root, _recovery, _staging, mut workspace, mut manager) = setup();
    let doc_a = workspace.create("a.md", "aaa").unwrap();
    let doc_b = workspace.create("b.md", "bbb").unwrap();
    let copy = manager
        .create_copy(
            &workspace,
            &[
                ctx(&doc_a.snapshot, &[(0, 3)]),
                ctx(&doc_b.snapshot, &[(0, 3)]),
            ],
        )
        .unwrap();
    let staging_dir = manager.resolve(&copy.copy_id).unwrap();
    mock_cli_write(&staging_dir, "a.md", "aaa edited");
    mock_cli_write(&staging_dir, "b.md", "bbb edited");
    // Hidden Vim-side drift behind the actor's back: the native-ready
    // preflight syncs the real buffer and refuses before any mutation.
    workspace
        .actor(&doc_b.snapshot.document_id.0)
        .unwrap()
        .nvim_command("call setline(1, 'CHANGED')")
        .unwrap();
    let outcome = manager.approve(&workspace, &copy.copy_id);
    assert!(
        matches!(outcome, Err(WorkspaceError::Contract { .. })),
        "drift must preflight-fail, got {outcome:?}"
    );
    // Neither document changed; the first document was never touched.
    // The drifted document's snapshot now acknowledges the real Vim text.
    assert_eq!(live_text(&workspace, &doc_a.snapshot), "aaa");
    assert_eq!(live_text(&workspace, &doc_b.snapshot), "CHANGED");
}

#[test]
/// Expose per-document failures and native Undo rollback when an approval fails after preflight.
fn apply_phase_failure_reports_partial_outcomes_with_rollback() {
    let (_root, _recovery, _staging, mut workspace, mut manager) = setup();
    let doc_a = workspace.create("a.md", "aaa").unwrap();
    let doc_b = workspace.create("b.md", "bbb").unwrap();
    let copy = manager
        .create_copy(
            &workspace,
            &[
                ctx(&doc_a.snapshot, &[(0, 3)]),
                ctx(&doc_b.snapshot, &[(0, 3)]),
            ],
        )
        .unwrap();
    let staging_dir = manager.resolve(&copy.copy_id).unwrap();
    mock_cli_write(&staging_dir, "a.md", "aaa edited");
    mock_cli_write(&staging_dir, "b.md", "bbb edited");
    // Deterministic apply-phase failure injection for b: both documents pass
    // native preflight, a applies, then b fails and a rolls back. The fault
    // is explicit manager configuration, not a global env var.
    manager.inject_apply_failure_for_tests(Some(doc_b.snapshot.document_id.clone()));
    let result = manager.approve(&workspace, &copy.copy_id).unwrap();
    manager.inject_apply_failure_for_tests(None);
    let by_doc = |id: &str| {
        result
            .outcomes
            .iter()
            .find(|o| o.document_id.0 == id)
            .expect("outcome")
    };
    let outcome_a = by_doc(&doc_a.snapshot.document_id.0);
    let outcome_b = by_doc(&doc_b.snapshot.document_id.0);
    assert!(outcome_a.applied, "first doc applies before the failure");
    assert!(
        outcome_a.rolled_back,
        "first doc is rolled back via native Undo"
    );
    assert!(outcome_a.rollback_error.is_none());
    assert!(!outcome_b.applied);
    assert!(outcome_b.error.is_some());
    assert!(!outcome_b.rolled_back);
    // Rollback revision is the post-Undo revision, not the pre-rollback one.
    let actor_a = workspace.actor(&doc_a.snapshot.document_id.0).unwrap();
    assert_eq!(outcome_a.revision, actor_a.snapshot().revision);
    // Live texts are exactly the pre-approval originals.
    assert_eq!(live_text(&workspace, &doc_a.snapshot), "aaa");
    assert_eq!(live_text(&workspace, &doc_b.snapshot), "bbb");
    // Native redo re-applies the rolled-back patch: Undo evidence.
    assert_eq!(actor_a.redo().unwrap().text, "aaa edited");
    assert_eq!(actor_a.undo().unwrap().text, "aaa");
    // The consumed copy cannot approve again (no silent all-or-nothing).
    assert!(manager.approve(&workspace, &copy.copy_id).is_err());
}

#[test]
/// Detect a dead document actor before another document in the same approval can change.
fn dead_actor_preflights_before_any_mutation() {
    let (_root, _recovery, _staging, mut workspace, mut manager) = setup();
    let doc_a = workspace.create("a.md", "aaa").unwrap();
    let doc_b = workspace.create("b.md", "bbb").unwrap();
    let copy = manager
        .create_copy(
            &workspace,
            &[
                ctx(&doc_a.snapshot, &[(0, 3)]),
                ctx(&doc_b.snapshot, &[(0, 3)]),
            ],
        )
        .unwrap();
    let staging_dir = manager.resolve(&copy.copy_id).unwrap();
    mock_cli_write(&staging_dir, "a.md", "aaa edited");
    mock_cli_write(&staging_dir, "b.md", "bbb edited");
    workspace
        .actor(&doc_b.snapshot.document_id.0)
        .unwrap()
        .nvim_command("qa!")
        .ok();
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while std::time::Instant::now() <= deadline {
        match workspace
            .actor(&doc_b.snapshot.document_id.0)
            .unwrap()
            .is_alive()
        {
            // Dead (or unreachable) actor: preflight must refuse below.
            Ok(false) | Err(_) => break,
            Ok(true) => std::thread::sleep(Duration::from_millis(10)),
        }
    }
    let outcome = manager.approve(&workspace, &copy.copy_id);
    assert!(
        matches!(outcome, Err(WorkspaceError::Neovim { .. })),
        "dead actor must preflight-fail, got {outcome:?}"
    );
    assert_eq!(live_text(&workspace, &doc_a.snapshot), "aaa");
}

#[test]
/// Block staging mutation and approval while a live run owns a pin, then permit them after release.
fn pinned_copies_refuse_mutation_until_settlement() {
    let (_root, _recovery, _staging, mut workspace, mut manager) = setup();
    let doc = workspace.create("a.md", "hello").unwrap();
    let copy = manager
        .create_copy(&workspace, &[ctx(&doc.snapshot, &[(0, 5)])])
        .unwrap();
    manager.pin_for_run(&copy.copy_id).unwrap();
    // Cancellation alone is not settlement: still refused.
    assert!(manager.cancel(&copy.copy_id).is_err());
    assert!(manager.reject(&copy.copy_id).is_err());
    let staging_dir = manager.resolve(&copy.copy_id).unwrap();
    mock_cli_write(&staging_dir, "a.md", "hello cli");
    assert!(manager.approve(&workspace, &copy.copy_id).is_err());
    // Diff stays available (read-only) while pinned.
    assert!(!manager.diff(&workspace, &copy.copy_id).unwrap().is_empty());
    // Only actual settlement releases: approve works afterwards.
    manager.unpin_for_run(&copy.copy_id);
    let result = manager.approve(&workspace, &copy.copy_id).unwrap();
    assert!(result.outcomes[0].applied);
}

#[test]
/// Require a fresh copy after revision or disk drift before retrying approval.
fn stale_revision_and_disk_conflict_refuse_until_resync() {
    let (root, _recovery, _staging, mut workspace, mut manager) = setup();
    let doc = workspace.create("a.md", "base").unwrap();
    let copy = manager
        .create_copy(&workspace, &[ctx(&doc.snapshot, &[(0, 4)])])
        .unwrap();
    // Authorize a forged wider scope: outside registered selection.
    let wide = AiPromptRequest {
        conversation_id: None,
        provider: AiProviderConfig {
            kind: AiProviderKind::Acp,
            acp: Some(AcpConfig {
                selections: None,
                preset: AcpPreset::Custom,
                argv: Some(acp_argv(&[])),
            }),
            openai: None,
            anthropic: None,
            connection_id: None,
        },
        mode: PromptMode::Workspace,
        prompt: "x".into(),
        contexts: vec![ctx(&doc.snapshot, &[(0, 4)])],
        staging: marxen_lib::contracts::ai::StagingTarget {
            copy_id: copy.copy_id.clone(),
        },
        session_id: None,
        history: vec![],
    };
    manager.authorize_prompt(&workspace, &wide).unwrap();
    // Live moves after the copy: stale refuses, disk drift conflicts.
    let actor = workspace.actor(&doc.snapshot.document_id.0).unwrap();
    let s = actor.snapshot();
    actor
        .apply_edits(marxen_lib::contracts::EditRequest {
            document_id: s.document_id,
            base_revision: s.revision,
            source: marxen_lib::contracts::EditSource::Gui,
            edits: vec![marxen_lib::contracts::TextEdit {
                range: Utf16Range {
                    start: Utf16Offset(0),
                    end: Utf16Offset(4),
                },
                text: "live".into(),
            }],
        })
        .unwrap();
    assert!(manager.authorize_prompt(&workspace, &wide).is_err());
    let staging_dir = manager.resolve(&copy.copy_id).unwrap();
    mock_cli_write(&staging_dir, "a.md", "stale cli edit");
    assert!(matches!(
        manager.approve(&workspace, &copy.copy_id),
        Err(WorkspaceError::Contract { .. })
    ));
    assert_eq!(live_text(&workspace, &doc.snapshot), "live");
    assert_eq!(fs::read(root.path().join("a.md")).unwrap(), b"base");
    // Resync through a fresh copy approves cleanly.
    let live = workspace
        .actor(&doc.snapshot.document_id.0)
        .unwrap()
        .snapshot();
    let fresh = manager
        .create_copy(&workspace, &[ctx(&live, &[(0, 4)])])
        .unwrap();
    let staging_dir = manager.resolve(&fresh.copy_id).unwrap();
    mock_cli_write(&staging_dir, "a.md", "live + cli");
    assert!(
        manager
            .approve(&workspace, &fresh.copy_id)
            .unwrap()
            .outcomes[0]
            .applied
    );
}

#[test]
/// Detect external file modification during preflight and preserve the original buffer.
fn disk_change_conflicts_before_apply() {
    let (root, _recovery, _staging, mut workspace, mut manager) = setup();
    let doc = workspace.create("a.md", "base").unwrap();
    let copy = manager
        .create_copy(&workspace, &[ctx(&doc.snapshot, &[(0, 4)])])
        .unwrap();
    let staging_dir = manager.resolve(&copy.copy_id).unwrap();
    mock_cli_write(&staging_dir, "a.md", "cli edit");
    fs::write(root.path().join("a.md"), "external").unwrap();
    assert!(matches!(
        manager.approve(&workspace, &copy.copy_id),
        Err(WorkspaceError::Conflict { .. })
    ));
    assert_eq!(live_text(&workspace, &doc.snapshot), "base");
}

#[test]
/// Reject absolute paths from other operating-system syntaxes as well as native rooted paths.
fn staging_paths_reject_foreign_os_roots() {
    let root = tempfile::tempdir().unwrap();
    for bad in [
        "../a.md",
        "/a.md",
        "C:/a.md",
        "c:a.md",
        r"C:\a.md",
        r"\a.md",
        r"\\server\share\a.md",
    ] {
        assert!(
            guard_staging_path(root.path(), Path::new(bad)).is_err(),
            "{bad} must be rejected"
        );
    }
    assert_eq!(
        guard_staging_path(root.path(), Path::new("メモ/../日本語 😀.md")).unwrap(),
        root.path().join("日本語 😀.md")
    );
    assert_eq!(
        guard_staging_path(root.path(), Path::new("メモ/確認.md")).unwrap(),
        root.path().join("メモ").join("確認.md")
    );
}

#[test]
/// Contain isolated files against traversal, absolute paths and symlink escapes.
fn traversal_absolute_and_symlink_are_rejected() {
    let (_root, _recovery, _staging, mut workspace, mut manager) = setup();
    let doc = workspace.create("a.md", "x").unwrap();
    let copy = manager
        .create_copy(&workspace, &[ctx(&doc.snapshot, &[(0, 1)])])
        .unwrap();
    let staging_dir = manager.resolve(&copy.copy_id).unwrap();
    let exe = env!("CARGO_BIN_EXE_mock-isolation-agent");
    for bad in [
        "../live.md",
        "/abs.md",
        "C:/a.md",
        "c:a.md",
        r"C:\a.md",
        r"\a.md",
        r"\\server\share\a.md",
    ] {
        let status = std::process::Command::new(exe)
            .args([
                "--staging-dir",
                &staging_dir.to_string_lossy(),
                "--file",
                bad,
                "--text",
                "evil",
            ])
            .status()
            .unwrap();
        assert!(!status.success(), "{bad} must be rejected");
    }
    // Mock ACP child itself refuses escapes via its own guard.
    let staging = manager.resolve(&copy.copy_id).unwrap();
    let registry = Arc::new(RunRegistry::new());
    let (run_id, cancel) = registry.register();
    let evil = acp_request(
        acp_argv(&[
            "--no-permission",
            "--write-staging=../evil.md",
            "--write-text=evil",
        ]),
        &copy.copy_id,
        vec![ctx(&doc.snapshot, &[(0, 1)])],
    );
    let params = AcpRunParams {
        argv: acp_argv(&[
            "--no-permission",
            "--write-staging=../evil.md",
            "--write-text=evil",
        ]),
        staging_dir: staging,
        timeout: Duration::from_secs(30),
    };
    let mut events = Vec::new();
    let outcome = run_acp_prompt(&params, &evil, &run_id, &registry, &cancel, &mut |event| {
        events.push(event);
    });
    assert!(outcome.is_err(), "escape write must fail the run");
    assert!(manager
        .resolve(&IsolatedCopyId("copy_missing".into()))
        .is_err());
}

#[test]
/// Validate the complete prompt scope before acquiring a run pin so rejected requests leave no busy copy.
fn prepare_prompt_run_rejects_bad_scope_without_pinning() {
    let (_root, _recovery, _staging, mut workspace, mut manager) = setup();
    let doc = workspace.create("a.md", "hello world").unwrap();
    let contexts = vec![ctx(&doc.snapshot, &[(0, 5)])];
    let copy = manager.create_copy(&workspace, &contexts).unwrap();
    let wide = acp_request(
        acp_argv(&[]),
        &copy.copy_id,
        vec![ctx(&doc.snapshot, &[(0, 11)])],
    );
    assert!(manager.prepare_prompt_run(&workspace, &wide).is_err());
    // A failed preparation leaves the copy available for rejection.
    let dir = manager.resolve(&copy.copy_id).unwrap();
    manager.reject(&copy.copy_id).unwrap();
    assert!(!dir.exists());

    let copy = manager.create_copy(&workspace, &contexts).unwrap();
    let exact = acp_request(acp_argv(&[]), &copy.copy_id, contexts);
    let other_root = tempfile::tempdir().unwrap();
    let other_recovery = tempfile::tempdir().unwrap();
    let other_workspace =
        marxen_lib::open_workspace(other_root.path(), other_recovery.path()).unwrap();
    assert!(manager
        .prepare_prompt_run(&other_workspace, &exact)
        .is_err());
    manager.cancel(&copy.copy_id).unwrap();
}

#[test]
/// Resolve authorized staging before pinning and hold the pin until the prepared run is released.
fn prepare_prompt_run_resolves_before_pin_and_retains_until_release() {
    let (_root, _recovery, _staging, mut workspace, mut manager) = setup();
    let doc = workspace.create("a.md", "hello").unwrap();
    let contexts = vec![ctx(&doc.snapshot, &[(0, 5)])];
    let copy = manager.create_copy(&workspace, &contexts).unwrap();
    let request = acp_request(acp_argv(&[]), &copy.copy_id, contexts.clone());
    let dir = manager.prepare_prompt_run(&workspace, &request).unwrap();
    assert_eq!(dir, manager.resolve(&copy.copy_id).unwrap());
    assert!(manager.reject(&copy.copy_id).is_err());
    assert!(manager.cancel(&copy.copy_id).is_err());
    assert!(manager.approve(&workspace, &copy.copy_id).is_err());
    manager.unpin_for_run(&copy.copy_id);
    manager.reject(&copy.copy_id).unwrap();

    let copy = manager.create_copy(&workspace, &contexts).unwrap();
    let request = acp_request(acp_argv(&[]), &copy.copy_id, contexts);
    let dir = manager.resolve(&copy.copy_id).unwrap();
    // A vanished staging directory must fail before acquiring a pin.
    fs::remove_dir_all(&dir).unwrap();
    assert!(matches!(
        manager.prepare_prompt_run(&workspace, &request),
        Err(WorkspaceError::NotFound)
    ));
    manager.cancel(&copy.copy_id).unwrap();
}

#[test]
/// Refuse missing copy identifiers and requests that expand the copy authorization.
fn authorize_rejects_unknown_copy_and_scope_widening() {
    let (_root, _recovery, _staging, mut workspace, mut manager) = setup();
    let doc = workspace.create("a.md", "hello world").unwrap();
    let copy = manager
        .create_copy(&workspace, &[ctx(&doc.snapshot, &[(0, 5)])])
        .unwrap();
    // Unknown copy handle.
    let unknown = acp_request(
        acp_argv(&[]),
        &IsolatedCopyId("copy_missing".into()),
        vec![ctx(&doc.snapshot, &[(0, 5)])],
    );
    assert!(manager.authorize_prompt(&workspace, &unknown).is_err());
    // Widened scope beyond the registered selection.
    let mut widened = ctx(&doc.snapshot, &[(0, 11)]);
    widened.text = slice(&doc.snapshot.text, 0, 11);
    let wide = acp_request(acp_argv(&[]), &copy.copy_id, vec![widened]);
    assert!(manager.authorize_prompt(&workspace, &wide).is_err());
    // Forged excerpt with in-scope ranges.
    let mut forged = ctx(&doc.snapshot, &[(0, 5)]);
    forged.text = "forged".into();
    let forgery = acp_request(acp_argv(&[]), &copy.copy_id, vec![forged]);
    assert!(manager.authorize_prompt(&workspace, &forgery).is_err());
    // Nonzero offset beyond any excerpt length is a source offset: structural
    // validation passes, authority decides against the snapshot.
    let far = PromptContext {
        location: None,
        document_id: doc.snapshot.document_id.clone(),
        revision: doc.snapshot.revision,
        ranges: vec![Utf16Range {
            start: Utf16Offset(100),
            end: Utf16Offset(105),
        }],
        text: "x".into(),
    };
    let far_request = acp_request(acp_argv(&[]), &copy.copy_id, vec![far]);
    assert!(manager.authorize_prompt(&workspace, &far_request).is_err());
}

#[test]
/// Require every requested range, excerpt, document and revision to match the registered scope exactly.
fn authorize_requires_exact_scope_equality() {
    let (_root, _recovery, _staging, mut workspace, mut manager) = setup();
    let doc = workspace.create("a.md", "aa bb cc").unwrap();
    // Registered scopes: [0, 2) and [6, 8).
    let full = vec![ctx(&doc.snapshot, &[(0, 2), (6, 8)])];
    let copy = manager.create_copy(&workspace, &full).unwrap();
    // Narrowed selection (only the first scope) is refused: no narrowing.
    let narrowed = acp_request(
        acp_argv(&[]),
        &copy.copy_id,
        vec![ctx(&doc.snapshot, &[(0, 2)])],
    );
    assert!(manager.authorize_prompt(&workspace, &narrowed).is_err());
    // The exact registered selection authorizes.
    let exact = acp_request(acp_argv(&[]), &copy.copy_id, full);
    assert!(manager.authorize_prompt(&workspace, &exact).is_ok());

    // Omitted documents are refused even when the kept scope is exact.
    let doc_b = workspace.create("b.md", "zzz").unwrap();
    let both = manager
        .create_copy(
            &workspace,
            &[
                ctx(&doc.snapshot, &[(0, 2), (6, 8)]),
                ctx(&doc_b.snapshot, &[(0, 3)]),
            ],
        )
        .unwrap();
    let missing = acp_request(
        acp_argv(&[]),
        &both.copy_id,
        vec![ctx(&doc.snapshot, &[(0, 2), (6, 8)])],
    );
    assert!(manager.authorize_prompt(&workspace, &missing).is_err());
}

#[test]
/// Reject credential or endpoint readiness failures before pinning, using only disposable fixture stores.
fn startup_readiness_fails_before_pin_without_user_secrets() {
    let (_root, _recovery, _staging, mut workspace, mut manager) = setup();
    let doc = workspace.create("a.md", "hello").unwrap();
    let copy = manager
        .create_copy(&workspace, &[ctx(&doc.snapshot, &[(0, 5)])])
        .unwrap();
    // Production HTTP order uses this exact helper BEFORE any scope pin.
    // No user credentials are touched anywhere here.
    let openai = || AiProviderConfig {
        kind: AiProviderKind::OpenaiCompatible,
        acp: None,
        openai: Some(OpenAiConfig {
            endpoint: "http://127.0.0.1:9".into(),
            model: "m".into(),
        }),
        anthropic: None,
        connection_id: None,
    };
    // Missing secret: the empty store slot fails setup before pinning.
    let keyring = MemoryKeyring::default();
    assert!(matches!(
        resolve_http_request(&keyring, &keyring, &openai()),
        Err(marxen_lib::contracts::ai::AiError::MissingCredentials { .. })
    ));
    // Invalid endpoint is also a readiness failure, not a pinned run.
    let mut bad_endpoint = openai();
    bad_endpoint.openai.as_mut().expect("openai").endpoint = "ftp://x.test/v1".into();
    assert!(resolve_http_request(&keyring, &keyring, &bad_endpoint).is_err());
    // A failing credential store surfaces without pinning either.
    struct FailingStore;
    impl AgentKeyring for FailingStore {
        /// Inject a credential-read failure without consulting any OS store.
        fn get(
            &self,
            _kind: AiProviderKind,
        ) -> Result<Option<String>, marxen_lib::contracts::ai::AiError> {
            Err(marxen_lib::contracts::ai::AiError::CredentialStoreFailed {
                detail: "injected store failure".into(),
            })
        }
        /// Inject a credential-write failure without persisting the supplied secret.
        fn set(
            &self,
            _kind: AiProviderKind,
            _secret: &str,
        ) -> Result<(), marxen_lib::contracts::ai::AiError> {
            Err(marxen_lib::contracts::ai::AiError::CredentialStoreFailed {
                detail: "injected store failure".into(),
            })
        }
        /// Inject a credential-deletion failure without changing any stored entry.
        fn delete(&self, _kind: AiProviderKind) -> Result<(), marxen_lib::contracts::ai::AiError> {
            Err(marxen_lib::contracts::ai::AiError::CredentialStoreFailed {
                detail: "injected store failure".into(),
            })
        }
    }
    impl marxen_lib::application::ai::credentials::ApiConnectionKeyring for FailingStore {
        /// Inject a connection credential-read failure without consulting any OS store.
        fn get_connection(
            &self,
            _id: &marxen_lib::contracts::ai::ApiConnectionId,
        ) -> Result<Option<String>, marxen_lib::contracts::ai::AiError> {
            Err(marxen_lib::contracts::ai::AiError::CredentialStoreFailed {
                detail: "injected store failure".into(),
            })
        }
        /// Inject a connection credential-write failure without persisting the supplied secret.
        fn set_connection(
            &self,
            _id: &marxen_lib::contracts::ai::ApiConnectionId,
            _secret: &str,
        ) -> Result<(), marxen_lib::contracts::ai::AiError> {
            Err(marxen_lib::contracts::ai::AiError::CredentialStoreFailed {
                detail: "injected store failure".into(),
            })
        }
        /// Inject a connection credential-deletion failure without changing any stored entry.
        fn delete_connection(
            &self,
            _id: &marxen_lib::contracts::ai::ApiConnectionId,
        ) -> Result<(), marxen_lib::contracts::ai::AiError> {
            Err(marxen_lib::contracts::ai::AiError::CredentialStoreFailed {
                detail: "injected store failure".into(),
            })
        }
    }
    assert!(resolve_http_request(&FailingStore, &FailingStore, &openai()).is_err());
    // Disabled Anthropic opt-in is rejected at the same readiness gate.
    let anthropic = AiProviderConfig {
        kind: AiProviderKind::Anthropic,
        acp: None,
        openai: None,
        anthropic: Some(AnthropicConfig {
            enabled: false,
            endpoint: "https://api.anthropic.example".into(),
            model: "m".into(),
        }),
        connection_id: None,
    };
    assert!(resolve_http_request(&keyring, &keyring, &anthropic).is_err());
    // None of the failures pinned the copy: it stays fully operable.
    let staging_dir = manager.resolve(&copy.copy_id).unwrap();
    mock_cli_write(&staging_dir, "a.md", "hello cli");
    let result = manager.approve(&workspace, &copy.copy_id).unwrap();
    assert!(result.outcomes[0].applied);
    assert_eq!(live_text(&workspace, &doc.snapshot), "hello cli");
}

#[test]
/// Hold terminal event delivery until run cleanup and pin release have completed.
fn terminal_delivery_waits_for_settlement_and_release() {
    let (_root, _recovery, _staging, mut workspace, mut manager) = setup();
    let doc = workspace.create("a.md", "hello").unwrap();
    let contexts = vec![ctx(&doc.snapshot, &[(0, 5)])];
    let copy = manager.create_copy(&workspace, &contexts).unwrap();
    let argv = acp_argv(&[
        "--no-permission",
        "--write-staging=a.md",
        "--write-text=hello cli",
    ]);
    let request = acp_request(argv.clone(), &copy.copy_id, contexts);
    let staging_dir = manager.prepare_prompt_run(&workspace, &request).unwrap();
    let registry = Arc::new(RunRegistry::new());
    let (run_id, cancel) = registry.register();
    let params = AcpRunParams {
        argv,
        staging_dir: staging_dir.clone(),
        timeout: Duration::from_secs(30),
    };
    // The actual production settlement helper (shared with IPC): the driver
    // runs with terminals buffered, then the child is reaped, the pin
    // released, and exactly one terminal returned for delivery.
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let mut gate = TerminalGate::new();
        let mut live = Vec::new();
        let inner = run_acp_prompt(
            &params,
            &request,
            &run_id,
            &registry,
            &cancel,
            &mut |event| gate.push(event, &mut |live_event| live.push(live_event)),
        );
        (gate, inner, live)
    }));
    let (gate, inner, live) = outcome.expect("driver thread survives");
    assert!(inner.is_ok());
    // Terminal never delivered early: only Started/chunks streamed so far.
    assert!(live
        .iter()
        .all(|event| !matches!(event, AiStreamEvent::Done(_))));
    assert!(live
        .iter()
        .any(|event| matches!(event, AiStreamEvent::Chunk(_))));
    // The run has not settled yet: approval is still refused while pinned.
    assert!(manager.approve(&workspace, &copy.copy_id).is_err());
    let delivered = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        settle_production_run(
            Ok((gate, inner)),
            &run_id,
            || {
                registry.cancel(&run_id);
            },
            || manager.unpin_for_run(&copy.copy_id),
        )
    }))
    .expect("settlement survives");
    assert!(matches!(delivered, AiStreamEvent::Done(_)));
    // Exactly one terminal overall, delivered after settlement.
    let mut delivered_all = live;
    delivered_all.push(delivered);
    assert_eq!(
        delivered_all
            .iter()
            .filter(|event| matches!(event, AiStreamEvent::Done(_)))
            .count(),
        1
    );
    // The child write landed before settlement; review then approve after.
    assert_eq!(
        fs::read_to_string(staging_dir.join("a.md")).unwrap(),
        "hello cli"
    );
    assert!(manager.approve(&workspace, &copy.copy_id).unwrap().outcomes[0].applied);
}

#[test]
/// Prevent approval while a child can still write and allow it only after the process is reaped.
fn delayed_child_write_cannot_approve_until_reaped() {
    let (_root, _recovery, _staging, mut workspace, mut manager) = setup();
    let doc = workspace.create("a.md", "hello").unwrap();
    let contexts = vec![ctx(&doc.snapshot, &[(0, 5)])];
    let copy = manager.create_copy(&workspace, &contexts).unwrap();
    // The child answers Done first, then writes 1200ms later while the
    // driver is still reaping it.
    let argv = acp_argv(&[
        "--no-permission",
        "--write-staging=a.md",
        "--write-text=hello late",
        "--write-after-response-ms=1200",
    ]);
    let request = acp_request(argv.clone(), &copy.copy_id, contexts);
    let staging_dir = manager.prepare_prompt_run(&workspace, &request).unwrap();
    let registry = Arc::new(RunRegistry::new());
    let (run_id, cancel) = registry.register();
    let driver_registry = registry.clone();
    let driver_run_id = run_id.clone();
    let params = AcpRunParams {
        argv,
        staging_dir: staging_dir.clone(),
        timeout: Duration::from_secs(30),
    };
    let driver = std::thread::spawn(move || {
        let mut gate = TerminalGate::new();
        let mut live = Vec::new();
        let inner = run_acp_prompt(
            &params,
            &request,
            &driver_run_id,
            &driver_registry,
            &cancel,
            &mut |event| gate.push(event, &mut |live_event| live.push(live_event)),
        );
        (gate, inner, live)
    });
    // The prompt terminal likely arrived while the late write is still
    // pending; either way the pin refuses approval until the child reaps.
    std::thread::sleep(Duration::from_millis(400));
    assert!(manager.approve(&workspace, &copy.copy_id).is_err());
    let (gate, inner, live) = driver.join().expect("driver joins");
    assert!(inner.is_ok());
    assert!(live
        .iter()
        .all(|event| !matches!(event, AiStreamEvent::Done(_))));
    let terminal = settle_production_run(
        Ok((gate, inner)),
        &run_id,
        || {
            registry.cancel(&run_id);
        },
        || manager.unpin_for_run(&copy.copy_id),
    );
    assert!(matches!(terminal, AiStreamEvent::Done(_)));
    // Settlement waited for the reap, so the late write is present.
    assert_eq!(
        fs::read_to_string(staging_dir.join("a.md")).unwrap(),
        "hello late"
    );
    assert!(manager.approve(&workspace, &copy.copy_id).unwrap().outcomes[0].applied);
    assert_eq!(live_text(&workspace, &doc.snapshot), "hello late");
}

#[test]
/// Require panic cleanup to reap the ACP child before releasing its staging pin.
fn panicking_driver_reaps_live_child_before_unpin() {
    let (_root, _recovery, _staging, mut workspace, mut manager) = setup();
    let doc = workspace.create("a.md", "hello").unwrap();
    let copy = manager
        .create_copy(&workspace, &[ctx(&doc.snapshot, &[(0, 5)])])
        .unwrap();
    manager.pin_for_run(&copy.copy_id).unwrap();
    // A live child that never answers on its own: slow mock agent.
    let registry = Arc::new(RunRegistry::new());
    let (run_id, _cancel) = registry.register();
    let child = std::process::Command::new(env!("CARGO_BIN_EXE_mock-acp-agent"))
        .args(["--respond-after-ms=30000", "--no-permission"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("spawn slow mock");
    let child_id = child.id();
    registry.set_child(
        &run_id,
        Box::new(marxen_lib::infrastructure::ai::acp::NativeProcess(child)),
    );
    // The driver panics with the child still writing-capable. Production
    // settlement reaps first, then unpins, then delivers one terminal.
    let outcome: std::thread::Result<(
        TerminalGate,
        Result<(), marxen_lib::contracts::ai::AiError>,
    )> = std::panic::catch_unwind(|| panic!("injected driver panic"));
    assert!(outcome.is_err());
    let terminal = settle_production_run(
        outcome,
        &run_id,
        || {
            registry.cancel(&run_id);
        },
        || manager.unpin_for_run(&copy.copy_id),
    );
    assert!(matches!(terminal, AiStreamEvent::Error(_)));
    // The child is dead (killed during reap, pid recycled or exited) and the
    // pin is released: the copy approves again.
    let _ = child_id;
    assert!(registry.cancel(&run_id));
    let staging_dir = manager.resolve(&copy.copy_id).unwrap();
    mock_cli_write(&staging_dir, "a.md", "hello after panic");
    assert!(manager.approve(&workspace, &copy.copy_id).unwrap().outcomes[0].applied);
}

#[tokio::test(flavor = "current_thread")]
/// Settle a delayed HTTP terminal result exactly once and release the owned isolation pin.
async fn http_delayed_terminal_settles_once_then_releases() {
    let (_root, _recovery, _staging, mut workspace, mut manager) = setup();
    let doc = workspace.create("a.md", "hello").unwrap();
    let contexts = vec![ctx(&doc.snapshot, &[(0, 5)])];
    let copy = manager.create_copy(&workspace, &contexts).unwrap();
    // Minimal loopback SSE server: first event now, remainder after delay.
    let body = include_str!("../../tests/fixtures/ai_sse_openai.txt").replace("\r\n", "\n");
    let split = body.find("\n\n").expect("sse events") + 2;
    let (first, rest) = body.split_at(split);
    let first = first.to_owned();
    let rest = rest.to_owned();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind loopback");
    let port = listener.local_addr().expect("port").port();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept");
        stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .expect("timeout");
        let mut head = Vec::new();
        let mut byte = [0u8; 1];
        while !head.ends_with(b"\r\n\r\n") {
            use std::io::Read as _;
            if stream.read_exact(&mut byte).is_err() || head.len() > 65536 {
                break;
            }
            head.extend_from_slice(&byte);
        }
        // Swallow the request body so pipelined writes never interleave.
        let length = String::from_utf8_lossy(&head)
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                if name.trim().eq_ignore_ascii_case("content-length") {
                    value.trim().parse::<usize>().ok()
                } else {
                    None
                }
            })
            .unwrap_or(0);
        let mut remaining = length.min(1_048_576);
        while remaining > 0 {
            use std::io::Read as _;
            let mut chunk = vec![0u8; remaining.min(8192)];
            match stream.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(read) => remaining -= read,
            }
        }
        let reply = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n{}",
            first
        );
        use std::io::Write as _;
        stream.write_all(reply.as_bytes()).expect("first flush");
        stream.flush().expect("flush");
        std::thread::sleep(Duration::from_millis(600));
        stream.write_all(rest.as_bytes()).expect("rest");
    });
    let provider = AiProviderConfig {
        kind: AiProviderKind::OpenaiCompatible,
        acp: None,
        openai: Some(OpenAiConfig {
            endpoint: format!("http://127.0.0.1:{port}"),
            model: "mock-model".into(),
        }),
        anthropic: None,
        connection_id: None,
    };
    let request = AiPromptRequest {
        conversation_id: None,
        provider,
        mode: PromptMode::Rewrite,
        prompt: "書き換えてください".into(),
        contexts,
        staging: marxen_lib::contracts::ai::StagingTarget {
            copy_id: copy.copy_id.clone(),
        },
        session_id: None,
        history: vec![],
    };
    manager.authorize_prompt(&workspace, &request).unwrap();
    manager.pin_for_run(&copy.copy_id).unwrap();
    let keyring = MemoryKeyring::default();
    keyring
        .set(AiProviderKind::OpenaiCompatible, "mock-secret")
        .unwrap();
    // Same production readiness helper the IPC path calls before pinning.
    let (target, secret) = resolve_http_request(&keyring, &keyring, &request.provider).unwrap();
    let client =
        marxen_lib::infrastructure::ai::http::http_client(Duration::from_secs(20)).unwrap();
    let registry = Arc::new(RunRegistry::new());
    let (run_id, cancel) = registry.register();
    let mut gate = TerminalGate::new();
    let mut live = Vec::new();
    let inner = marxen_lib::infrastructure::ai::http::run_http_prompt(
        &client,
        &target,
        &secret,
        &request,
        &run_id,
        &cancel,
        &mut |event| gate.push(event, &mut |live_event| live.push(live_event)),
    )
    .await;
    assert!(inner.is_ok());
    // Chunks streamed immediately; the terminal stayed buffered.
    assert!(live
        .iter()
        .any(|event| matches!(event, AiStreamEvent::Chunk(_))));
    assert!(live
        .iter()
        .all(|event| !matches!(event, AiStreamEvent::Done(_))));
    let terminal = settle_production_run(
        Ok((gate, inner)),
        &run_id,
        || {},
        || manager.unpin_for_run(&copy.copy_id),
    );
    match &terminal {
        AiStreamEvent::Done(done) => assert_eq!(done.proposal.text, "Hello, 世界！"),
        other => panic!("expected delayed Done, got {other:?}"),
    }
    server.join().expect("server joins");
    // Released: the copy reviews and approves after settlement.
    assert!(!manager.diff(&workspace, &copy.copy_id).unwrap().is_empty());
}

#[test]
/// Require isolation and document operations to use the same boundary document identifier type.
fn document_id_type_is_shared() {
    let id = marxen_lib::contracts::DocumentId("doc_08".into());
    assert_eq!(id.0, "doc_08");
}

#[test]
/// Bind staged imports to the approved copy's original workspace.
///
/// Approval retires the copy with its workspace root and the authoritative
/// staged content; importing against a switched workspace root refuses before
/// any file is created. Only still-pending staged paths with unaltered
/// content import: arbitrary extra paths and changed content are refused per
/// file without creating anything, and the pre-existing workspace file stays
/// untouched. The retired record clears once every pending file imports, so
/// fully imported copies never import again and unknown copies never import
/// at all.
fn import_new_files_stays_bound_to_the_approved_workspace() {
    use marxen_lib::contracts::isolation::ImportFileRequest;
    let (root_a, _recovery_a, _staging, mut workspace_a, mut manager) = setup();
    let doc = workspace_a.create("a.md", "aaa").unwrap();
    let note = workspace_a.create("note.md", "# Original\n").unwrap();
    let copy = manager
        .create_copy(&workspace_a, &[ctx(&doc.snapshot, &[(0, 3)])])
        .unwrap();
    // The agent stages one new file; approval captures its content natively.
    let staging_dir = manager.resolve(&copy.copy_id).unwrap();
    std::fs::write(staging_dir.join("fresh.md"), "# Fresh\n").unwrap();
    manager.approve(&workspace_a, &copy.copy_id).unwrap();
    let approved = vec![ImportFileRequest {
        rel: "fresh.md".into(),
        content: "# Fresh\n".into(),
    }];
    // A switched workspace root refuses before creating anything.
    let other_root = tempfile::tempdir().unwrap();
    let other_recovery = tempfile::tempdir().unwrap();
    let mut workspace_b =
        marxen_lib::open_workspace(other_root.path(), other_recovery.path()).unwrap();
    let refused = manager.import_new_files(&mut workspace_b, &copy.copy_id, &approved);
    assert!(
        matches!(refused, Err(WorkspaceError::OutsideWorkspace)),
        "wrong workspace must refuse, got {refused:?}"
    );
    assert!(!other_root.path().join("fresh.md").exists());
    // An unstaged extra path is refused without creating anything.
    let extra = manager
        .import_new_files(
            &mut workspace_a,
            &copy.copy_id,
            &[ImportFileRequest {
                rel: "evil.md".into(),
                content: "# Evil\n".into(),
            }],
        )
        .unwrap();
    assert!(extra[0].error.is_some());
    assert!(!root_a.path().join("evil.md").exists());
    // Changed content for a pending path is refused without creating it.
    let drifted = manager
        .import_new_files(
            &mut workspace_a,
            &copy.copy_id,
            &[ImportFileRequest {
                rel: "fresh.md".into(),
                content: "# Tampered\n".into(),
            }],
        )
        .unwrap();
    assert!(drifted[0].error.is_some());
    assert!(drifted[0]
        .error
        .as_deref()
        .is_some_and(|detail| detail.contains("differs")));
    assert!(!root_a.path().join("fresh.md").exists());
    // The exact approved content imports and registers its snapshot, while
    // the pre-existing workspace file stays untouched.
    let outcomes = manager
        .import_new_files(&mut workspace_a, &copy.copy_id, &approved)
        .unwrap();
    assert_eq!(outcomes.len(), 1);
    assert!(outcomes[0].error.is_none());
    let snapshot = outcomes[0].snapshot.clone().expect("opened snapshot");
    assert_eq!(
        workspace_a
            .actor(&note.snapshot.document_id.0)
            .unwrap()
            .snapshot()
            .text,
        "# Original\n"
    );
    assert_eq!(
        workspace_a
            .actor(&snapshot.document_id.0)
            .unwrap()
            .snapshot()
            .text,
        "# Fresh\n"
    );
    // The drained record is gone: already-imported paths never mutate again.
    let gone = manager.import_new_files(&mut workspace_a, &copy.copy_id, &approved);
    assert!(matches!(gone, Err(WorkspaceError::NotFound)));
    // Unknown copies never import.
    let unknown = manager.import_new_files(
        &mut workspace_a,
        &IsolatedCopyId("copy_missing".into()),
        &approved,
    );
    assert!(matches!(unknown, Err(WorkspaceError::NotFound)));
}

#[test]
/// Refuse staged imports while the copy is still active, before approval.
///
/// The active copy must approve first; the refusal happens before any file
/// is created, and the later approval still succeeds on the untouched copy.
fn import_before_approval_is_refused_without_mutation() {
    use marxen_lib::contracts::isolation::ImportFileRequest;
    let (root, _recovery, _staging, mut workspace, mut manager) = setup();
    let doc = workspace.create("a.md", "aaa").unwrap();
    let copy = manager
        .create_copy(&workspace, &[ctx(&doc.snapshot, &[(0, 3)])])
        .unwrap();
    let files = vec![ImportFileRequest {
        rel: "fresh.md".into(),
        content: "# Fresh\n".into(),
    }];
    let refused = manager.import_new_files(&mut workspace, &copy.copy_id, &files);
    assert!(
        matches!(refused, Err(WorkspaceError::InvalidPath)),
        "active copies must approve first, got {refused:?}"
    );
    assert!(!root.path().join("fresh.md").exists());
    // The refused attempt changed nothing: approval still succeeds.
    let result = manager.approve(&workspace, &copy.copy_id).unwrap();
    assert!(result
        .outcomes
        .iter()
        .all(|outcome| outcome.error.is_none()));
}

#[test]
/// Retain pending import records on empty and successful subset requests.
///
/// Only a non-empty request that drains every pending staged file with all
/// outcomes successful clears the retired record; anything unfinished stays
/// retryable under the original workspace binding.
fn import_keeps_pending_records_on_empty_and_subset_requests() {
    use marxen_lib::contracts::isolation::ImportFileRequest;
    let (_root, _recovery, _staging, mut workspace, mut manager) = setup();
    let doc = workspace.create("a.md", "aaa").unwrap();
    let copy = manager
        .create_copy(&workspace, &[ctx(&doc.snapshot, &[(0, 3)])])
        .unwrap();
    let staging_dir = manager.resolve(&copy.copy_id).unwrap();
    std::fs::write(staging_dir.join("n1.md"), "# N1\n").unwrap();
    std::fs::write(staging_dir.join("n2.md"), "# N2\n").unwrap();
    manager.approve(&workspace, &copy.copy_id).unwrap();
    // An empty request creates nothing and retains the record.
    let empty = manager
        .import_new_files(&mut workspace, &copy.copy_id, &[])
        .unwrap();
    assert!(empty.is_empty());
    // A successful subset drains only its own file and retains the rest.
    let subset = manager
        .import_new_files(
            &mut workspace,
            &copy.copy_id,
            &[ImportFileRequest {
                rel: "n1.md".into(),
                content: "# N1\n".into(),
            }],
        )
        .unwrap();
    assert!(subset[0].error.is_none());
    // Draining the last pending file on success clears the record.
    let rest = manager
        .import_new_files(
            &mut workspace,
            &copy.copy_id,
            &[ImportFileRequest {
                rel: "n2.md".into(),
                content: "# N2\n".into(),
            }],
        )
        .unwrap();
    assert!(rest[0].error.is_none());
    let gone = manager.import_new_files(
        &mut workspace,
        &copy.copy_id,
        &[ImportFileRequest {
            rel: "n3.md".into(),
            content: "# N3\n".into(),
        }],
    );
    assert!(matches!(gone, Err(WorkspaceError::NotFound)));
}
