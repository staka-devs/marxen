use marxen_lib::contracts::*;
use marxen_lib::document::DocumentActor;
use marxen_lib::{storage, workspace::Workspace};
use std::fs;
use std::path::Path;
use tempfile::TempDir;

fn setup() -> (TempDir, TempDir, Workspace) {
    let root = tempfile::tempdir().unwrap();
    let recovery = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(root.path(), recovery.path()).unwrap();
    (root, recovery, workspace)
}
fn request(snapshot: &DocumentSnapshot) -> SaveRequest {
    SaveRequest {
        document_id: snapshot.document_id.clone(),
        base_revision: snapshot.revision,
    }
}
fn edit(actor: &DocumentActor, start: u32, end: u32, text: &str) -> DocumentSnapshot {
    let s = actor.snapshot();
    actor
        .apply_edits(EditRequest {
            document_id: s.document_id,
            base_revision: s.revision,
            source: EditSource::Gui,
            edits: vec![TextEdit {
                range: Utf16Range {
                    start: Utf16Offset(start),
                    end: Utf16Offset(end),
                },
                text: text.into(),
            }],
        })
        .unwrap()
}
fn range(start: u32, end: u32) -> Utf16Range {
    Utf16Range {
        start: Utf16Offset(start),
        end: Utf16Offset(end),
    }
}

