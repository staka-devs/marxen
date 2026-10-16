use marxen_lib::application::root_registry::RootRegistry;
use marxen_lib::contracts::ai::*;
use marxen_lib::contracts::*;
use marxen_lib::domain::storage::{fingerprint, RecoveryRecord};
use std::fs;
use tempfile::TempDir;

/// Register two native roots with the same relative document and different disk contents.
fn roots() -> (
    TempDir,
    TempDir,
    TempDir,
    RootRegistry,
    WorkspaceInfo,
    WorkspaceInfo,
) {
    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();
    let recovery = tempfile::tempdir().unwrap();
    fs::write(first.path().join("same.md"), "first").unwrap();
    fs::write(second.path().join("same.md"), "second").unwrap();
    let mut registry = RootRegistry::default();
    let a = registry
        .register(marxen_lib::open_workspace(first.path(), recovery.path()).unwrap())
        .unwrap();
    let b = registry
        .register(marxen_lib::open_workspace(second.path(), recovery.path()).unwrap())
        .unwrap();
    (first, second, recovery, registry, a, b)
}

/// Open the same relative name through its exact registered owner.
fn document(registry: &mut RootRegistry, info: &WorkspaceInfo) -> DocumentSnapshot {
    registry
        .workspace_mut(&info.scope)
        .unwrap()
        .open_markdown("same.md")
        .unwrap()
        .snapshot
}

/// Bind a mutation to its authoritative revision and captured root-relative location.
fn request(snapshot: &DocumentSnapshot) -> SaveRequest {
    SaveRequest {
        location: snapshot.location.clone(),
        document_id: snapshot.document_id.clone(),
        base_revision: snapshot.revision,
    }
}

/// Replace text only after the registry authorizes the captured owner and location.
fn edit(registry: &mut RootRegistry, snapshot: &DocumentSnapshot, text: &str) -> DocumentSnapshot {
    registry
        .document_mut(&snapshot.document_id.0, snapshot.location.as_ref().unwrap())
        .unwrap()
        .actor(&snapshot.document_id.0)
        .unwrap()
        .apply_edits(EditRequest {
            document_id: snapshot.document_id.clone(),
            base_revision: snapshot.revision,
            source: EditSource::Gui,
            edits: vec![TextEdit {
                range: Utf16Range {
                    start: Utf16Offset(0),
                    end: Utf16Offset(snapshot.text.encode_utf16().count() as u32),
                },
                text: text.into(),
            }],
        })
        .unwrap()
}

#[test]
/// Keep same-name buffers, native saves, Undo, search, and event owners independent.
fn same_relative_name_keeps_native_owners_save_undo_search_and_events() {
    let (first, second, _recovery, mut registry, a, b) = roots();
    let left = document(&mut registry, &a);
    let right = document(&mut registry, &b);
    assert_ne!(left.document_id, right.document_id);
    let changed = edit(&mut registry, &left, "changed😀");
    registry
        .document_mut(&left.document_id.0, left.location.as_ref().unwrap())
        .unwrap()
        .actor(&left.document_id.0)
        .unwrap()
        .save(request(&changed))
        .unwrap();
    assert_eq!(
        fs::read_to_string(first.path().join("same.md")).unwrap(),
        "changed😀"
    );
    assert_eq!(
        fs::read_to_string(second.path().join("same.md")).unwrap(),
        "second"
    );
    let undone = registry
        .document_mut(&left.document_id.0, left.location.as_ref().unwrap())
        .unwrap()
        .actor(&left.document_id.0)
        .unwrap()
        .undo()
        .unwrap();
    assert_eq!(undone.text, "first");
    assert!(undone.dirty);
    let hits = registry
        .workspace_mut(&a.scope)
        .unwrap()
        .search("first")
        .unwrap();
    assert_eq!(hits[0].document_id.as_ref(), Some(&left.document_id));
    assert_eq!(hits[0].scope.as_ref(), Some(&a.scope));
    assert!(registry
        .workspace_mut(&b.scope)
        .unwrap()
        .search("first")
        .unwrap()
        .is_empty());
    fs::write(first.path().join("same.md"), "external-first").unwrap();
    let events = registry.poll();
    assert!(events.iter().any(|event| event.scope == a.scope));
    assert_eq!(
        registry
            .workspace_mut(&b.scope)
            .unwrap()
            .actor(&right.document_id.0)
            .unwrap()
            .snapshot()
            .text,
        "second"
    );
}

