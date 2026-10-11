//! Pure validation only. Applying changes and serializing saves belong to the future Neovim actor.
use crate::contracts::*;
use std::ops::Range;

/// Accept a 1–128-byte document handle containing only ASCII letters, digits,
/// hyphens, or underscores; return `InvalidDocumentId` otherwise.
pub fn validate_document_id(id: &DocumentId) -> Result<(), ContractError> {
    if id.0.is_empty()
        || id.0.len() > 128
        || !id
            .0
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(ContractError::InvalidDocumentId);
    }
    Ok(())
}

/// Advance a revision by one, returning `RevisionExhausted` instead of wrapping.
pub fn next_revision(revision: Revision) -> Result<Revision, ContractError> {
    revision
        .0
        .checked_add(1)
        .map(Revision)
        .ok_or(ContractError::RevisionExhausted)
}

/// Convert a global UTF-16 code-unit offset to a UTF-8 byte offset, including EOF.
/// Reject surrogate-pair splits, offsets beyond EOF, and text too large for `u32` bytes.
pub fn utf16_to_utf8(text: &str, offset: Utf16Offset) -> Result<Utf8ByteOffset, ContractError> {
    if text.len() > u32::MAX as usize {
        return Err(ContractError::OffsetOutOfBounds);
    }
    let mut units = 0;
    for (byte, ch) in text.char_indices() {
        if units == offset.0 {
            return u32::try_from(byte)
                .map(Utf8ByteOffset)
                .map_err(|_| ContractError::OffsetOutOfBounds);
        }
        units += ch.len_utf16() as u32;
        if units > offset.0 {
            return Err(ContractError::SplitSurrogatePair);
        }
    }
    if units == offset.0 {
        u32::try_from(text.len())
            .map(Utf8ByteOffset)
            .map_err(|_| ContractError::OffsetOutOfBounds)
    } else {
        Err(ContractError::OffsetOutOfBounds)
    }
}

/// Count UTF-16 code units before a global UTF-8 byte offset, including EOF.
/// Reject bytes beyond EOF, bytes inside a scalar, or a result exceeding `u32`.
pub fn utf8_to_utf16(text: &str, offset: Utf8ByteOffset) -> Result<Utf16Offset, ContractError> {
    let byte = offset.0 as usize;
    if byte > text.len() {
        return Err(ContractError::OffsetOutOfBounds);
    }
    if !text.is_char_boundary(byte) {
        return Err(ContractError::NotUtf8Boundary);
    }
    u32::try_from(text[..byte].encode_utf16().count())
        .map(Utf16Offset)
        .map_err(|_| ContractError::OffsetOutOfBounds)
}

/// Check handle syntax, document identity, then revision equality against the snapshot.
/// A revision mismatch reports both the authoritative and received revisions.
fn validate_identity(
    snapshot: &DocumentSnapshot,
    id: &DocumentId,
    revision: Revision,
) -> Result<(), ContractError> {
    validate_document_id(id)?;
    if id != &snapshot.document_id {
        return Err(ContractError::WrongDocument);
    }
    if revision != snapshot.revision {
        return Err(ContractError::StaleRevision {
            expected: snapshot.revision,
            received: revision,
        });
    }
    Ok(())
}

/// Edits must be ascending, non-overlapping, and expressed against one base snapshot.
/// Equal starts (including multiple insertions) are rejected to remove ordering ambiguity.
/// Validate identity and revision capacity first, then return UTF-8 byte ranges;
/// empty edits, reversed ranges, and invalid UTF-16 boundaries are errors.
pub fn validate_edit(
    snapshot: &DocumentSnapshot,
    request: &EditRequest,
) -> Result<Vec<Range<usize>>, ContractError> {
    validate_identity(snapshot, &request.document_id, request.base_revision)?;
    next_revision(snapshot.revision)?;
    if request.edits.is_empty() {
        return Err(ContractError::EmptyEdits);
    }
    let mut ranges = Vec::with_capacity(request.edits.len());
    let mut previous: Option<&Utf16Range> = None;
    for edit in &request.edits {
        let range = &edit.range;
        if range.start.0 > range.end.0 {
            return Err(ContractError::ReversedRange);
        }
        if let Some(prev) = previous {
            if range.start.0 < prev.end.0 || range.start.0 <= prev.start.0 {
                return Err(ContractError::OverlappingEdits);
            }
        }
        let start = utf16_to_utf8(&snapshot.text, range.start)?.0 as usize;
        let end = utf16_to_utf8(&snapshot.text, range.end)?.0 as usize;
        ranges.push(start..end);
        previous = Some(range);
    }
    Ok(ranges)
}

/// Require a save to address the snapshot's document and current revision.
pub fn validate_save(
    snapshot: &DocumentSnapshot,
    request: &SaveRequest,
) -> Result<(), ContractError> {
    validate_identity(snapshot, &request.document_id, request.base_revision)
}

/// Require matching document/revision and surrogate-safe UTF-16 anchor and head offsets.
/// Anchor and head may be reversed because selection direction is preserved.
pub fn validate_cursor(
    snapshot: &DocumentSnapshot,
    update: &CursorUpdate,
) -> Result<(), ContractError> {
    validate_identity(snapshot, &update.document_id, update.revision)?;
    utf16_to_utf8(&snapshot.text, update.anchor)?;
    utf16_to_utf8(&snapshot.text, update.head)?;
    Ok(())
}

/// Require a mode update to address the snapshot's document and current revision.
pub fn validate_mode(
    snapshot: &DocumentSnapshot,
    update: &ModeUpdate,
) -> Result<(), ContractError> {
    validate_identity(snapshot, &update.document_id, update.revision)
}