#[test]
fn exact_bytes_bom_mixed_newlines_and_final_newline_survive_save() {
    for bytes in [
        b"\xef\xbb\xbf# title\r\ntext\nend".as_slice(),
        b"a\r\n".as_slice(),
        b"a\n\n".as_slice(),
        b"".as_slice(),
    ] {
        let (root, _recovery, mut w) = setup();
        fs::write(root.path().join("a.md"), bytes).unwrap();
        let opened = w.open_markdown("a.md").unwrap();
        assert_eq!(opened.snapshot.text.as_bytes(), bytes);
        w.actor(&opened.snapshot.document_id.0)
            .unwrap()
            .save(request(&opened.snapshot))
            .unwrap();
        assert_eq!(fs::read(root.path().join("a.md")).unwrap(), bytes);
    }
}
#[test]
fn range_edit_changes_only_requested_bytes() {
    let (root, _recovery, mut w) = setup();
    let bytes = "\u{feff}日本\r\nabc\r\nlast";
    fs::write(root.path().join("a.md"), bytes).unwrap();
    let doc = w.open_markdown("a.md").unwrap();
    let actor = w.actor(&doc.snapshot.document_id.0).unwrap();
    let changed = edit(actor, 5, 8, "😀");
    actor.save(request(&changed)).unwrap();
    assert_eq!(
        fs::read(root.path().join("a.md")).unwrap(),
        "\u{feff}日本\r\n😀\r\nlast".as_bytes()
    );
}
#[test]
fn fingerprint_conflict_and_deletion_never_overwrite_disk() {
    let (root, _recovery, mut w) = setup();
    let doc = w.create("a.md", "abc").unwrap();
    let actor = w.actor(&doc.snapshot.document_id.0).unwrap();
    let changed = edit(actor, 0, 3, "xyz");
    fs::write(root.path().join("a.md"), b"def").unwrap();
    assert!(matches!(
        actor.save(request(&changed)),
        Err(marxen_lib::document::ActorError::Workspace(
            WorkspaceError::Conflict { .. }
        ))
    ));
    assert_eq!(fs::read(root.path().join("a.md")).unwrap(), b"def");
    assert!(actor.snapshot().dirty);
    fs::remove_file(root.path().join("a.md")).unwrap();
    assert!(actor.save(request(&changed)).is_err());
    assert!(!root.path().join("a.md").exists());
}
#[test]
fn external_events_are_deduplicated_and_reload_is_explicit() {
    let (root, _recovery, mut w) = setup();
    let doc = w.create("a.md", "one").unwrap();
    fs::write(root.path().join("a.md"), "two").unwrap();
    assert!(matches!(
        w.poll().as_slice(),
        [WorkspaceEvent::ExternalChange {
            dirty: false,
            deleted: false,
            ..
        }]
    ));
    assert!(w.poll().is_empty());
    let actor = w.actor(&doc.snapshot.document_id.0).unwrap();
    assert_eq!(actor.snapshot().text, "one");
    let reloaded = actor.reload(request(&doc.snapshot)).unwrap();
    assert_eq!(reloaded.text, "two");
    assert_eq!(reloaded.revision, Revision(1));
    let changed = edit(actor, 0, 3, "gui");
    assert!(actor.reload(request(&changed)).is_err());
    fs::remove_file(root.path().join("a.md")).unwrap();
    assert!(matches!(
        w.poll().as_slice(),
        [WorkspaceEvent::ExternalChange {
            dirty: true,
            deleted: true,
            ..
        }]
    ));
}
#[test]
fn save_failure_keeps_original_dirty_text_and_recovery() {
    let (root, _recovery, mut w) = setup();
    let doc = w.create("a.md", "original").unwrap();
    let actor = w.actor(&doc.snapshot.document_id.0).unwrap();
    let changed = edit(actor, 0, 8, "pending");
    let path = root.path().join("a.md");
    let original_permissions = fs::metadata(&path).unwrap().permissions();
    let mut readonly = original_permissions.clone();
    readonly.set_readonly(true);
    fs::set_permissions(&path, readonly).unwrap();
    assert!(actor.save(request(&changed)).is_err());
    assert!(actor.snapshot().dirty);
    assert_eq!(fs::read(&path).unwrap(), b"original");
    assert_eq!(w.recovery_entries().unwrap().len(), 1);
    fs::set_permissions(&path, original_permissions).unwrap();
    actor.save(request(&changed)).unwrap();
    assert!(!actor.snapshot().dirty);
    assert!(w.recovery_entries().unwrap().is_empty());
}
#[test]
fn close_cancel_retains_buffer_and_save_failure_prevents_close() {
    let (root, _recovery, mut w) = setup();
    let doc = w.create("a.md", "one").unwrap();
    let s = edit(w.actor(&doc.snapshot.document_id.0).unwrap(), 0, 3, "two");
    assert!(!w.close(request(&s), CloseAction::Cancel).unwrap());
    assert_eq!(w.actor(&s.document_id.0).unwrap().snapshot(), s);
    assert!(matches!(
        w.ensure_clean(),
        Err(WorkspaceError::UnsavedChanges { .. })
    ));
    fs::write(root.path().join("a.md"), "ext").unwrap();
    assert!(w.close(request(&s), CloseAction::Save).is_err());
    assert!(w.actor(&s.document_id.0).is_ok());
    assert!(w.close(request(&s), CloseAction::Discard).unwrap());
    assert!(w.actor(&s.document_id.0).is_err());
    assert!(w.recovery_entries().unwrap().is_empty());
}
#[test]
fn listing_open_create_rename_and_tabs_are_safe() {
    let (root, _recovery, mut w) = setup();
    fs::create_dir(root.path().join("notes")).unwrap();
    fs::write(root.path().join("other.txt"), "text").unwrap();
    let a = w.create("notes/a.md", "abc").unwrap();
    let b = w.create("b.markdown", "def").unwrap();
    assert_ne!(a.snapshot.document_id, b.snapshot.document_id);
    assert_eq!(w.open_markdown("notes/a.md").unwrap(), a);
    assert!(w.create("b.markdown", "overwrite").is_err());
    assert!(w.open_markdown("other.txt").is_err());
    let s = edit(w.actor(&a.snapshot.document_id.0).unwrap(), 0, 1, "X");
    let renamed = w.rename(request(&s), "notes/renamed.md").unwrap();
    assert_eq!(renamed.snapshot, s);
    assert!(!root.path().join("notes/a.md").exists());
    assert_eq!(
        fs::read(root.path().join("notes/renamed.md")).unwrap(),
        b"abc"
    );
    assert!(w.rename(request(&s), "b.markdown").is_err());
    assert_eq!(
        w.actor(&s.document_id.0).unwrap().undo().unwrap().text,
        "abc"
    );
    assert_eq!(
        w.actor(&b.snapshot.document_id.0).unwrap().snapshot().text,
        "def"
    );
    assert_eq!(w.list("").unwrap()[0].name, "notes");
}
#[test]
fn traversal_absolute_ads_and_reserved_names_are_rejected() {
    let (root, _recovery, mut w) = setup();
    for path in [
        "../outside.md",
        "/abs.md",
        "C:/a.md",
        "a.md:stream",
        "a\\b.md",
        "CON.md",
        ".marxen-save-x.md",
        "a?.md",
        "x./a.md",
    ] {
        assert!(w.create(path, "unsafe").is_err(), "{path}");
    }
    fs::write(root.path().join("invalid.md"), [0xff]).unwrap();
    assert!(matches!(
        w.open_markdown("invalid.md"),
        Err(WorkspaceError::InvalidUtf8)
    ));
}
fn make_link(target: &Path, link: &Path) {
    #[cfg(unix)]
    std::os::unix::fs::symlink(target, link).unwrap();
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let status = std::process::Command::new("powershell.exe")
            .creation_flags(0x08000000)
            .args(["-NoProfile", "-NonInteractive", "-Command"])
            .arg(format!(
                "New-Item -ItemType Junction -Path '{}' -Target '{}' -ErrorAction Stop | Out-Null",
                link.display(),
                target.display()
            ))
            .status()
            .unwrap();
        assert!(status.success());
    }
}
#[test]
fn external_symlink_or_junction_is_rejected_for_open_and_save() {
    let (root, _recovery, mut w) = setup();
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("a.md"), "outside").unwrap();
    make_link(outside.path(), &root.path().join("link"));
    assert!(w.open_markdown("link/a.md").is_err());
    fs::create_dir(root.path().join("notes")).unwrap();
    let doc = w.create("notes/a.md", "original").unwrap();
    let actor = w.actor(&doc.snapshot.document_id.0).unwrap();
    let s = edit(actor, 0, 8, "pending");
    fs::rename(root.path().join("notes"), root.path().join("moved")).unwrap();
    make_link(outside.path(), &root.path().join("notes"));
    assert!(actor.save(request(&s)).is_err());
    assert_eq!(fs::read(outside.path().join("a.md")).unwrap(), b"outside");
}
#[test]
fn search_uses_unsaved_neovim_text_and_utf16_ranges() {
    let (_root, _recovery, mut w) = setup();
    let doc = w.create("a.md", "a😀日本\n日本").unwrap();
    let s = edit(w.actor(&doc.snapshot.document_id.0).unwrap(), 6, 8, "変更");
    let found = w.search("日本").unwrap();
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].range, range(3, 5));
    assert_eq!(found[0].revision, Some(s.revision));
    assert_eq!(found[0].line, 1);
}
#[test]
fn crash_child() {
    let Ok(root) = std::env::var("MARXEN_CRASH_ROOT") else {
        return;
    };
    let recovery = std::env::var("MARXEN_CRASH_RECOVERY").unwrap();
    let mut w = Workspace::open(Path::new(&root), Path::new(&recovery)).unwrap();
    let doc = w.open_markdown("a.md").unwrap();
    edit(
        w.actor(&doc.snapshot.document_id.0).unwrap(),
        0,
        4,
        "recovered😀",
    );
    std::process::exit(79);
}
#[test]
fn abrupt_process_exit_restores_checkpoint_and_keeps_disk_conflict() {
    let (root, recovery, w) = setup();
    drop(w);
    fs::write(root.path().join("a.md"), "base").unwrap();
    let mut command = std::process::Command::new(std::env::current_exe().unwrap());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let status = command
        .args(["--exact", "crash_child", "--nocapture"])
        .env("MARXEN_CRASH_ROOT", root.path())
        .env("MARXEN_CRASH_RECOVERY", recovery.path())
        .status()
        .unwrap();
    assert_eq!(status.code(), Some(79));
    assert_eq!(fs::read(root.path().join("a.md")).unwrap(), b"base");
    fs::write(root.path().join("a.md"), "external").unwrap();
    let mut w = Workspace::open(root.path(), recovery.path()).unwrap();
    let records = w.recovery_entries().unwrap();
    assert_eq!(records.len(), 1);
    assert!(records[0].conflict);
    let restored = w.restore(&records[0].document_id.0).unwrap();
    assert_eq!(restored.snapshot.text, "recovered😀");
    assert!(restored.snapshot.dirty);
    assert!(w
        .actor(&restored.snapshot.document_id.0)
        .unwrap()
        .save(request(&restored.snapshot))
        .is_err());
    assert_eq!(fs::read(root.path().join("a.md")).unwrap(), b"external");
}
#[test]
fn neovim_exit_preserves_recoverable_last_acknowledged_revision() {
    let (_root, _recovery, mut w) = setup();
    let doc = w.create("a.md", "base").unwrap();
    let actor = w.actor(&doc.snapshot.document_id.0).unwrap();
    let s = edit(actor, 0, 4, "pending");
    let _ = actor.nvim_command("qa!");
    assert!(actor.sync_from_nvim().is_err());
    assert_eq!(actor.snapshot(), s);
    assert_eq!(w.recovery_entries().unwrap()[0].revision, s.revision);
    assert!(w
        .poll()
        .iter()
        .any(|event| matches!(event, WorkspaceEvent::Error { .. })));
}
#[test]
fn vim_write_uses_same_conflict_aware_atomic_saver() {
    let (root, _recovery, mut w) = setup();
    let doc = w.create("a.md", "base").unwrap();
    let actor = w.actor(&doc.snapshot.document_id.0).unwrap();
    let s = edit(actor, 0, 4, "pending");
    actor.nvim_command("write").unwrap();
    let events = w.poll();
    assert!(events.iter().any(|e| matches!(e, WorkspaceEvent::Saved(_))));
    assert_eq!(fs::read(root.path().join("a.md")).unwrap(), b"pending");
    let actor = w.actor(&s.document_id.0).unwrap();
    let s = edit(actor, 0, 7, "again");
    fs::write(root.path().join("a.md"), "external").unwrap();
    actor.nvim_command("write").unwrap();
    assert!(w.poll().iter().any(|e| matches!(
        e,
        WorkspaceEvent::Error {
            error: WorkspaceError::Conflict { .. },
            ..
        }
    )));
    assert_eq!(fs::read(root.path().join("a.md")).unwrap(), b"external");
    assert!(w.actor(&s.document_id.0).unwrap().snapshot().dirty);
}
#[test]
fn gui_batch_is_one_undo_step_and_initial_text_is_undo_floor() {
    let (_root, _recovery, mut w) = setup();
    let doc = w.create("a.md", "abcdef").unwrap();
    let actor = w.actor(&doc.snapshot.document_id.0).unwrap();
    assert_eq!(actor.undo().unwrap().text, "abcdef");
    let s = actor.snapshot();
    actor
        .apply_edits(EditRequest {
            document_id: s.document_id,
            base_revision: s.revision,
            source: EditSource::Gui,
            edits: vec![
                TextEdit {
                    range: range(0, 1),
                    text: "A".into(),
                },
                TextEdit {
                    range: range(4, 6),
                    text: "EF".into(),
                },
            ],
        })
        .unwrap();
    assert_eq!(actor.snapshot().text, "AbcdEF");
    assert_eq!(actor.undo().unwrap().text, "abcdef");
    assert_eq!(actor.redo().unwrap().text, "AbcdEF");
    edit(actor, 1, 2, "B");
    assert_eq!(actor.undo().unwrap().text, "AbcdEF");
    assert_eq!(actor.undo().unwrap().text, "abcdef");
    assert_eq!(actor.undo().unwrap().text, "abcdef");
}
#[test]
fn image_paste_is_contained_revision_checked_and_loadable() {
    let (root, _recovery, mut w) = setup();
    fs::create_dir(root.path().join("notes")).unwrap();
    let doc = w.create("notes/a.md", "😀").unwrap();
    let png = b"\x89PNG\r\n\x1a\npayload";
    let pasted = w
        .paste_image(request(&doc.snapshot), "test.png", png, range(2, 2))
        .unwrap();
    assert_eq!(pasted.snapshot.text, "😀![](images/test.png)");
    assert_eq!(
        w.load_image(&doc.snapshot.document_id.0, "images/test.png")
            .unwrap()
            .bytes,
        png
    );
    assert!(w
        .paste_image(request(&doc.snapshot), "stale.png", png, range(2, 2))
        .is_err());
    assert!(!root.path().join("notes/images/stale.png").exists());
    assert!(w
        .load_image(&doc.snapshot.document_id.0, "../../outside.png")
        .is_err());
    assert!(w
        .paste_image(request(&pasted.snapshot), "../unsafe.png", png, range(2, 2))
        .is_err());
    assert!(w
        .paste_image(
            request(&pasted.snapshot),
            "unsafe.svg",
            b"<svg/>",
            range(2, 2)
        )
        .is_err());
}
#[test]
fn atomic_create_never_clobbers_and_preserves_permissions() {
    let (root, _recovery, _w) = setup();
    let path = fs::canonicalize(root.path()).unwrap().join("a.md");
    let baseline = storage::atomic_write(
        &path,
        b"first",
        None,
        Some(&fs::canonicalize(root.path()).unwrap()),
    )
    .unwrap();
    assert!(storage::atomic_write(&path, b"bad", None, None).is_err());
    let permissions = fs::metadata(&path).unwrap().permissions();
    storage::atomic_write(&path, b"second", Some(&baseline), None).unwrap();
    assert_eq!(fs::metadata(&path).unwrap().permissions(), permissions);
    assert_eq!(fs::read(&path).unwrap(), b"second");
    assert!(!fs::read_dir(root.path()).unwrap().any(|e| e
        .unwrap()
        .file_name()
        .to_string_lossy()
        .starts_with(".marxen-save-")));
}