#[test]
/// Reject a foreign owner, forged root, stale generation and rename roundtrip at unchanged text revision.
fn owner_generation_and_renamed_position_fail_closed() {
    let (_first, _second, _recovery, mut registry, a, b) = roots();
    let snapshot = document(&mut registry, &a);
    let searched = registry
        .workspace_mut(&a.scope)
        .unwrap()
        .search("first")
        .unwrap()
        .remove(0);
    let original = snapshot.location.clone().unwrap();
    let mut foreign = original.clone();
    foreign.scope = b.scope;
    assert!(matches!(
        registry.document_mut(&snapshot.document_id.0, &foreign),
        Err(WorkspaceError::WrongOwner)
    ));
    let mut forged = a.scope.clone();
    forged.root_id = RootId("forged".into());
    assert!(matches!(
        registry.workspace_mut(&forged),
        Err(WorkspaceError::UnknownRoot)
    ));
    let mut stale = original.clone();
    stale.scope.generation.push('x');
    assert!(matches!(
        registry.document_mut(&snapshot.document_id.0, &stale),
        Err(WorkspaceError::StaleRoot)
    ));
    let renamed = registry
        .document_mut(&snapshot.document_id.0, &original)
        .unwrap()
        .rename(request(&snapshot), "renamed.md")
        .unwrap();
    assert_eq!(renamed.snapshot.revision, snapshot.revision);
    assert!(matches!(
        registry.document_mut(&snapshot.document_id.0, &original),
        Err(WorkspaceError::StaleLocation)
    ));
    assert!(matches!(
        registry
            .workspace_mut(&a.scope)
            .unwrap()
            .plan_search_replacement(SearchReplaceRequest {
                scope: searched.scope,
                location: searched.location,
                document_id: searched.document_id,
                root: a.root.clone(),
                path: searched.path,
                query: "first".into(),
                options: SearchOptions::default(),
                replacement: "changed".into(),
                content_token: searched.content_token,
                revision: searched.revision,
                range: None,
            }),
        Err(WorkspaceError::StaleLocation)
    ));
    let returned = registry
        .document_mut(
            &snapshot.document_id.0,
            renamed.snapshot.location.as_ref().unwrap(),
        )
        .unwrap()
        .rename(request(&renamed.snapshot), "same.md")
        .unwrap();
    assert_eq!(
        returned.snapshot.location.as_ref().unwrap().path,
        original.path
    );
    assert!(matches!(
        registry.document_mut(&snapshot.document_id.0, &original),
        Err(WorkspaceError::StaleLocation)
    ));
    assert!(matches!(
        registry
            .workspace_mut(&a.scope)
            .unwrap()
            .open_markdown("../same.md"),
        Err(WorkspaceError::InvalidPath | WorkspaceError::OutsideWorkspace)
    ));
}

#[test]
/// Reopening preserves stable root identity but refuses all handles from the removed incarnation.
fn reopen_never_redirects_old_handles_to_the_current_root() {
    let (first, _second, recovery, mut registry, a, b) = roots();
    let snapshot = document(&mut registry, &a);
    assert!(matches!(
        registry.register(marxen_lib::open_workspace(first.path(), recovery.path()).unwrap()),
        Err(WorkspaceError::AlreadyExists)
    ));
    let fresh = registry
        .replace(marxen_lib::open_workspace(first.path(), recovery.path()).unwrap())
        .unwrap();
    assert_eq!(fresh.scope.root_id, a.scope.root_id);
    assert_ne!(fresh.scope.generation, a.scope.generation);
    assert!(matches!(
        registry.document_mut(&snapshot.document_id.0, snapshot.location.as_ref().unwrap()),
        Err(WorkspaceError::StaleRoot)
    ));
    assert!(matches!(
        registry.workspace_mut(&b.scope),
        Err(WorkspaceError::UnknownRoot)
    ));
    assert_ne!(
        document(&mut registry, &fresh).document_id,
        snapshot.document_id
    );
}

#[test]
/// Resolve images through the document's owner even when another root has the same relative name.
fn images_resolve_only_inside_the_captured_document_root() {
    let (first, second, _recovery, mut registry, a, b) = roots();
    let mut png_a = b"\x89PNG\r\n\x1a\n".to_vec();
    png_a.push(1);
    let mut png_b = b"\x89PNG\r\n\x1a\n".to_vec();
    png_b.push(2);
    fs::write(first.path().join("same.png"), &png_a).unwrap();
    fs::write(second.path().join("same.png"), &png_b).unwrap();
    for (info, expected) in [(&a, png_a), (&b, png_b)] {
        let snapshot = document(&mut registry, info);
        let workspace = registry
            .document_mut(&snapshot.document_id.0, snapshot.location.as_ref().unwrap())
            .unwrap();
        assert_eq!(
            workspace
                .load_image(&snapshot.document_id.0, "same.png")
                .unwrap()
                .bytes,
            expected
        );
        assert!(workspace
            .load_image(&snapshot.document_id.0, "../../same.png")
            .is_err());
    }
}

