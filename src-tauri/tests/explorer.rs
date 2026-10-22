use marxen_lib::application::{document::DocumentActor, workspace::Workspace};
use marxen_lib::contracts::*;
use std::{fs, path::Path};
use tempfile::TempDir;

const PNG: &[u8] = include_bytes!("../../tests/fixtures/pixel.png");
/// Create independent temporary workspace and recovery roots and open the workspace fixture.
fn setup() -> (TempDir, TempDir, Workspace) {
    let root = tempfile::tempdir().unwrap();
    let recovery = tempfile::tempdir().unwrap();
    let workspace = marxen_lib::open_workspace(root.path(), recovery.path()).unwrap();
    (root, recovery, workspace)
}
/// Construct a half-open range whose endpoints are global UTF-16 code-unit offsets.
fn range(start: u32, end: u32) -> Utf16Range {
    Utf16Range {
        start: Utf16Offset(start),
        end: Utf16Offset(end),
    }
}
/// Capture the document identifier and exact revision for a guarded workspace operation.
fn request(s: &DocumentSnapshot) -> SaveRequest {
    SaveRequest {
        location: None,
        document_id: s.document_id.clone(),
        base_revision: s.revision,
    }
}
/// Apply one GUI range edit against the supplied snapshot and return the authoritative result.
fn edit(a: &DocumentActor, s: &DocumentSnapshot, r: Utf16Range, text: &str) -> DocumentSnapshot {
    a.apply_edits(EditRequest {
        document_id: s.document_id.clone(),
        base_revision: s.revision,
        source: EditSource::Gui,
        edits: vec![TextEdit {
            range: r,
            text: text.into(),
        }],
    })
    .unwrap()
}

#[test]
/// Exercise text-file editing, delegated Vim save, native Undo and recovery through a real buffer.
fn utf8_text_edits_vim_write_undo_and_recovery_use_real_neovim() {
    let (root, recovery, mut w) = setup();
    fs::write(root.path().join("notes.txt"), "# literal 😀\r\n日本").unwrap();
    let opened = w.open_text_file("notes.txt").unwrap();
    assert!(w.open_markdown("notes.txt").is_err());
    let a = w.actor(&opened.snapshot.document_id.0).unwrap();
    let changed = edit(a, &opened.snapshot, range(14, 16), "変更");
    a.nvim_command("write").unwrap();
    assert!(w
        .poll()
        .iter()
        .any(|e| matches!(e, WorkspaceEvent::Saved(_))));
    assert_eq!(
        fs::read_to_string(root.path().join("notes.txt")).unwrap(),
        "# literal 😀\r\n変更"
    );
    let a = w.actor(&opened.snapshot.document_id.0).unwrap();
    let undone = a.undo().unwrap();
    assert_eq!(undone.text, opened.snapshot.text);
    assert!(undone.dirty);
    assert_eq!(w.recovery_entries().unwrap().len(), 1);
    drop(w);
    let mut restored = marxen_lib::open_workspace(root.path(), recovery.path()).unwrap();
    let record = restored.recovery_entries().unwrap().remove(0);
    let doc = restored.restore(&record.document_id.0).unwrap();
    // Issue #110: the restored record stays as a live checkpoint but is no longer offered.
    assert_eq!(restored.recovery_entries().unwrap().len(), 1);
    assert!(restored.pending_recovery_entries().unwrap().is_empty());
    assert_eq!(doc.snapshot.text, opened.snapshot.text);
    assert!(doc.snapshot.dirty);
    restored
        .actor(&doc.snapshot.document_id.0)
        .unwrap()
        .save(request(&doc.snapshot))
        .unwrap();
    assert_eq!(
        fs::read_to_string(root.path().join("notes.txt")).unwrap(),
        opened.snapshot.text
    );
    assert!(changed.dirty);
    assert_eq!(restored.search("日本").unwrap()[0].path, "notes.txt");
}

