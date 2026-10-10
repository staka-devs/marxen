use marxen_lib::{contracts::*, validation::*};

/// Build the fixed Unicode snapshot used to compare JSON wire data and range validation.
fn snapshot() -> DocumentSnapshot {
    DocumentSnapshot {
        document_id: DocumentId("doc_01".into()),
        revision: Revision(7),
        text: "a😀日本語\r\ne\u{301}".into(),
        dirty: false,
    }
}

/// Deserialize the shared edit fixture so Rust and TypeScript exercise the same boundary payload.
fn request() -> EditRequest {
    serde_json::from_str(include_str!("../../tests/fixtures/edit.json")).unwrap()
}

#[test]
/// Resolve the shared emoji edit range against the fixture while leaving its input snapshot untouched.
fn shared_wire_fixture_resolves_emoji_without_mutating_snapshot() {
    let doc = snapshot();
    let ranges = validate_edit(&doc, &request()).unwrap();
    assert_eq!(&doc.text[ranges[0].clone()], "😀");
    assert_eq!(doc.revision, Revision(7));
    assert!(!doc.dirty);
    assert_eq!(
        serde_json::to_value(request()).unwrap(),
        serde_json::from_str::<serde_json::Value>(include_str!("../../tests/fixtures/edit.json"))
            .unwrap()
    );
}

#[test]
/// Require UTF-8 and UTF-16 conversions to agree at every valid scalar boundary.
fn roundtrips_every_unicode_scalar_boundary() {
    for text in ["", "ascii", "日本語😀\r\n", "e\u{301}👩‍💻\n終"] {
        for byte in (0..=text.len()).filter(|&byte| text.is_char_boundary(byte)) {
            let utf16 = utf8_to_utf16(text, Utf8ByteOffset(byte as u32)).unwrap();
            assert_eq!(utf16_to_utf8(text, utf16), Ok(Utf8ByteOffset(byte as u32)));
        }
    }
}

#[test]
/// Reject positions inside a surrogate pair, inside UTF-8 bytes or beyond the document.
fn rejects_surrogate_split_byte_split_and_out_of_bounds() {
    assert_eq!(
        utf16_to_utf8("😀", Utf16Offset(1)),
        Err(ContractError::SplitSurrogatePair)
    );
    assert_eq!(
        utf8_to_utf16("日", Utf8ByteOffset(1)),
        Err(ContractError::NotUtf8Boundary)
    );
    assert_eq!(
        utf16_to_utf8("a", Utf16Offset(2)),
        Err(ContractError::OffsetOutOfBounds)
    );
    assert_eq!(
        utf8_to_utf16("a", Utf8ByteOffset(2)),
        Err(ContractError::OffsetOutOfBounds)
    );
}

#[test]
/// Refuse edits whose document identity or exact base revision does not match the snapshot.
fn rejects_stale_or_future_revision_and_wrong_document() {
    let mut req = request();
    for revision in [6, 8] {
        req.base_revision = Revision(revision);
        assert_eq!(
            validate_edit(&snapshot(), &req),
            Err(ContractError::StaleRevision {
                expected: Revision(7),
                received: Revision(revision)
            })
        );
    }
    req.base_revision = Revision(7);
    req.document_id = DocumentId("another".into());
    assert_eq!(
        validate_edit(&snapshot(), &req),
        Err(ContractError::WrongDocument)
    );
}

#[test]
/// Reject malformed or unsupported document identifiers at the boundary.
fn rejects_invalid_document_ids() {
    for id in ["", " ", "../file", "doc/1", "文書", &"x".repeat(129)] {
        assert_eq!(
            validate_document_id(&DocumentId(id.into())),
            Err(ContractError::InvalidDocumentId)
        );
    }
    assert!(validate_document_id(&DocumentId("doc_A-01".into())).is_ok());
}

