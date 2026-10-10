//! Exact UTF-16 scopes, proposal patches, and review rendering.
use crate::contracts::ai::*;
use crate::contracts::*;
use crate::domain::storage;
use std::path::{Component, Path};
/// Accept a 1–128-byte ASCII alphanumeric/hyphen/underscore copy handle.
/// Invalid handles, including path syntax, return `InvalidPath`.
pub fn validate_copy_id_string(id: &str) -> Result<(), WorkspaceError> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(WorkspaceError::InvalidPath);
    }
    Ok(())
}
/// Count UTF-16 code units, saturating at the largest representable contract offset.
pub(crate) fn utf16_len(text: &str) -> u32 {
    u32::try_from(text.encode_utf16().count()).unwrap_or(u32::MAX)
}

/// Copy a half-open UTF-16 range after converting both scalar-safe boundaries.
/// Conversion errors propagate; callers must ensure `start <= end` to avoid a slice panic.
pub(crate) fn utf16_slice(text: &str, range: &Utf16Range) -> Result<String, ContractError> {
    let start = crate::domain::validation::utf16_to_utf8(text, range.start)?.0 as usize;
    let end = crate::domain::validation::utf16_to_utf8(text, range.end)?.0 as usize;
    Ok(text[start..end].to_owned())
}

/// Reject staging names outside the selected Markdown scope: .git, .env,
/// reserved transfer files, and non-Markdown writes are never applied.
pub(crate) fn reject_forbidden_relative(rel: &str) -> Result<(), WorkspaceError> {
    let path = Path::new(rel);
    for part in path.components() {
        let name = match part {
            Component::Normal(name) => name.to_string_lossy().to_ascii_lowercase(),
            _ => return Err(WorkspaceError::OutsideWorkspace),
        };
        if name == ".git"
            || name == ".env"
            || name.starts_with(".marxen-")
            || name == "credentials"
            || name == ".credentials"
        {
            return Err(WorkspaceError::OutsideWorkspace);
        }
    }
    if !storage::markdown(path) {
        return Err(WorkspaceError::NotMarkdown);
    }
    Ok(())
}

/// Wrap a stale-revision contract error with the received and authoritative revisions.
pub(crate) fn stale(received: Revision, expected: Revision) -> WorkspaceError {
    WorkspaceError::Contract {
        error: ContractError::StaleRevision { expected, received },
    }
}

/// Preserve a scope-validation explanation in a workspace I/O error.
pub(crate) fn invalid_scope(detail: &str) -> WorkspaceError {
    WorkspaceError::Io {
        detail: detail.to_owned(),
    }
}

/// Validate one context against the authoritative snapshot: revision match,
/// ordered non-overlapping ranges with surrogate-safe boundaries, and an
/// excerpt that exactly equals the concatenated source slices.
pub(crate) fn validate_context_against_snapshot(
    snapshot: &DocumentSnapshot,
    context: &PromptContext,
) -> Result<(), WorkspaceError> {
    if snapshot.revision != context.revision {
        return Err(stale(context.revision, snapshot.revision));
    }
    if context.text.len() > crate::domain::ai::MAX_EXCERPT_BYTES {
        return Err(WorkspaceError::InvalidPath);
    }
    if context.ranges.is_empty() || context.ranges.len() > crate::domain::ai::MAX_RANGES_PER_CONTEXT
    {
        return Err(WorkspaceError::InvalidPath);
    }
    let mut previous: Option<&Utf16Range> = None;
    let mut assembled = String::new();
    for range in &context.ranges {
        if range.start.0 > range.end.0 {
            return Err(WorkspaceError::Contract {
                error: ContractError::ReversedRange,
            });
        }
        if let Some(prev) = previous {
            if range.start.0 < prev.end.0 || range.start.0 <= prev.start.0 {
                return Err(WorkspaceError::Contract {
                    error: ContractError::OverlappingEdits,
                });
            }
        }
        let slice = utf16_slice(&snapshot.text, range)
            .map_err(|error| WorkspaceError::Contract { error })?;
        assembled.push_str(&slice);
        previous = Some(range);
    }
    if assembled != context.text {
        return Err(invalid_scope("送信した内容が対象範囲と一致しません"));
    }
    Ok(())
}

