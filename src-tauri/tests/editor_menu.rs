use marxen_lib::application::clipboard::Clipboard;
use marxen_lib::contracts::{
    CursorUpdate, DocumentId, EditRequest, EditSource, Revision, SaveRequest, TextEdit,
    Utf16Offset, Utf16Range,
};
use std::sync::Mutex;

#[derive(Default)]
struct MemoryClipboard(Mutex<String>);
impl Clipboard for MemoryClipboard {
    /// Return fixture text without touching the host clipboard.
    fn read_text(&self) -> Result<String, String> {
        Ok(self.0.lock().unwrap().clone())
    }
    /// Retain exact copied native selection bytes for assertions.
    fn write(
        &self,
        text: String,
        _html: Option<String>,
        _rtf: Option<String>,
    ) -> Result<(), String> {
        *self.0.lock().unwrap() = text;
        Ok(())
    }
}

/// Build a request against the actor's latest acknowledged revision.
fn request(actor: &marxen_lib::application::document::DocumentActor) -> SaveRequest {
    let snapshot = actor.snapshot();
    SaveRequest {
        document_id: snapshot.document_id,
        base_revision: snapshot.revision,
    }
}

#[test]
/// Read actual buffer-local mapping precedence and accept only explicit numeric/boolean popup opt-in.
fn native_editor_configuration_is_truthful_and_opt_in() {
    let actor =
        marxen_lib::open_document(DocumentId("editor-config".into()), "abc".into(), None).unwrap();
    assert!(
        !actor
            .editor_context(request(&actor))
            .unwrap()
            .presentation
            .selection_toolbar
    );
    actor
        .nvim_command("nnoremap Q u | nnoremap <buffer> Q :echo 'local'<CR>")
        .unwrap();
    actor
        .nvim_command("let g:marxen_selection_toolbar=1")
        .unwrap();
    let context = actor.editor_context(request(&actor)).unwrap();
    assert!(context.presentation.selection_toolbar);
    assert_eq!(
        context
            .presentation
            .mappings
            .iter()
            .filter(|mapping| mapping.lhs == "Q")
            .count(),
        1
    );
    assert!(context
        .presentation
        .mappings
        .iter()
        .any(|mapping| mapping.lhs == "Q" && mapping.rhs.contains("local")));
    actor
        .nvim_command("let g:marxen_selection_toolbar='1'")
        .unwrap();
    assert!(
        !actor
            .editor_context(request(&actor))
            .unwrap()
            .presentation
            .selection_toolbar
    );
}

#[test]
/// Cut exact Unicode Visual bytes, paste literal text, and traverse actual guarded native history.
fn clipboard_actions_use_native_selection_and_undo() {
    let actor = marxen_lib::open_document(
        DocumentId("editor-clipboard".into()),
        "前日本😀後\nnext".into(),
        None,
    )
    .unwrap();
    let clipboard = MemoryClipboard::default();
    actor
        .set_cursor(CursorUpdate {
            document_id: DocumentId("editor-clipboard".into()),
            revision: Revision(0),
            anchor: Utf16Offset(1),
            head: Utf16Offset(5),
        })
        .unwrap();
    let context = actor.editor_context(request(&actor)).unwrap();
    actor
        .editor_clipboard(context.cursor.clone(), "copy", &clipboard)
        .unwrap();
    assert_eq!(clipboard.read_text().unwrap(), "日本😀");
    assert_eq!(actor.snapshot().revision, Revision(0));
    actor
        .editor_clipboard(context.cursor, "cut", &clipboard)
        .unwrap();
    assert_eq!(actor.snapshot().text, "前後\nnext");
    let context = actor.editor_context(request(&actor)).unwrap();
    actor
        .editor_clipboard(context.cursor, "paste", &clipboard)
        .unwrap();
    assert_eq!(actor.snapshot().text, "前日本😀後\nnext");
    actor.editor_history(request(&actor), false).unwrap();
    assert_eq!(actor.snapshot().text, "前後\nnext");
    actor.editor_history(request(&actor), true).unwrap();
    assert_eq!(actor.snapshot().text, "前日本😀後\nnext");
}