#[test]
/// Keep navigable folders and supported files while hiding unsupported extensions and binary masquerades.
fn listing_hides_unsupported_and_disguised_binaries_but_keeps_folders() {
    let (root, _recovery, w) = setup();
    fs::create_dir(root.path().join("empty")).unwrap();
    for name in ["a.md", "a.txt", "a.json", "init.lua", "Dockerfile"] {
        fs::write(root.path().join(name), "日本😀").unwrap();
    }
    fs::write(root.path().join("a.png"), PNG).unwrap();
    fs::write(root.path().join("fake.png"), "text").unwrap();
    fs::write(root.path().join("nul.txt"), b"hello\0binary").unwrap();
    fs::write(root.path().join("bad.md"), [255]).unwrap();
    fs::write(root.path().join("app.exe"), "UTF-8 but unsupported").unwrap();
    let entries = w.list("").unwrap();
    let names: Vec<_> = entries.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(
        names,
        [
            "empty",
            "Dockerfile",
            "a.json",
            "a.md",
            "a.png",
            "a.txt",
            "init.lua"
        ]
    );
    assert_eq!(
        entries.iter().find(|e| e.name == "a.png").unwrap().kind,
        Some(WorkspaceFileKind::Image)
    );
    assert_eq!(
        entries.iter().find(|e| e.name == "a.txt").unwrap().kind,
        Some(WorkspaceFileKind::Text)
    );
}

#[test]
/// Create navigable Unicode folders under existing parents without allocating document buffers.
fn creates_contained_folders_without_opening_documents() {
    let (root, _recovery, w) = setup();
    let folder = w.create_folder("メモ").unwrap();
    assert_eq!(folder.path, "メモ");
    assert_eq!(folder.name, "メモ");
    assert!(folder.directory);
    assert!(!folder.markdown);
    assert_eq!(folder.kind, None);
    assert_eq!(w.list("").unwrap(), vec![folder]);
    let nested = w.create_folder("メモ/今日").unwrap();
    assert_eq!(nested.path, "メモ/今日");
    assert_eq!(w.list("メモ").unwrap(), vec![nested]);
    assert!(root.path().join("メモ/今日").is_dir());
    assert!(w.documents().unwrap().is_empty());
    assert!(w.recovery_entries().unwrap().is_empty());
}

#[test]
/// Reject both existing folders and files while preserving their contents.
fn folder_creation_never_overwrites_existing_entries() {
    let (root, _recovery, w) = setup();
    w.create_folder("existing").unwrap();
    fs::write(root.path().join("existing/keep.txt"), "keep").unwrap();
    fs::write(root.path().join("existing.md"), "document").unwrap();
    for path in ["existing", "existing.md"] {
        assert!(matches!(
            w.create_folder(path),
            Err(WorkspaceError::AlreadyExists)
        ));
    }
    assert_eq!(
        fs::read_to_string(root.path().join("existing/keep.txt")).unwrap(),
        "keep"
    );
    assert_eq!(
        fs::read_to_string(root.path().join("existing.md")).unwrap(),
        "document"
    );
    assert!(w.documents().unwrap().is_empty());
}

#[test]
/// Refuse traversal, device names, empty roots and implicit parent hierarchy creation.
fn folder_creation_rejects_unsafe_paths_and_missing_parents() {
    let (root, _recovery, w) = setup();
    for path in [
        "",
        "..",
        "../outside",
        "/outside",
        "CON",
        "note:stream",
        "bad\\folder",
        "trailing.",
    ] {
        assert!(
            w.create_folder(path).is_err(),
            "accepted unsafe path: {path}"
        );
    }
    assert!(w.create_folder("missing/child").is_err());
    assert!(!root.path().join("missing").exists());
    assert!(w.list("").unwrap().is_empty());
}

