use marxen_lib::contracts::{
    DocumentId, EditRequest, EditSource, Revision, SaveRequest, TextEdit, Utf16Offset, Utf16Range,
    VimMode,
};
use marxen_lib::document::DocumentActor;
use std::time::{Duration, Instant};

fn key(actor: &DocumentActor, key: &str) {
    let snapshot = actor.snapshot();
    let start = Instant::now();
    actor
        .input_checked(
            SaveRequest {
                document_id: snapshot.document_id,
                base_revision: snapshot.revision,
            },
            key,
        )
        .unwrap();
    assert!(
        start.elapsed() < Duration::from_secs(2),
        "key {key:?} stalled"
    );
    actor.current_mode().unwrap();
    actor.cursor().unwrap();
}

#[test]
fn separate_key_events_complete_pending_vim_commands() {
    let actor = DocumentActor::open(
        DocumentId("separate-keys".into()),
        "first\nsecond\nthird".into(),
        None,
    )
    .unwrap();
    key(&actor, "G");
    assert_eq!(actor.cursor().unwrap().head.0, 13);
    key(&actor, "g");
    assert_eq!(actor.snapshot().revision, Revision(0));
    key(&actor, "g");
    assert_eq!(actor.cursor().unwrap().head.0, 0);
    for typed in ["d", "i", "w"] {
        key(&actor, typed);
    }
    assert_eq!(actor.snapshot().text, "\nsecond\nthird");
    assert_eq!(actor.snapshot().revision, Revision(1));
    key(&actor, "u");
    assert_eq!(actor.snapshot().text, "first\nsecond\nthird");
    key(&actor, ":");
    assert_eq!(actor.current_mode().unwrap().mode, VimMode::CommandLine);
    key(&actor, "\u{1b}");
    assert_eq!(actor.current_mode().unwrap().mode, VimMode::Normal);
    key(&actor, "d");
    key(&actor, "\u{1b}");
    assert_eq!(actor.snapshot().text, "first\nsecond\nthird");
    key(&actor, "i");
    assert_eq!(actor.current_mode().unwrap().mode, VimMode::Insert);
    key(&actor, "日");
    key(&actor, "\u{1b}");
    assert_eq!(actor.snapshot().text, "日first\nsecond\nthird");
}

#[test]
fn partial_macros_mappings_and_prompts_leave_input_available() {
    let actor = DocumentActor::open(
        DocumentId("mapping-keys".into()),
        "abc\nsecond".into(),
        None,
    )
    .unwrap();
    for typed in ["q", "a", "l", "q", "@", "a"] {
        key(&actor, typed);
    }
    assert_eq!(actor.cursor().unwrap().head.0, 2);
    actor.nvim_command("nnoremap zx gg0").unwrap();
    for typed in ["z", "x"] {
        key(&actor, typed);
    }
    assert_eq!(actor.cursor().unwrap().head.0, 0);
    key(&actor, "d");
    let snapshot = actor.snapshot();
    let started = Instant::now();
    assert!(actor
        .apply_edits(EditRequest {
            document_id: snapshot.document_id.clone(),
            base_revision: snapshot.revision,
            source: EditSource::Gui,
            edits: vec![TextEdit {
                range: Utf16Range {
                    start: Utf16Offset(0),
                    end: Utf16Offset(0)
                },
                text: "wrong".into(),
            }],
        })
        .is_err());
    assert!(started.elapsed() < Duration::from_secs(2));
    assert_eq!(actor.sync_from_nvim().unwrap(), snapshot);
    key(&actor, "\u{1b}");
    actor
        .nvim_command("lua vim.keymap.set('n', '<F7>', function() vim.fn.getchar(); vim.api.nvim_buf_set_lines(0, 0, 1, false, {'done'}) end)")
        .unwrap();
    key(&actor, "<F7>");
    key(&actor, "a");
    assert_eq!(actor.snapshot().text, "done\nsecond");
    assert_eq!(actor.snapshot().revision, Revision(1));
}

#[test]
fn command_line_keys_save_through_rust() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("日本語.md");
    std::fs::write(&path, "before").unwrap();
    let actor = DocumentActor::open(
        DocumentId("save-keys".into()),
        "before".into(),
        Some(path.clone()),
    )
    .unwrap();
    for typed in ["i", "日", "\u{1b}", ":", "w", "\r"] {
        key(&actor, typed);
    }
    assert_eq!(std::fs::read_to_string(path).unwrap(), "日before");
    assert!(!actor.snapshot().dirty);
}

#[test]
fn display_key_routing_detects_global_buffer_and_pending_mappings() {
    let actor = DocumentActor::open(
        DocumentId("mapping-routing".into()),
        "abc\nsecond".into(),
        None,
    )
    .unwrap();
    assert!(!actor.has_user_mapping("n", "j").unwrap());
    actor.nvim_command("nnoremap zx gg0").unwrap();
    actor
        .nvim_command("lua vim.keymap.set('n', '<Down>', 'G', {buffer = true})")
        .unwrap();
    actor
        .nvim_command("lua vim.keymap.set('i', '<C-h>', function() end, {buffer = true})")
        .unwrap();
    assert!(actor.has_user_mapping("n", "z").unwrap());
    assert!(actor.has_user_mapping("n", "zx").unwrap());
    assert!(actor.has_user_mapping("n", "<Down>").unwrap());
    assert!(actor.has_user_mapping("i", "<C-H>").unwrap());
    assert!(!actor.has_user_mapping("n", "Z").unwrap());
    key(&actor, "g");
    assert!(actor.has_user_mapping("n", "j").unwrap());
    key(&actor, "\u{1b}");
    key(&actor, "d");
    assert!(actor.has_user_mapping("n", "j").unwrap());
    key(&actor, "\u{1b}");
    assert!(!actor.has_user_mapping("n", "j").unwrap());
    assert!(actor.has_user_mapping("invalid", "j").is_err());
}