// ---- Scoped staging file format ----
//
// Scoped files carry one section per registered range so the agent only ever
// sees selected text. Full-document copies (a single explicitly selected
// [0, len) range) are stored as raw Markdown with no headers.
// A document line that happens to look like a header can never match the
// registered scopes, so it fails closed at parse time instead of aliasing.

const SCOPE_MARK: &str = "--- marxen-scope";
pub(crate) const PATCH_MARK: &str = "--- marxen-patch";

/// Render one staging header with the document handle and half-open UTF-16 offsets.
pub(crate) fn scope_header(document_id: &DocumentId, range: &Utf16Range) -> String {
    format!(
        "--- marxen-scope document={} range=[{}, {}) ---",
        document_id.0, range.start.0, range.end.0
    )
}

/// Parse the exact `range=[start, end)` suffix as unsigned UTF-16 offsets.
/// Malformed syntax or numbers yield `None`; ordering is validated by the caller.
pub(crate) fn parse_range_suffix(text: &str) -> Option<Utf16Range> {
    let (start, end) = text
        .strip_prefix("range=[")?
        .strip_suffix(")")?
        .split_once(", ")?;
    Some(Utf16Range {
        start: Utf16Offset(start.parse().ok()?),
        end: Utf16Offset(end.parse().ok()?),
    })
}

/// Read a scope marker, nonempty document handle, and numeric range from one header.
/// Return `None` for malformed headers; this does not match registered scopes.
pub(crate) fn parse_scope_header(line: &str) -> Option<(String, Utf16Range)> {
    let rest = line.strip_prefix(SCOPE_MARK)?.strip_suffix(" ---")?.trim();
    let (doc_part, range_part) = rest.split_once(' ')?;
    let document_id = doc_part.strip_prefix("document=")?.to_owned();
    if document_id.is_empty() {
        return None;
    }
    Some((document_id, parse_range_suffix(range_part)?))
}

/// Split a scoped file into (document, range, body) sections. Bodies use the
/// render rule: sections are header + slice + exactly one added newline, so
/// parsing strips exactly one trailing newline from non-empty bodies.
pub(crate) fn parse_scoped_file(text: &str) -> Result<Vec<(String, Utf16Range, String)>, String> {
    let mut sections = Vec::new();
    let mut current: Option<(String, Utf16Range, Vec<String>)> = None;
    for (index, line) in text.split('\n').enumerate() {
        if line.starts_with(SCOPE_MARK) {
            if let Some((doc, range, body)) = current.take() {
                sections.push((doc, range, join_body(body)));
            }
            let (doc, range) = parse_scope_header(line)
                .ok_or_else(|| format!("{} 行目の scope 形式が正しくありません", index + 1))?;
            current = Some((doc, range, Vec::new()));
        } else if let Some((_, _, body)) = current.as_mut() {
            body.push(line.to_owned());
        } else {
            return Err(format!(
                "先頭が scope ヘッダーではありません ({} 行目)",
                index + 1
            ));
        }
    }
    if let Some((doc, range, body)) = current.take() {
        // A rendered file always ends with a newline, leaving one empty
        // trailing line from the final split; drop it before joining.
        let mut body = body;
        if body.last().is_some_and(|line| line.is_empty()) {
            body.pop();
        }
        sections.push((doc, range, join_body(body)));
    }
    if sections.is_empty() {
        return Err("scope が一つもありません".into());
    }
    Ok(sections)
}

/// Join section lines with LF, preserving empty lines represented by the input.
/// The temporary trailing LF is removed again; an empty vector yields empty text.
pub(crate) fn join_body(lines: Vec<String>) -> String {
    if lines.is_empty() {
        return String::new();
    }
    let mut out = lines.join("\n");
    out.push('\n');
    // Render added exactly one newline after the slice; remove it so an
    // unedited section round-trips to the registered slice exactly.
    out.strip_suffix('\n').unwrap_or(&out).to_owned()
}