#[test]
fn live_vim_bridge_checks_revisions_cursor_grid_and_config_restart() {
    let (root, _recovery, mut w) = setup();
    let doc = w.create("a.md", "a😀日本").unwrap();
    let actor = w.actor(&doc.snapshot.document_id.0).unwrap();
    actor
        .set_cursor(CursorUpdate {
            document_id: doc.snapshot.document_id.clone(),
            revision: Revision(0),
            anchor: Utf16Offset(3),
            head: Utf16Offset(3),
        })
        .unwrap();
    assert_eq!(actor.cursor().unwrap().head, Utf16Offset(3));
    let changed = actor
        .input_checked(request(&doc.snapshot), "iX<Esc>")
        .unwrap();
    assert_eq!(changed.text, "a😀X日本");
    assert!(actor.input_checked(request(&doc.snapshot), "x").is_err());
    assert!(!actor.grid(80, 24).unwrap().updates.is_empty());
    assert!(actor.grid(0, 24).is_err());
    let config = root.path().join("init.lua");
    fs::write(&config, "error('test configuration error')").unwrap();
    let result = actor.configure(request(&changed), Some(config)).unwrap();
    assert!(result
        .errors
        .iter()
        .any(|error| error.contains("test configuration error")));
    assert_eq!(actor.snapshot(), changed);
    assert_eq!(actor.undo().unwrap().text, changed.text);
    assert_eq!(actor.cursor().unwrap().revision, changed.revision);
}
#[test]
fn undo_to_saved_bytes_clears_recovery_and_unicode_image_links_load() {
    let (root, _recovery, mut w) = setup();
    let doc = w.create("a.md", "abc").unwrap();
    let actor = w.actor(&doc.snapshot.document_id.0).unwrap();
    edit(actor, 0, 3, "changed");
    assert_eq!(w.recovery_entries().unwrap().len(), 1);
    assert!(!actor.undo().unwrap().dirty);
    assert!(w.recovery_entries().unwrap().is_empty());
    let s = actor.snapshot();
    let png = b"\x89PNG\r\n\x1a\npayload";
    let pasted = w
        .paste_image(request(&s), "日本 #.png", png, range(3, 3))
        .unwrap();
    assert!(pasted.snapshot.text.contains("%E6%97%A5"));
    let loaded = w
        .load_image(&s.document_id.0, "images/%E6%97%A5%E6%9C%AC%20%23.png")
        .unwrap();
    assert_eq!(loaded.bytes, png);
    assert!(root.path().join("images/日本 #.png").exists());
    assert!(w
        .load_image(&s.document_id.0, "%2e%2e/outside.png")
        .is_err());
}

