use marxen_lib::application::root_registry::RootRegistry;
use marxen_lib::contracts::*;
use std::fs;
use tempfile::TempDir;

/// Open two independent roots through the additive registry path.
fn two_roots() -> (
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
    let pixel = include_bytes!("../../tests/fixtures/pixel.png");
    fs::write(first.path().join("same.png"), pixel).unwrap();
    fs::write(
        second.path().join("same.png"),
        [pixel.as_slice(), b"second-root"].concat(),
    )
    .unwrap();
    let mut registry = RootRegistry::default();
    let a = registry
        .add(marxen_lib::open_workspace(first.path(), recovery.path()).unwrap())
        .unwrap();
    let b = registry
        .add(marxen_lib::open_workspace(second.path(), recovery.path()).unwrap())
        .unwrap();
    (first, second, recovery, registry, a, b)
}

#[test]
/// Keep additive roots independent for same-name text, images, search, and events.
fn additive_roots_keep_same_name_owners_save_search_images_and_events() {
    let (first, second, _recovery, mut registry, a, b) = two_roots();
    assert_eq!(registry.list().len(), 2);
    let left = registry
        .workspace_mut(&a.scope)
        .unwrap()
        .open_markdown("same.md")
        .unwrap()
        .snapshot;
    let right = registry
        .workspace_mut(&b.scope)
        .unwrap()
        .open_markdown("same.md")
        .unwrap()
        .snapshot;
    assert_ne!(left.document_id, right.document_id);
    let changed = registry
        .document_mut(&left.document_id.0, left.location.as_ref().unwrap())
        .unwrap()
        .actor(&left.document_id.0)
        .unwrap()
        .apply_edits(EditRequest {
            document_id: left.document_id.clone(),
            base_revision: left.revision,
            source: EditSource::Gui,
            edits: vec![TextEdit {
                range: Utf16Range {
                    start: Utf16Offset(0),
                    end: Utf16Offset(left.text.encode_utf16().count() as u32),
                },
                text: "changed".into(),
            }],
        })
        .unwrap();
    registry
        .document_mut(&left.document_id.0, left.location.as_ref().unwrap())
        .unwrap()
        .actor(&left.document_id.0)
        .unwrap()
        .save(SaveRequest {
            location: left.location.clone(),
            document_id: left.document_id.clone(),
            base_revision: changed.revision,
        })
        .unwrap();
    assert_eq!(
        fs::read_to_string(first.path().join("same.md")).unwrap(),
        "changed"
    );
    assert_eq!(
        fs::read_to_string(second.path().join("same.md")).unwrap(),
        "second"
    );
    let hits = registry
        .workspace_mut(&a.scope)
        .unwrap()
        .search("changed")
        .unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].scope.as_ref(), Some(&a.scope));
    assert!(registry
        .workspace_mut(&b.scope)
        .unwrap()
        .search("changed")
        .unwrap()
        .is_empty());
    let left_image = registry
        .workspace_mut(&a.scope)
        .unwrap()
        .load_workspace_image("same.png")
        .unwrap();
    let right_image = registry
        .workspace_mut(&b.scope)
        .unwrap()
        .load_workspace_image("same.png")
        .unwrap();
    assert_eq!(left_image.mime, "image/png");
    assert_eq!(right_image.mime, "image/png");
    assert_ne!(left_image.bytes, right_image.bytes);
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
/// Reject duplicate and parent-child roots through native canonical paths.
fn duplicate_and_nested_roots_are_rejected() {
    let first = tempfile::tempdir().unwrap();
    let recovery = tempfile::tempdir().unwrap();
    let mut registry = RootRegistry::default();
    let info = registry
        .add(marxen_lib::open_workspace(first.path(), recovery.path()).unwrap())
        .unwrap();
    assert_eq!(registry.list(), vec![info.clone()]);
    let same = marxen_lib::open_workspace(first.path(), recovery.path()).unwrap();
    assert!(matches!(
        registry.add(same),
        Err(WorkspaceError::AlreadyExists)
    ));
    let child_dir = first.path().join("child");
    fs::create_dir(&child_dir).unwrap();
    let child = marxen_lib::open_workspace(&child_dir, recovery.path()).unwrap();
    assert!(matches!(
        registry.add(child),
        Err(WorkspaceError::OutsideWorkspace)
    ));
    let parent = tempfile::tempdir().unwrap();
    let nested = parent.path().join("nested");
    fs::create_dir(&nested).unwrap();
    fs::write(nested.join("x.md"), "x").unwrap();
    let mut registry2 = RootRegistry::default();
    let child_info = registry2
        .add(marxen_lib::open_workspace(&nested, recovery.path()).unwrap())
        .unwrap();
    let parent_ws = marxen_lib::open_workspace(parent.path(), recovery.path()).unwrap();
    assert!(matches!(
        registry2.add(parent_ws),
        Err(WorkspaceError::OutsideWorkspace)
    ));
    assert_eq!(registry2.list(), vec![child_info]);
}