/// Write the previous recovery wire shape with an intentionally shared legacy document ID.
fn legacy_record(
    root: &std::path::Path,
    recovery: &std::path::Path,
) -> (std::path::PathBuf, Vec<u8>) {
    let root = fs::canonicalize(root).unwrap();
    let namespace = fingerprint(root.to_str().unwrap().as_bytes()).0;
    let record_path = recovery
        .join(namespace)
        .join(format!("{}.json", fingerprint(b"shared-legacy-id").0));
    fs::create_dir_all(record_path.parent().unwrap()).unwrap();
    let record = RecoveryRecord {
        version: 1,
        root_id: None,
        root,
        path: None,
        baseline: None,
        snapshot: DocumentSnapshot {
            location: None,
            document_id: DocumentId("shared-legacy-id".into()),
            revision: Revision(7),
            text: "unsaved😀".into(),
            dirty: true,
        },
    };
    let bytes = serde_json::to_vec(&record).unwrap();
    fs::write(&record_path, &bytes).unwrap();
    (record_path, bytes)
}

#[test]
/// Migrate colliding pathless v1 IDs into distinct root-owned v2 records without losing unsaved text.
fn recovery_v1_migrates_after_checkpoint_success_and_v2_reopens() {
    let (first, second, recovery, mut registry, a, b) = roots();
    let mut ids = Vec::new();
    for (root, info) in [(first.path(), &a), (second.path(), &b)] {
        let (old, bytes) = legacy_record(root, recovery.path());
        assert_eq!(fs::read(&old).unwrap(), bytes);
        let entry = registry
            .workspace_mut(&info.scope)
            .unwrap()
            .recovery_entries()
            .unwrap()
            .remove(0);
        let restored = registry
            .recovery_mut(&entry.document_id.0, &entry.location)
            .unwrap()
            .restore(&entry.document_id.0)
            .unwrap();
        assert_eq!(restored.snapshot.text, "unsaved😀");
        assert!(restored.snapshot.dirty);
        assert_eq!(restored.snapshot.revision, Revision(7));
        assert!(!old.exists());
        ids.push(restored.snapshot.document_id);
    }
    assert_ne!(ids[0], ids[1]);
    drop(registry);
    let mut reopened = marxen_lib::open_workspace(first.path(), recovery.path()).unwrap();
    let restored = reopened.restore(&ids[0].0).unwrap();
    assert_eq!(restored.snapshot.text, "unsaved😀");
    assert_eq!(
        restored.snapshot.location.as_ref().unwrap().scope,
        *reopened.scope()
    );
}

#[test]
/// Reject a migration destination collision while preserving the original v1 bytes exactly.
fn recovery_collision_preserves_v1_bytes() {
    let (first, _second, recovery, mut registry, a, _b) = roots();
    let (old, bytes) = legacy_record(first.path(), recovery.path());
    let id = format!(
        "legacy-{}-{}",
        &a.scope.root_id.0[5..],
        &fingerprint(b"shared-legacy-id").0[..32]
    );
    let destination = old
        .parent()
        .unwrap()
        .join(format!("{}.json", fingerprint(id.as_bytes()).0));
    fs::write(destination, &bytes).unwrap();
    assert!(registry
        .workspace_mut(&a.scope)
        .unwrap()
        .restore("shared-legacy-id")
        .is_err());
    assert_eq!(fs::read(old).unwrap(), bytes);
}

#[test]
/// Reject foreign roots and traversal in v1 records, then restore and save the valid original file.
fn legacy_file_recovery_validates_owner_and_path_before_native_save() {
    let (first, second, recovery, mut registry, a, _b) = roots();
    let (old, bytes) = legacy_record(first.path(), recovery.path());
    let mut record: RecoveryRecord = serde_json::from_slice(&bytes).unwrap();
    record.path = Some("same.md".into());
    record.baseline = Some(fingerprint(b"first"));
    let owned_root = record.root.clone();
    record.root = fs::canonicalize(second.path()).unwrap();
    fs::write(&old, serde_json::to_vec(&record).unwrap()).unwrap();
    assert!(registry
        .workspace_mut(&a.scope)
        .unwrap()
        .recovery_entries()
        .is_err());
    record.root = owned_root;
    record.path = Some("../same.md".into());
    fs::write(&old, serde_json::to_vec(&record).unwrap()).unwrap();
    assert!(registry
        .workspace_mut(&a.scope)
        .unwrap()
        .recovery_entries()
        .is_err());
    record.path = Some("same.md".into());
    fs::write(&old, serde_json::to_vec(&record).unwrap()).unwrap();
    let restored = registry
        .workspace_mut(&a.scope)
        .unwrap()
        .restore("shared-legacy-id")
        .unwrap();
    registry
        .document_mut(
            &restored.snapshot.document_id.0,
            restored.snapshot.location.as_ref().unwrap(),
        )
        .unwrap()
        .actor(&restored.snapshot.document_id.0)
        .unwrap()
        .save(request(&restored.snapshot))
        .unwrap();
    assert_eq!(
        fs::read_to_string(first.path().join("same.md")).unwrap(),
        "unsaved😀"
    );
    assert_eq!(
        fs::read_to_string(second.path().join("same.md")).unwrap(),
        "second"
    );
}