#[cfg(windows)]
#[test]
fn windows_save_preserves_protected_acl_and_named_stream() {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Security::{
        GetFileSecurityW, SetFileSecurityW, SetSecurityDescriptorControl,
        DACL_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION, SE_DACL_PROTECTED,
    };
    let (root, _recovery, mut w) = setup();
    let doc = w.create("a.md", "original").unwrap();
    let path = root.path().join("a.md");
    let wide = path
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let read_acl = || {
        let mut needed = 0;
        // SAFETY: valid UTF-16 path and size output; the first call only queries
        // capacity, and the second uses aligned storage of the reported size.
        unsafe {
            GetFileSecurityW(
                wide.as_ptr(),
                DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                0,
                &mut needed,
            );
        }
        assert!(needed > 0);
        let mut descriptor = vec![0u32; needed.div_ceil(4) as usize];
        let result = unsafe {
            GetFileSecurityW(
                wide.as_ptr(),
                DACL_SECURITY_INFORMATION,
                descriptor.as_mut_ptr().cast(),
                needed,
                &mut needed,
            )
        };
        assert_ne!(result, 0, "{}", std::io::Error::last_os_error());
        descriptor
    };
    let mut initial = read_acl();
    let protected = unsafe {
        SetSecurityDescriptorControl(
            initial.as_mut_ptr().cast(),
            SE_DACL_PROTECTED,
            SE_DACL_PROTECTED,
        )
    };
    assert_ne!(protected, 0, "{}", std::io::Error::last_os_error());
    // SAFETY: aligned, self-relative descriptor returned by GetFileSecurityW.
    let result = unsafe {
        SetFileSecurityW(
            wide.as_ptr(),
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            initial.as_mut_ptr().cast(),
        )
    };
    assert_ne!(result, 0, "{}", std::io::Error::last_os_error());
    let before = read_acl();
    let stream = format!("{}:test-stream", path.display());
    fs::write(&stream, b"metadata").unwrap();
    let actor = w.actor(&doc.snapshot.document_id.0).unwrap();
    let changed = edit(actor, 0, 8, "pending");
    actor.save(request(&changed)).unwrap();
    let after = read_acl();
    assert_ne!((after[0] >> 16) & u32::from(SE_DACL_PROTECTED), 0);
    let normalize = |mut descriptor: Vec<u32>| {
        // ReplaceFileW normalizes inherited ACEs to explicit ACEs when the
        // DACL is protected. Permissions, SIDs and protection must stay equal.
        descriptor[0] &= !(0x0400 << 16); // SE_DACL_AUTO_INHERITED
        let acl = descriptor[4] as usize / 4;
        let count = descriptor[acl + 1] & 0xffff;
        let mut cursor = acl + 2;
        for _ in 0..count {
            let size = (descriptor[cursor] >> 16) as usize;
            descriptor[cursor] &= !(0x10 << 8); // INHERITED_ACE
            cursor += size / 4;
        }
        descriptor
    };
    assert_eq!(normalize(before), normalize(after));
    assert_eq!(fs::read(stream).unwrap(), b"metadata");
    assert_eq!(fs::read(&path).unwrap(), b"pending");
}
#[cfg(windows)]
#[test]
fn locked_windows_replacement_preserves_original_and_recovery() {
    use std::os::windows::fs::OpenOptionsExt;
    let (root, _recovery, mut w) = setup();
    let doc = w.create("a.md", "original").unwrap();
    let path = root.path().join("a.md");
    let actor = w.actor(&doc.snapshot.document_id.0).unwrap();
    let changed = edit(actor, 0, 8, "pending");
    let locked = fs::OpenOptions::new()
        .read(true)
        .share_mode(3)
        .open(&path)
        .unwrap();
    assert!(actor.save(request(&changed)).is_err());
    assert_eq!(fs::read(&path).unwrap(), b"original");
    assert!(actor.snapshot().dirty);
    assert_eq!(w.recovery_entries().unwrap().len(), 1);
    drop(locked);
    actor.save(request(&changed)).unwrap();
    assert_eq!(fs::read(path).unwrap(), b"pending");
}