#[test]
/// Refuse removal of a dirty root and keep its tabs; clean removal keeps the other root.
fn remove_refuses_dirty_root_and_keeps_other_root() {
    let (first, second, _recovery, mut registry, a, b) = two_roots();
    let left = registry
        .workspace_mut(&a.scope)
        .unwrap()
        .open_markdown("same.md")
        .unwrap()
        .snapshot;
    let changed = registry
        .document_mut(&left.document_id.0, left.location.as_ref().unwrap())
        .unwrap()
        .actor(&left.document_id.0)
        .unwrap()
        .apply_edits(EditRequest {
            document_id: left.document_id.clone(),
            base_revision: left.revision,
            source: EditSource::Gui,
            edits: vec![TextEdit {
                range: Utf16Range {
                    start: Utf16Offset(0),
                    end: Utf16Offset(left.text.encode_utf16().count() as u32),
                },
                text: "dirty".into(),
            }],
        })
        .unwrap();
    assert!(matches!(
        registry.remove(&a.scope),
        Err(WorkspaceError::UnsavedChanges { .. })
    ));
    assert_eq!(registry.list().len(), 2);
    registry
        .document_mut(&left.document_id.0, left.location.as_ref().unwrap())
        .unwrap()
        .actor(&left.document_id.0)
        .unwrap()
        .save(SaveRequest {
            location: left.location.clone(),
            document_id: left.document_id.clone(),
            base_revision: changed.revision,
        })
        .unwrap();
    let removed = registry.remove(&a.scope).unwrap();
    assert_eq!(removed.scope, a.scope);
    assert_eq!(registry.list().len(), 1);
    assert_eq!(registry.list()[0].scope, b.scope);
    assert_eq!(
        fs::read_to_string(first.path().join("same.md")).unwrap(),
        "dirty"
    );
    assert_eq!(
        fs::read_to_string(second.path().join("same.md")).unwrap(),
        "second"
    );
}

/// Edit one authoritative buffer without saving its containing file.
fn edit(registry: &mut RootRegistry, open: &DocumentSnapshot, text: &str) -> DocumentSnapshot {
    registry
        .document_mut(&open.document_id.0, open.location.as_ref().unwrap())
        .unwrap()
        .actor(&open.document_id.0)
        .unwrap()
        .apply_edits(EditRequest {
            document_id: open.document_id.clone(),
            base_revision: open.revision,
            source: EditSource::Gui,
            edits: vec![TextEdit {
                range: Utf16Range {
                    start: Utf16Offset(0),
                    end: Utf16Offset(open.text.encode_utf16().count() as u32),
                },
                text: text.into(),
            }],
        })
        .unwrap()
}