#[test]
/// Reject stale revision and same-revision cursor changes before any clipboard side effect.
fn clipboard_guards_reject_drift() {
    let actor =
        marxen_lib::open_document(DocumentId("editor-stale".into()), "abcd".into(), None).unwrap();
    let clipboard = MemoryClipboard::default();
    actor
        .set_cursor(CursorUpdate {
            document_id: DocumentId("editor-stale".into()),
            revision: Revision(0),
            anchor: Utf16Offset(0),
            head: Utf16Offset(2),
        })
        .unwrap();
    let context = actor.editor_context(request(&actor)).unwrap();
    actor
        .set_cursor(CursorUpdate {
            head: Utf16Offset(3),
            ..context.cursor.clone()
        })
        .unwrap();
    assert!(actor
        .editor_clipboard(context.cursor.clone(), "cut", &clipboard)
        .is_err());
    assert_eq!(clipboard.read_text().unwrap(), "");
    let stale_format = EditRequest {
        document_id: DocumentId("editor-stale".into()),
        base_revision: Revision(0),
        source: EditSource::Gui,
        edits: vec![TextEdit {
            range: Utf16Range {
                start: Utf16Offset(0),
                end: Utf16Offset(2),
            },
            text: "**ab**".into(),
        }],
    };
    assert!(actor
        .apply_editor_edits(stale_format, context.cursor.clone())
        .is_err());
    assert_eq!(actor.snapshot().text, "abcd");
    actor
        .apply_edits(EditRequest {
            document_id: DocumentId("editor-stale".into()),
            base_revision: Revision(0),
            source: EditSource::Gui,
            edits: vec![TextEdit {
                range: Utf16Range {
                    start: Utf16Offset(0),
                    end: Utf16Offset(0),
                },
                text: "X".into(),
            }],
        })
        .unwrap();
    assert!(actor
        .editor_clipboard(context.cursor, "copy", &clipboard)
        .is_err());
    assert!(actor
        .editor_history(
            SaveRequest {
                document_id: DocumentId("editor-stale".into()),
                base_revision: Revision(0)
            },
            false
        )
        .is_err());
    assert_eq!(clipboard.read_text().unwrap(), "");
    assert_eq!(actor.snapshot().text, "Xabcd");
}

#[test]
/// Permit copy but reject mutating menu actions on a native read-only buffer.
fn native_readonly_clipboard_guard() {
    let actor =
        marxen_lib::open_document(DocumentId("editor-readonly".into()), "abcd".into(), None)
            .unwrap();
    let clipboard = MemoryClipboard::default();
    actor
        .set_cursor(CursorUpdate {
            document_id: DocumentId("editor-readonly".into()),
            revision: Revision(0),
            anchor: Utf16Offset(0),
            head: Utf16Offset(2),
        })
        .unwrap();
    actor.nvim_command("setlocal readonly").unwrap();
    let context = actor.editor_context(request(&actor)).unwrap();
    assert!(!context.presentation.editable);
    actor
        .editor_clipboard(context.cursor.clone(), "copy", &clipboard)
        .unwrap();
    assert_eq!(clipboard.read_text().unwrap(), "ab");
    assert!(actor
        .editor_clipboard(context.cursor.clone(), "cut", &clipboard)
        .is_err());
    assert!(actor
        .editor_clipboard(context.cursor, "paste", &clipboard)
        .is_err());
    assert!(actor.editor_history(request(&actor), false).is_err());
    assert_eq!(actor.snapshot().text, "abcd");
}

#[test]
/// Install the GUI hard-break caret at its committed revision before native Insert Enter and following text.
fn hard_break_cursor_precedes_native_enter() {
    let actor =
        marxen_lib::open_document(DocumentId("hard-break".into()), "日本😀".into(), None).unwrap();
    actor.input_checked(request(&actor), "A").unwrap();
    let snapshot = actor
        .apply_edits(EditRequest {
            document_id: DocumentId("hard-break".into()),
            base_revision: Revision(0),
            source: EditSource::Gui,
            edits: vec![TextEdit {
                range: Utf16Range {
                    start: Utf16Offset(4),
                    end: Utf16Offset(4),
                },
                text: "  ".into(),
            }],
        })
        .unwrap();
    actor
        .set_cursor(CursorUpdate {
            document_id: snapshot.document_id,
            revision: snapshot.revision,
            anchor: Utf16Offset(6),
            head: Utf16Offset(6),
        })
        .unwrap();
    actor.input_checked(request(&actor), "<CR>").unwrap();
    actor.input_checked(request(&actor), "続き").unwrap();
    assert_eq!(actor.snapshot().text, "日本😀  \n続き");
    assert_eq!(actor.cursor().unwrap().head, Utf16Offset(9));
}