/// Capture a full-document context with the native root and renamed-position guard.
fn context(snapshot: &DocumentSnapshot) -> PromptContext {
    PromptContext {
        location: snapshot.location.clone(),
        document_id: snapshot.document_id.clone(),
        revision: snapshot.revision,
        ranges: vec![Utf16Range {
            start: Utf16Offset(0),
            end: Utf16Offset(snapshot.text.encode_utf16().count() as u32),
        }],
        text: snapshot.text.clone(),
    }
}

#[test]
/// Isolation captures one owner and refuses mixed roots, renamed scopes and a chat moved to another root.
fn isolation_and_conversation_keep_their_captured_owner() {
    let (_first, _second, _recovery, mut registry, a, b) = roots();
    let staging = tempfile::tempdir().unwrap();
    let mut manager = marxen_lib::open_isolation(staging.path()).unwrap();
    let left = document(&mut registry, &a);
    let right = document(&mut registry, &b);
    assert!(manager
        .create_copy(
            registry.workspace_mut(&a.scope).unwrap(),
            &[context(&left), context(&right)]
        )
        .is_err());
    let copy_a = manager
        .create_copy(registry.workspace_mut(&a.scope).unwrap(), &[context(&left)])
        .unwrap();
    assert_eq!(manager.owner(&copy_a.copy_id).unwrap(), a.scope);
    assert!(manager
        .diff(registry.workspace_mut(&b.scope).unwrap(), &copy_a.copy_id)
        .is_err());
    let mut prompt = AiPromptRequest {
        conversation_id: Some("same-chat".into()),
        provider: AiProviderConfig {
            kind: AiProviderKind::Acp,
            acp: None,
            openai: None,
            anthropic: None,
            connection_id: None,
        },
        mode: PromptMode::Ask,
        prompt: "question".into(),
        contexts: vec![context(&left)],
        staging: StagingTarget {
            copy_id: copy_a.copy_id.clone(),
        },
        session_id: None,
        history: vec![],
    };
    manager
        .prepare_prompt_run(registry.workspace_mut(&a.scope).unwrap(), &prompt)
        .unwrap();
    manager.unpin_for_run(&copy_a.copy_id);
    prompt.session_id = Some(AcpSessionId("unproven-session".into()));
    assert!(matches!(
        manager.prepare_prompt_run(registry.workspace_mut(&a.scope).unwrap(), &prompt),
        Err(WorkspaceError::WrongOwner)
    ));
    prompt.session_id = None;
    let copy_b = manager
        .create_copy(
            registry.workspace_mut(&b.scope).unwrap(),
            &[context(&right)],
        )
        .unwrap();
    prompt.contexts = vec![context(&right)];
    prompt.staging.copy_id = copy_b.copy_id;
    assert!(matches!(
        manager.prepare_prompt_run(registry.workspace_mut(&b.scope).unwrap(), &prompt),
        Err(WorkspaceError::WrongOwner)
    ));
    registry
        .workspace_mut(&a.scope)
        .unwrap()
        .rename(request(&left), "renamed.md")
        .unwrap();
    assert!(matches!(
        manager.diff(registry.workspace_mut(&a.scope).unwrap(), &copy_a.copy_id),
        Err(WorkspaceError::StaleLocation)
    ));
}

#[test]
/// Leave dirty roots without overwriting disk and restore their working copies under a fresh incarnation.
fn folder_switch_checkpoints_unsaved_working_copies() {
    let (first, second, recovery, mut registry, a, _) = roots();
    let original = document(&mut registry, &a);
    let dirty = edit(&mut registry, &original, "unsaved 日本😀");
    registry
        .replace(marxen_lib::open_workspace(second.path(), recovery.path()).unwrap())
        .unwrap();
    assert_eq!(
        fs::read_to_string(first.path().join("same.md")).unwrap(),
        "first"
    );
    let mut reopened = marxen_lib::open_workspace(first.path(), recovery.path()).unwrap();
    let saved = reopened.recovery_entries().unwrap();
    assert_eq!(saved.len(), 1);
    let restored = reopened.restore(&saved[0].document_id.0).unwrap();
    assert_eq!(restored.snapshot.text, dirty.text);
    assert_eq!(restored.snapshot.revision, dirty.revision);
    assert!(restored.snapshot.dirty);
    assert_ne!(
        restored.snapshot.location.unwrap().scope.generation,
        a.scope.generation
    );
}