#[test]
/// Cancel and failed multi-file saves keep every actor; discard only removes the chosen root.
fn removal_cancel_and_save_failure_retain_all_buffers_and_other_root() {
    let (first, second, _recovery, mut registry, a, b) = two_roots();
    fs::write(first.path().join("extra.md"), "extra").unwrap();
    let left = registry
        .workspace_mut(&a.scope)
        .unwrap()
        .open_markdown("same.md")
        .unwrap()
        .snapshot;
    let extra = registry
        .workspace_mut(&a.scope)
        .unwrap()
        .open_markdown("extra.md")
        .unwrap()
        .snapshot;
    let right = registry
        .workspace_mut(&b.scope)
        .unwrap()
        .open_markdown("same.md")
        .unwrap()
        .snapshot;
    edit(&mut registry, &left, "unsaved first");
    edit(&mut registry, &extra, "unsaved extra");
    assert!(registry
        .remove_with_decision(&a.scope, CloseAction::Cancel)
        .unwrap()
        .is_none());
    assert_eq!(
        registry
            .workspace_mut(&a.scope)
            .unwrap()
            .documents()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        fs::read_to_string(first.path().join("same.md")).unwrap(),
        "first"
    );
    fs::write(first.path().join("extra.md"), "external conflict").unwrap();
    assert!(matches!(
        registry.remove_with_decision(&a.scope, CloseAction::Save),
        Err(WorkspaceError::Conflict { .. })
    ));
    assert_eq!(registry.list().len(), 2);
    let documents = registry
        .workspace_mut(&a.scope)
        .unwrap()
        .documents()
        .unwrap();
    assert_eq!(documents.len(), 2);
    assert!(documents
        .iter()
        .any(|doc| doc.snapshot.text == "unsaved extra" && doc.snapshot.dirty));
    assert!(documents
        .iter()
        .any(|doc| doc.snapshot.text == "unsaved first"));
    assert_eq!(
        registry
            .document_mut(&right.document_id.0, right.location.as_ref().unwrap())
            .unwrap()
            .actor(&right.document_id.0)
            .unwrap()
            .snapshot()
            .text,
        "second"
    );
    assert!(registry
        .remove_with_decision(&a.scope, CloseAction::Discard)
        .unwrap()
        .is_some());
    assert_eq!(registry.list(), vec![b]);
    assert_eq!(
        fs::read_to_string(second.path().join("same.md")).unwrap(),
        "second"
    );
}

#[test]
/// Save the chosen root before removal and never save or close its same-name neighbour.
fn removal_save_commits_only_the_selected_root() {
    let (first, second, _recovery, mut registry, a, b) = two_roots();
    let left = registry
        .workspace_mut(&a.scope)
        .unwrap()
        .open_markdown("same.md")
        .unwrap()
        .snapshot;
    let right = registry
        .workspace_mut(&b.scope)
        .unwrap()
        .open_markdown("same.md")
        .unwrap()
        .snapshot;
    edit(&mut registry, &left, "saved alpha");
    edit(&mut registry, &right, "unsaved beta");
    registry
        .remove_with_decision(&a.scope, CloseAction::Save)
        .unwrap()
        .unwrap();
    assert_eq!(
        fs::read_to_string(first.path().join("same.md")).unwrap(),
        "saved alpha"
    );
    assert_eq!(
        fs::read_to_string(second.path().join("same.md")).unwrap(),
        "second"
    );
    assert!(
        registry
            .document_mut(&right.document_id.0, right.location.as_ref().unwrap())
            .unwrap()
            .actor(&right.document_id.0)
            .unwrap()
            .snapshot()
            .dirty
    );
    assert_eq!(registry.list(), vec![b]);
}

#[cfg(unix)]
#[test]
/// Canonicalization rejects a symbolic-link alias of an existing root.
fn symbolic_link_root_alias_is_rejected() {
    let first = tempfile::tempdir().unwrap();
    let aliases = tempfile::tempdir().unwrap();
    let recovery = tempfile::tempdir().unwrap();
    let alias = aliases.path().join("alias");
    std::os::unix::fs::symlink(first.path(), &alias).unwrap();
    let mut registry = RootRegistry::default();
    registry
        .add(marxen_lib::open_workspace(first.path(), recovery.path()).unwrap())
        .unwrap();
    assert!(matches!(
        registry.add(marxen_lib::open_workspace(&alias, recovery.path()).unwrap()),
        Err(WorkspaceError::AlreadyExists)
    ));
}

#[cfg(windows)]
#[test]
/// Resolve a Windows junction natively before duplicate-root validation.
fn junction_root_alias_is_rejected() {
    let first = tempfile::tempdir().unwrap();
    let aliases = tempfile::tempdir().unwrap();
    let recovery = tempfile::tempdir().unwrap();
    let alias = aliases.path().join("alias");
    let status = std::process::Command::new("cmd")
        .args(["/c", "mklink", "/J"])
        .arg(&alias)
        .arg(first.path())
        .output()
        .unwrap();
    assert!(
        status.status.success(),
        "{}",
        String::from_utf8_lossy(&status.stderr)
    );
    let mut registry = RootRegistry::default();
    registry
        .add(marxen_lib::open_workspace(first.path(), recovery.path()).unwrap())
        .unwrap();
    assert!(matches!(
        registry.add(marxen_lib::open_workspace(&alias, recovery.path()).unwrap()),
        Err(WorkspaceError::AlreadyExists)
    ));
}