/// Emit each scope as a header, LF, exact excerpt, and one framing LF.
/// Excerpts and range order are used as supplied, without validation or normalization.
pub(crate) fn render_scoped_file(
    document_id: &DocumentId,
    scopes: &[(Utf16Range, String)],
) -> String {
    let mut out = String::new();
    for (range, slice) in scopes {
        out.push_str(&scope_header(document_id, range));
        out.push('\n');
        out.push_str(slice);
        out.push('\n');
    }
    out
}

/// Minimal single range patch turning `base` into `staging`, preserving all
/// bytes outside the differing span (BOM/CRLF/spacing stay exact). Returns
/// None when the texts are equal.
pub(crate) fn minimal_edit(base: &str, staging: &str) -> Option<TextEdit> {
    if base == staging {
        return None;
    }
    let base_bytes = base.as_bytes();
    let staging_bytes = staging.as_bytes();
    let mut prefix = 0usize;
    while prefix < base_bytes.len()
        && prefix < staging_bytes.len()
        && base_bytes[prefix] == staging_bytes[prefix]
    {
        prefix += 1;
    }
    while prefix > 0 && !base.is_char_boundary(prefix) {
        prefix -= 1;
    }
    let mut suffix = 0usize;
    while suffix < base_bytes.len() - prefix
        && suffix < staging_bytes.len() - prefix
        && base_bytes[base_bytes.len() - 1 - suffix]
            == staging_bytes[staging_bytes.len() - 1 - suffix]
    {
        suffix += 1;
    }
    while suffix > 0
        && (!base.is_char_boundary(base_bytes.len() - suffix)
            || !staging.is_char_boundary(staging_bytes.len() - suffix))
    {
        suffix -= 1;
    }
    let start = crate::domain::validation::utf8_to_utf16(
        base,
        crate::contracts::Utf8ByteOffset(prefix as u32),
    )
    .ok()?;
    let end = crate::domain::validation::utf8_to_utf16(
        base,
        crate::contracts::Utf8ByteOffset((base_bytes.len() - suffix) as u32),
    )
    .ok()?;
    Some(TextEdit {
        range: Utf16Range { start, end },
        text: staging[prefix..staging_bytes.len() - suffix].to_owned(),
    })
}

/// Minimal line diff: common prefix/suffix lines, middle as -/+ block.
pub fn unified_diff(live_text: &str, staging_text: &str, label: &str) -> String {
    if live_text == staging_text {
        return format!("--- live:{label}\n+++ staging:{label}\n (変更なし)\n");
    }
    let live_lines: Vec<&str> = live_text.split('\n').collect();
    let staging_lines: Vec<&str> = staging_text.split('\n').collect();
    let mut prefix = 0usize;
    while prefix < live_lines.len()
        && prefix < staging_lines.len()
        && live_lines[prefix] == staging_lines[prefix]
    {
        prefix += 1;
    }
    let mut suffix = 0usize;
    while suffix < live_lines.len() - prefix
        && suffix < staging_lines.len() - prefix
        && live_lines[live_lines.len() - 1 - suffix]
            == staging_lines[staging_lines.len() - 1 - suffix]
    {
        suffix += 1;
    }
    let mut out = format!("--- live:{label}\n+++ staging:{label}\n");
    for (i, line) in live_lines.iter().enumerate() {
        if i < prefix || i >= live_lines.len() - suffix {
            continue;
        }
        out.push('-');
        out.push_str(line);
        out.push('\n');
    }
    for (i, line) in staging_lines.iter().enumerate() {
        if i < prefix || i >= staging_lines.len() - suffix {
            continue;
        }
        out.push('+');
        out.push_str(line);
        out.push('\n');
    }
    out
}

/// Apply one validated replacement to raw full-document text.
pub(crate) fn apply_patch_to_text(
    current: &str,
    range: &Utf16Range,
    body: &str,
) -> Result<String, WorkspaceError> {
    let start = crate::domain::validation::utf16_to_utf8(current, range.start)
        .map_err(|error| WorkspaceError::Contract { error })?
        .0 as usize;
    let end = crate::domain::validation::utf16_to_utf8(current, range.end)
        .map_err(|error| WorkspaceError::Contract { error })?
        .0 as usize;
    let mut out = String::with_capacity(current.len() + body.len());
    out.push_str(&current[..start]);
    out.push_str(body);
    out.push_str(&current[end..]);
    Ok(out)
}