#[test]
/// Insert an encoded relative image link only at a valid UTF-16 range and current revision.
fn workspace_drag_inserts_relative_encoded_reference_and_checks_utf16_revision() {
    let (root, _recovery, mut w) = setup();
    fs::create_dir(root.path().join("notes")).unwrap();
    fs::create_dir(root.path().join("assets")).unwrap();
    fs::write(root.path().join("assets/日本 #.png"), PNG).unwrap();
    let doc = w.create("notes/a.md", "😀選択").unwrap();
    assert!(w
        .insert_workspace_image(request(&doc.snapshot), "assets/日本 #.png", range(1, 1))
        .is_err());
    assert_eq!(
        w.actor(&doc.snapshot.document_id.0).unwrap().snapshot(),
        doc.snapshot
    );
    let inserted = w
        .insert_workspace_image(request(&doc.snapshot), "assets/日本 #.png", range(2, 4))
        .unwrap();
    assert_eq!(
        inserted.text,
        "😀![](../assets/%E6%97%A5%E6%9C%AC%20%23.png)"
    );
    assert_eq!(
        w.load_image(
            &doc.snapshot.document_id.0,
            "../assets/%E6%97%A5%E6%9C%AC%20%23.png"
        )
        .unwrap()
        .bytes,
        PNG
    );
    assert!(w
        .insert_workspace_image(request(&doc.snapshot), "assets/日本 #.png", range(2, 2))
        .is_err());
    assert!(w
        .insert_workspace_image(request(&inserted), "../outside.png", range(2, 2))
        .is_err());
    assert!(w.load_workspace_image("../outside.png").is_err());
    assert_eq!(
        fs::read(root.path().join("assets/日本 #.png")).unwrap(),
        PNG
    );
    assert_eq!(
        w.actor(&doc.snapshot.document_id.0)
            .unwrap()
            .undo()
            .unwrap()
            .text,
        "😀選択"
    );
}

#[test]
/// Bound imported image data, contain its destination and reject stale requests before creating files.
fn external_import_is_bounded_contained_and_rejects_stale_before_writes() {
    let (root, _recovery, mut w) = setup();
    let outside = tempfile::tempdir().unwrap();
    let source = outside.path().join("drop.png");
    fs::write(&source, PNG).unwrap();
    let doc = w.create("a.md", "😀").unwrap();
    let changed = edit(
        w.actor(&doc.snapshot.document_id.0).unwrap(),
        &doc.snapshot,
        range(2, 2),
        "x",
    );
    assert!(w
        .import_external_image(request(&doc.snapshot), &source, range(2, 2))
        .is_err());
    assert!(!root.path().join("images").exists());
    let imported = w
        .import_external_image(request(&changed), &source, range(2, 3))
        .unwrap();
    assert_eq!(imported.path, "images/drop.png");
    assert_eq!(imported.snapshot.text, "😀![](images/drop.png)");
    assert_eq!(fs::read(root.path().join(&imported.path)).unwrap(), PNG);
    assert_eq!(fs::read(&source).unwrap(), PNG);
    assert!(w
        .import_external_image(request(&imported.snapshot), &source, range(2, 2))
        .is_err());
    assert!(w
        .import_external_image(
            request(&imported.snapshot),
            Path::new("relative.png"),
            range(2, 2)
        )
        .is_err());
    let large = outside.path().join("large.png");
    fs::File::create(&large)
        .unwrap()
        .set_len(marxen_lib::domain::storage::MAX_IMAGE_BYTES as u64 + 1)
        .unwrap();
    assert!(w
        .import_external_image(request(&imported.snapshot), &large, range(2, 2))
        .is_err());
    assert!(!root.path().join("images/large.png").exists());
    fs::write(root.path().join("plain.txt"), "text").unwrap();
    let text = w.open_text_file("plain.txt").unwrap();
    assert!(w
        .import_external_image(request(&text.snapshot), &source, range(0, 0))
        .is_err());
}

#[test]
/// Refuse an image destination redirected outside the workspace by a Windows junction.
fn image_directory_junction_cannot_import_outside_workspace() {
    let (root, _recovery, mut w) = setup();
    let outside = tempfile::tempdir().unwrap();
    let link = root.path().join("images");
    #[cfg(unix)]
    std::os::unix::fs::symlink(outside.path(), &link).unwrap();
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let status = std::process::Command::new("powershell.exe")
            .creation_flags(0x08000000)
            .args(["-NoProfile", "-NonInteractive", "-Command"])
            .arg(format!(
                "New-Item -ItemType Junction -Path '{}' -Target '{}' -ErrorAction Stop | Out-Null",
                link.display(),
                outside.path().display()
            ))
            .status()
            .unwrap();
        assert!(status.success());
    }
    let doc = w.create("a.md", "").unwrap();
    assert!(w
        .paste_image(request(&doc.snapshot), "escape.png", PNG, range(0, 0))
        .is_err());
    assert!(!outside.path().join("escape.png").exists());
    assert!(w.load_workspace_image("images/escape.png").is_err());
}