#[test]
/// Require ordered, nonoverlapping ranges and reject duplicate insertions at one offset.
fn rejects_reversed_overlapping_unsorted_or_duplicate_insertions() {
    let mut req = request();
    req.edits[0].range = Utf16Range {
        start: Utf16Offset(3),
        end: Utf16Offset(1),
    };
    assert_eq!(
        validate_edit(&snapshot(), &req),
        Err(ContractError::ReversedRange)
    );
    for ranges in [[(0, 3), (1, 3)], [(3, 4), (0, 1)], [(0, 0), (0, 0)]] {
        req.edits = ranges
            .into_iter()
            .map(|(start, end)| TextEdit {
                range: Utf16Range {
                    start: Utf16Offset(start),
                    end: Utf16Offset(end),
                },
                text: String::new(),
            })
            .collect();
        assert_eq!(
            validate_edit(&snapshot(), &req),
            Err(ContractError::OverlappingEdits)
        );
    }
}

#[test]
/// Accept adjacent ranges and end-of-document insertion while refusing an empty edit batch.
fn accepts_adjacent_edits_and_end_insertion_rejects_empty_batch() {
    let mut req = request();
    req.edits = [(0, 1), (1, 3), (10, 10)]
        .into_iter()
        .map(|(start, end)| TextEdit {
            range: Utf16Range {
                start: Utf16Offset(start),
                end: Utf16Offset(end),
            },
            text: "x".into(),
        })
        .collect();
    assert_eq!(
        validate_edit(&snapshot(), &req).unwrap(),
        vec![0..1, 1..5, 19..19]
    );
    req.edits.clear();
    assert_eq!(
        validate_edit(&snapshot(), &req),
        Err(ContractError::EmptyEdits)
    );
}

#[test]
/// Use the same identity and revision rules for save, cursor and mode requests.
fn validates_save_cursor_and_mode_against_exact_snapshot() {
    let doc = snapshot();
    assert!(validate_save(
        &doc,
        &SaveRequest {
            document_id: doc.document_id.clone(),
            base_revision: doc.revision
        }
    )
    .is_ok());
    let mut cursor = CursorUpdate {
        document_id: doc.document_id.clone(),
        revision: doc.revision,
        anchor: Utf16Offset(3),
        head: Utf16Offset(0),
    };
    assert!(validate_cursor(&doc, &cursor).is_ok()); // backwards selections are valid
    cursor.head = Utf16Offset(2);
    assert_eq!(
        validate_cursor(&doc, &cursor),
        Err(ContractError::SplitSurrogatePair)
    );
    let mode = ModeUpdate {
        document_id: doc.document_id.clone(),
        revision: Revision(6),
        mode: VimMode::Insert,
    };
    assert!(matches!(
        validate_mode(&doc, &mode),
        Err(ContractError::StaleRevision { .. })
    ));
}

#[test]
/// Require revision exhaustion to return an error instead of wrapping to an older revision.
fn revision_never_wraps() {
    assert_eq!(
        next_revision(Revision(u32::MAX)),
        Err(ContractError::RevisionExhausted)
    );
    assert_eq!(next_revision(Revision(7)), Ok(Revision(8)));
}

#[test]
/// Refuse malformed JSON boundary values before they reach document operations.
fn malformed_wire_values_fail_deserialization() {
    let fixture = include_str!("../../tests/fixtures/edit.json");
    for invalid in [
        fixture.replace("7,", "-1,"),
        fixture.replace("7,", "1.5,"),
        fixture.replace("7,", "4294967296,"),
        fixture.replace("\"gui\"", "\"vim_emulator\""),
        fixture.replace("\"source\"", "\"unknown\""),
    ] {
        assert!(serde_json::from_str::<EditRequest>(&invalid).is_err());
    }
}

#[test]
/// Check serialized event and runtime-state fields against their declared IPC contract.
fn event_shape_and_runtime_state_are_truthful() {
    let event = DocumentEvent::Snapshot(snapshot());
    let value = serde_json::to_value(&event).unwrap();
    assert_eq!(value["type"], "snapshot");
    assert_eq!(value["payload"]["documentId"], "doc_01");
    assert_eq!(
        serde_json::from_value::<DocumentEvent>(value).unwrap(),
        event
    );
    assert_eq!(
        marxen_lib::runtime_status().connection,
        ConnectionState::Disconnected
    );
}