/// Clone reviewed sections into the same header/excerpt format used for staging files.
pub(crate) fn render_scoped_sections(
    document_id: &DocumentId,
    sections: &[(Utf16Range, String)],
) -> String {
    render_scoped_file(
        document_id,
        &sections
            .iter()
            .map(|(range, text)| (range.clone(), text.clone()))
            .collect::<Vec<_>>(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::{DocumentId, Revision};

    /// Allow a normal copy handle while rejecting empty, relative-path, and absolute-path IDs.
    #[test]
    fn copy_ids_are_valid_handles() {
        assert!(validate_copy_id_string("copy_01").is_ok());
        assert!(validate_copy_id_string("").is_err());
        assert!(validate_copy_id_string("../live").is_err());
        assert!(validate_copy_id_string("/abs").is_err());
    }

    /// Assert that multiple sections preserve document IDs, UTF-16 ranges, empty
    /// bodies, internal LFs, and an excerpt's trailing LF across render/parse.
    #[test]
    fn scoped_sections_round_trip_exactly() {
        let doc = DocumentId("doc_01".into());
        let scopes = vec![
            (
                Utf16Range {
                    start: Utf16Offset(0),
                    end: Utf16Offset(5),
                },
                "hello".to_owned(),
            ),
            (
                Utf16Range {
                    start: Utf16Offset(5),
                    end: Utf16Offset(5),
                },
                String::new(),
            ),
            (
                Utf16Range {
                    start: Utf16Offset(6),
                    end: Utf16Offset(9),
                },
                "a\nb\n".to_owned(),
            ),
        ];
        let rendered = render_scoped_file(&doc, &scopes);
        let parsed = parse_scoped_file(&rendered).unwrap();
        assert_eq!(parsed.len(), 3);
        for ((parsed_doc, parsed_range, parsed_body), (range, slice)) in
            parsed.iter().zip(scopes.iter())
        {
            assert_eq!(parsed_doc, "doc_01");
            assert_eq!(parsed_range, range);
            assert_eq!(parsed_body, slice);
        }
    }

    /// Keep a syntactically valid foreign document ID for later scope validation,
    /// while rejecting text without a leading scope header and empty files.
    #[test]
    fn scoped_parse_rejects_header_mismatch() {
        let bad = "--- marxen-scope document=other range=[0, 1) ---\nx\n";
        assert!(parse_scoped_file(bad).is_ok());
        let (doc, _, _) = &parse_scoped_file(bad).unwrap()[0];
        assert_eq!(doc, "other");
        assert!(parse_scoped_file("no header here\n").is_err());
        assert!(parse_scoped_file("").is_err());
    }

    /// Omit equal-text patches and localize replacements/EOF insertions without
    /// absorbing a preceding BOM or unchanged CRLF bytes.
    #[test]
    fn minimal_edit_preserves_outside_bytes() {
        assert!(minimal_edit("abc", "abc").is_none());
        let edit = minimal_edit("\u{feff}a\r\nb\r\n", "\u{feff}a\r\nB\r\n").unwrap();
        assert_eq!(edit.range.start.0, 4);
        assert_eq!(edit.text, "B");
        let edit = minimal_edit("hello", "hello world").unwrap();
        assert_eq!(edit.range.start.0, 5);
        assert_eq!(edit.range.end.0, 5);
        assert_eq!(edit.text, " world");
    }

    /// Mark equal documents explicitly and show only the removed/added middle lines.
    #[test]
    fn unified_diff_marks_changes() {
        let same = unified_diff("a\nb\n", "a\nb\n", "a.md");
        assert!(same.contains("変更なし"));
        let diff = unified_diff("a\nb\nc\n", "a\nB\nc\n", "a.md");
        assert!(diff.contains("-b"));
        assert!(diff.contains("+B"));
    }

    /// Keep stale revisions classified as contract failures in the workspace error wrapper.
    #[test]
    fn revision_helper_reports_stale() {
        let error = stale(Revision(1), Revision(2));
        assert!(matches!(
            error,
            WorkspaceError::Contract {
                error: ContractError::StaleRevision { .. }
            }
        ));
    }
}
