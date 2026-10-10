//! Issue #3 integration: every test drives the real bundled Neovim.
//!
//! No fake Vim. Tests spawn `src-tauri/resources/neovim` via `--embed`
//! (`npm run bundle:neovim` first; CI bundles before `cargo test`) and cover
//! the acceptance surface: Japanese composition contract, emoji offsets,
//! user-mapping priority, modes, display coordinates + raw grid, native undo
//! sharing GUI range edits, `:w` delegation to Rust, config errors,
//! revision serialization, and cursor reporting.

use marxen_lib::application::document::{ActorError, DocumentActor};
use marxen_lib::contracts::{
    ContractError, CursorUpdate, DocumentId, EditRequest, EditSource, Revision, SaveRequest,
    TextEdit, Utf16Offset, Utf16Range, VimMode,
};
use marxen_lib::domain::coordinates::{display_width, global_utf16_to_line_byte};
use marxen_lib::domain::validation::{utf16_to_utf8, utf8_to_utf16};
use marxen_lib::infrastructure::neovim::config::ConfigSource;
use marxen_lib::infrastructure::neovim::grid::{
    attach, detach, grid_line_text, grid_lines_from_redraw,
};
use marxen_lib::infrastructure::neovim::mapping::{apply_user_lua, has_mapping};
use marxen_lib::infrastructure::neovim::NeovimSession;
use std::time::Duration;

/// Create a stable document identifier namespaced to the Neovim integration fixture.
fn doc_id(name: &str) -> DocumentId {
    DocumentId(format!("issue3-{name}"))
}

/// Build a replacement using global UTF-16 endpoints and the supplied literal text.
fn gui_edit(start: u32, end: u32, text: &str) -> TextEdit {
    TextEdit {
        range: Utf16Range {
            start: Utf16Offset(start),
            end: Utf16Offset(end),
        },
        text: text.into(),
    }
}

/// Count UTF-16 code units and fail if the fixture exceeds the boundary offset width.
fn utf16_len(text: &str) -> u32 {
    u32::try_from(text.encode_utf16().count()).unwrap()
}

/// Require the real bundled Neovim executable and runtime before starting an integration check.
fn require_bundle() {
    marxen_lib::infrastructure::neovim::bundle_paths().expect("run `npm run bundle:neovim` first");
}

#[test]
/// Apply Japanese composition-shaped range edits through a real buffer and check UTF-16 positions; no OS IME is driven.
fn japanese_composition_contract_keeps_offsets() {
    require_bundle();
    // IME composition: preedit inserted as one range edit, then committed by
    // replacing the same range. Neovim buffer stays truth throughout.
    let actor =
        marxen_lib::open_document(doc_id("composition"), "こんにちは".into(), None).unwrap();
    let base = actor.snapshot();
    assert_eq!(base.revision, Revision(0));

    // Append preedit "にほんご" at the end.
    let end = utf16_len(&base.text);
    let after_preedit = actor
        .apply_edits(EditRequest {
            document_id: base.document_id.clone(),
            base_revision: base.revision,
            source: EditSource::Gui,
            edits: vec![gui_edit(end, end, "にほんご")],
        })
        .unwrap();
    assert_eq!(after_preedit.text, "こんにちはにほんご");
    assert_eq!(after_preedit.revision, Revision(1));

    // Commit: replace preedit range with kanji "日本語".
    let preedit_start = end;
    let preedit_end = preedit_start + utf16_len("にほんご");
    let committed = actor
        .apply_edits(EditRequest {
            document_id: after_preedit.document_id.clone(),
            base_revision: after_preedit.revision,
            source: EditSource::Gui,
            edits: vec![gui_edit(preedit_start, preedit_end, "日本語")],
        })
        .unwrap();
    assert_eq!(committed.text, "こんにちは日本語");
    assert_eq!(committed.revision, Revision(2));
    // Buffer truth matches the snapshot exactly.
    assert_eq!(actor.buffer_text().unwrap(), "こんにちは日本語");
    // Offsets round-trip through validation (no surrogate splits).
    for unit in 0..=utf16_len(&committed.text) {
        let byte = utf16_to_utf8(&committed.text, Utf16Offset(unit));
        if let Ok(byte) = byte {
            assert_eq!(
                utf8_to_utf16(&committed.text, byte).unwrap(),
                Utf16Offset(unit)
            );
        }
    }
}

