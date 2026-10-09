use marxen_lib::contracts::{CopyFormat, DocumentId, Revision, SaveRequest, VimInputResult};
use marxen_lib::document::DocumentActor;
use std::time::{Duration, Instant};

/// Submit native keys at the latest document revision and return the observed Vim input result.
fn key(actor: &DocumentActor, keys: &str) -> VimInputResult {
    let snapshot = actor.snapshot();
    let started = Instant::now();
    let result = actor
        .input_with_copy(
            SaveRequest {
                document_id: snapshot.document_id,
                base_revision: snapshot.revision,
            },
            keys,
        )
        .unwrap();
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "{keys:?} stalled native input"
    );
    result
}

#[test]
/// Require repeated line and named-register yanks to copy exact Unicode while preserving text and revision.
fn repeated_linewise_and_named_yanks_copy_exact_unicode_without_edits() {
    let actor = DocumentActor::open(
        DocumentId("copy-repeat".into()),
        "# 日本 😀\nsecond".into(),
        None,
    )
    .unwrap();
    for _ in 0..2 {
        assert!(!key(&actor, "y").copy_ready);
        assert!(key(&actor, "y").copy_ready);
        let result = key(&actor, "<F6>");
        let copy = result.copy.unwrap();
        assert_eq!(copy.format, CopyFormat::Markdown);
        assert_eq!(copy.text, "# 日本 😀\n");
        assert_eq!(result.snapshot.revision, Revision(0));
        assert!(!result.snapshot.dirty);
    }
    for event in ["\"", "a", "y", "w"] {
        key(&actor, event);
    }
    assert_eq!(key(&actor, "<F7>").copy.unwrap().text, "# ");
    assert_eq!(actor.buffer_text().unwrap(), "# 日本 😀\nsecond");
}

#[test]
/// Use Neovim yank events to preserve native visual and rectangular register contents.
fn visual_and_rectangular_yanks_use_native_event_contents() {
    let actor =
        DocumentActor::open(DocumentId("copy-visual".into()), "abXX\ncdYY".into(), None).unwrap();
    for event in ["v", "l", "y"] {
        key(&actor, event);
    }
    assert_eq!(key(&actor, "<F8>").copy.unwrap().text, "ab");
    for event in ["<C-v>", "l", "j", "y"] {
        key(&actor, event);
    }
    assert_eq!(key(&actor, "<F6>").copy.unwrap().text, "ab\ncd");
    assert_eq!(actor.snapshot().revision, Revision(0));
}

#[test]
/// Preserve user mapping priority, incomplete commands and the next ordinary command after a yank.
fn mappings_pending_input_and_next_normal_command_keep_their_meaning() {
    let actor = DocumentActor::open(
        DocumentId("copy-mappings".into()),
        "first\nlast".into(),
        None,
    )
    .unwrap();
    actor.nvim_command("nnoremap <F6> G").unwrap();
    for event in ["y", "y"] {
        key(&actor, event);
    }
    assert!(key(&actor, "<F6>").copy.is_none());
    assert_eq!(actor.cursor().unwrap().head.0, 6);
    actor.nvim_command("nnoremap <F7>x gg").unwrap();
    for event in ["y", "y", "<F7>"] {
        assert!(key(&actor, event).copy.is_none());
    }
    key(&actor, "x");
    assert_eq!(actor.cursor().unwrap().head.0, 0);
    for event in ["y", "y", "l"] {
        key(&actor, event);
    }
    assert!(
        key(&actor, "<F8>").copy.is_none(),
        "a motion cancels the post-yank selector"
    );
    for event in ["y", "<Esc>"] {
        key(&actor, event);
    }
    assert!(
        key(&actor, "<F9>").copy.is_none(),
        "cancelled operator never arms copy"
    );
    for event in ["d", "w"] {
        key(&actor, event);
    }
    assert!(key(&actor, "<F9>").copy.is_none(), "delete is not a yank");
}

#[test]
/// Apply configured format selectors from vimrc and respect an explicitly disabled selector.
fn vimrc_selectors_are_live_canonical_and_can_be_disabled() {
    let actor =
        DocumentActor::open(DocumentId("copy-config".into()), "word next".into(), None).unwrap();
    actor
        .nvim_command("let g:marxen_copy_markdown_key = ''")
        .unwrap();
    actor
        .nvim_command("let g:marxen_copy_text_key = '<c-f10>'")
        .unwrap();
    for event in ["y", "i", "w"] {
        key(&actor, event);
    }
    let copy = key(&actor, "<C-F10>").copy.unwrap();
    assert_eq!(copy.format, CopyFormat::Text);
    assert_eq!(copy.text, "word");
    for event in ["y", "y"] {
        key(&actor, event);
    }
    assert!(key(&actor, "<F6>").copy.is_none());
}

#[test]
/// Expose invalid, reserved and duplicate format keys without intercepting their normal Vim input.
fn invalid_reserved_and_duplicate_selectors_are_reported_and_disabled() {
    let actor =
        DocumentActor::open(DocumentId("copy-invalid".into()), "word".into(), None).unwrap();
    actor.nvim_command("let g:marxen_copy_markdown_key = '<c-p>' | let g:marxen_copy_text_key = 'zm' | let g:marxen_copy_rich_key = '<Left>'").unwrap();
    assert_eq!(actor.copy_key_errors().unwrap().len(), 3);
    assert_eq!(actor.copy_keys().unwrap().len(), 1);
    actor.nvim_command("let g:marxen_copy_markdown_key = '<F6>' | let g:marxen_copy_text_key = '<f6>' | let g:marxen_copy_rich_key = ''").unwrap();
    assert_eq!(actor.copy_key_errors().unwrap().len(), 1);
    assert_eq!(actor.copy_keys().unwrap().len(), 1);
    for event in ["y", "y"] {
        key(&actor, event);
    }
    assert!(key(&actor, "<F6>").copy.is_none());
    actor
        .nvim_command("let g:marxen_copy_markdown_key = 'm' | let g:marxen_copy_text_key = ''")
        .unwrap();
    for event in ["y", "y"] {
        key(&actor, event);
    }
    assert_eq!(key(&actor, "m").copy.unwrap().text, "word\n");
}