#[test]
/// Compare emoji UTF-16 positions with native byte columns and rendered cell widths.
fn emoji_offsets_match_neovim_bytes_and_display() {
    require_bundle();
    let session = NeovimSession::spawn_isolated().unwrap();
    let text = "a😀日本語";
    session.set_text(text).unwrap();
    assert_eq!(session.get_text().unwrap(), text);

    // "a"=1 unit/1 byte, "😀"=2 units/4 bytes, each CJK=1 unit/3 bytes.
    assert_eq!(utf16_to_utf8(text, Utf16Offset(1)).unwrap().0, 1);
    assert_eq!(utf16_to_utf8(text, Utf16Offset(3)).unwrap().0, 5);
    let (row, col) = global_utf16_to_line_byte(text, Utf16Offset(3)).unwrap();
    assert_eq!((row, col), (0, 5));

    // Rust display width matches authoritative Neovim strdisplaywidth().
    for probe in ["a", "😀", "日本語", "a😀日本語", "e\u{301}"] {
        let expected = session.strdisplaywidth(probe).unwrap();
        assert_eq!(display_width(probe) as u64, expected, "{probe}");
    }

    // Range edit over the emoji via the actor resolves to the same bytes.
    let actor = marxen_lib::open_document(doc_id("emoji"), text.into(), None).unwrap();
    let base = actor.snapshot();
    let next = actor
        .apply_edits(EditRequest {
            document_id: base.document_id.clone(),
            base_revision: base.revision,
            source: EditSource::Gui,
            edits: vec![gui_edit(1, 3, "😎")],
        })
        .unwrap();
    assert_eq!(next.text, "a😎日本語");
}

#[test]
/// Require a configured user mapping to execute before any editor fallback behavior.
fn user_mapping_wins_and_fires() {
    require_bundle();
    let session = NeovimSession::spawn_isolated().unwrap();
    attach(session.client(), 80, 24).unwrap();
    apply_user_lua(
        session.client(),
        "vim.keymap.set('i', 'jj', '<Esc>', { noremap = true })",
    )
    .unwrap();
    assert!(has_mapping(session.client(), "i", "jj").unwrap());

    session.command("startinsert").unwrap();
    assert_eq!(session.mode().unwrap(), VimMode::Insert);
    session.input("jj").unwrap();
    // Give the input queue a beat; mode() flushes via a round-trip call.
    let mut mode = session.mode().unwrap();
    for _ in 0..20 {
        if mode == VimMode::Normal {
            break;
        }
        std::thread::sleep(Duration::from_millis(25));
        mode = session.mode().unwrap();
    }
    assert_eq!(mode, VimMode::Normal);
}

#[test]
/// Observe actual native mode transitions after input rather than predicting modes from keys.
fn modes_track_real_nvim() {
    require_bundle();
    let session = NeovimSession::spawn_isolated().unwrap();
    attach(session.client(), 80, 24).unwrap();
    assert_eq!(session.mode().unwrap(), VimMode::Normal);

    session.command("startinsert").unwrap();
    assert_eq!(session.mode().unwrap(), VimMode::Insert);
    session.input("\u{1b}").unwrap(); // <Esc>
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(session.mode().unwrap(), VimMode::Normal);

    session.command("startreplace").unwrap();
    assert_eq!(session.mode().unwrap(), VimMode::Replace);
    session.input("\u{1b}").unwrap();
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(session.mode().unwrap(), VimMode::Normal);

    // Visual via typed `v`, back with <Esc>.
    session.set_text("hello\nworld").unwrap();
    session.input("v").unwrap();
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(session.mode().unwrap(), VimMode::Visual);
    session.input("\u{1b}").unwrap();
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(session.mode().unwrap(), VimMode::Normal);
}

#[test]
/// Compare display-width coordinates and redraw grid output from the real embedded UI.
fn display_coordinates_and_raw_grid() {
    require_bundle();
    let session = NeovimSession::spawn_isolated().unwrap();
    session.set_text("a😀日本語\nsecond").unwrap();
    attach(session.client(), 40, 10).unwrap();
    // Force a full redraw so grid_line events arrive (async: poll briefly).
    session.command("redraw!").unwrap();
    let mut notes = Vec::new();
    for _ in 0..20 {
        std::thread::sleep(Duration::from_millis(50));
        notes = session.client().drain_notifications();
        if notes.iter().any(|note| note.method == "redraw") {
            break;
        }
    }
    let redraws: Vec<_> = notes
        .iter()
        .filter(|note| note.method == "redraw")
        .collect();
    assert!(!redraws.is_empty(), "expected redraw notifications");
    let mut rendered = String::new();
    for note in redraws {
        for line in grid_lines_from_redraw(&note.params) {
            rendered.push_str(&grid_line_text(&line));
            rendered.push('\n');
        }
    }
    assert!(
        rendered.contains("日本語"),
        "grid should render Japanese, got: {rendered:?}"
    );
    detach(session.client()).unwrap();

    // Cursor byte col converts back to the same global UTF-16 offset.
    let text = session.get_text().unwrap();
    let target = utf8_to_utf16(&text, {
        let byte = text.find("日").unwrap() as u32;
        marxen_lib::contracts::Utf8ByteOffset(byte)
    })
    .unwrap();
    let (row, col) = global_utf16_to_line_byte(&text, target).unwrap();
    assert_eq!(row, 0);
    session
        .client()
        .call(
            "nvim_win_set_cursor",
            vec![
                session
                    .client()
                    .call("nvim_get_current_win", vec![])
                    .unwrap(),
                rmpv::Value::Array(vec![
                    rmpv::Value::from((row + 1) as u64),
                    rmpv::Value::from(col as u64),
                ]),
            ],
        )
        .unwrap();
    let (cursor_row, cursor_col) = session.win_cursor().unwrap();
    assert_eq!((cursor_row, cursor_col), ((row + 1) as u64, col as u64));
}

#[test]
/// Share native Undo between GUI edits and Vim while rejecting edits against an obsolete revision.
fn gui_edits_share_native_undo_and_reject_stale() {
    require_bundle();
    let actor = marxen_lib::open_document(doc_id("undo"), "hello".into(), None).unwrap();
    let base = actor.snapshot();
    let end = utf16_len("hello");

    let edited = actor
        .apply_edits(EditRequest {
            document_id: base.document_id.clone(),
            base_revision: base.revision,
            source: EditSource::Gui,
            edits: vec![gui_edit(end, end, " world")],
        })
        .unwrap();
    assert_eq!(edited.text, "hello world");
    assert_eq!(edited.revision, Revision(1));

    // Native undo reverts the GUI range edit; history is shared.
    let undone = actor.undo().unwrap();
    assert_eq!(undone.text, "hello");
    assert_eq!(undone.revision, Revision(2));

    let redone = actor.redo().unwrap();
    assert_eq!(redone.text, "hello world");
    assert_eq!(redone.revision, Revision(3));

    // Stale base is rejected with expected/received for resync.
    let stale = actor.apply_edits(EditRequest {
        document_id: base.document_id.clone(),
        base_revision: Revision(1),
        source: EditSource::Gui,
        edits: vec![gui_edit(0, 1, "H")],
    });
    assert_eq!(
        stale.unwrap_err().to_string(),
        ActorError::Contract(ContractError::StaleRevision {
            expected: Revision(3),
            received: Revision(1),
        })
        .to_string()
    );

    // Vim-side typing via real mappings also mints a Neovim revision.
    let before = actor.snapshot();
    let after = actor.input_via_nvim("ix").unwrap();
    assert!(after.revision.0 > before.revision.0);
    assert!(after.text.contains('x'));
}

#[test]
/// Intercept native write commands and save through the Rust conflict-aware document operation.
fn w_delegates_to_rust_save_path() {
    require_bundle();
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("marxen-issue3.md");
    let actor = marxen_lib::open_document(
        doc_id("save"),
        "# title\n\n本文\n".into(),
        Some(file.clone()),
    )
    .unwrap();
    actor.install_save_intercept().unwrap();

    let base = actor.snapshot();
    let edited = actor
        .apply_edits(EditRequest {
            document_id: base.document_id.clone(),
            base_revision: base.revision,
            source: EditSource::Gui,
            edits: vec![gui_edit(
                utf16_len(&base.text),
                utf16_len(&base.text),
                "- 追記\n",
            )],
        })
        .unwrap();
    assert!(edited.dirty);

    // `:w` must NOT write by itself; it notifies Rust, which saves.
    actor.nvim_command("w").unwrap();
    std::thread::sleep(Duration::from_millis(200));
    assert!(!actor.drain_save_requests().is_empty());
    // File does not exist until Rust saves (BufWriteCmd performed no write).
    assert!(!file.exists());

    let result = actor
        .save(SaveRequest {
            document_id: edited.document_id.clone(),
            base_revision: edited.revision,
        })
        .unwrap();
    assert!(!result.dirty);
    assert_eq!(result.revision, edited.revision);
    assert_eq!(std::fs::read_to_string(&file).unwrap(), edited.text);
    assert!(!actor.snapshot().dirty);
}

#[test]
/// Expose a failed user configuration instead of silently claiming it was loaded.
fn config_errors_surface_instead_of_silent_fallback() {
    require_bundle();
    let dir = tempfile::tempdir().unwrap();
    let bad = dir.path().join("init.lua");
    std::fs::write(&bad, "vim.cmd('NotARealMarxenCommand')\n").unwrap();
    let session = NeovimSession::spawn_with_config(ConfigSource::UserFile(bad)).unwrap();
    let report = session.config_report();
    assert!(
        report.has_errors(),
        "expected config errors, got: {report:?}"
    );
    // Session still speaks RPC after a bad user config.
    attach(session.client(), 80, 24).unwrap();
    assert_eq!(session.mode().unwrap(), VimMode::Normal);

    // Isolated default stays clean.
    let clean = NeovimSession::spawn_isolated().unwrap();
    assert!(!clean.config_report().has_errors());
}

#[test]
/// Validate cursor requests against the current snapshot without minting a text revision.
fn cursor_reports_validate_without_bumping_revision() {
    require_bundle();
    let actor = marxen_lib::open_document(doc_id("cursor"), "a😀日本語".into(), None).unwrap();
    let base = actor.snapshot();

    // Reversed (anchor > head) selections are valid cursor reports.
    let update = CursorUpdate {
        document_id: base.document_id.clone(),
        revision: base.revision,
        anchor: Utf16Offset(3),
        head: Utf16Offset(0),
    };
    assert_eq!(actor.check_cursor(update.clone()).unwrap(), update);
    assert_eq!(actor.snapshot().revision, base.revision);

    // Splitting the emoji surrogate pair is rejected.
    let split = actor.check_cursor(CursorUpdate {
        document_id: base.document_id.clone(),
        revision: base.revision,
        anchor: Utf16Offset(2),
        head: Utf16Offset(2),
    });
    assert!(matches!(
        split.unwrap_err(),
        ActorError::Contract(ContractError::SplitSurrogatePair)
    ));
}
