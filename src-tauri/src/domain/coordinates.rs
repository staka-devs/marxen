//! Global UTF-16 offsets <-> Neovim (row, UTF-8 byte col) and display widths.
//!
//! Contracts count a document as one flat string with global UTF-16 offsets.
//! Neovim addresses `nvim_buf_set_text` with 0-indexed `(row, byte_col)` where
//! `byte_col` counts UTF-8 bytes inside a single `\n`-split line. Display
//! columns additionally depend on cell width (CJK / emoji are 2 cells).
//!
//! All helpers are pure and do not spawn Neovim. The RPC layer in
//! the native RPC adapter and the integration tests compare these results against the
//! real bundled Neovim (`strdisplaywidth`, cursor, grid).

use crate::contracts::{ContractError, Utf16Offset, Utf8ByteOffset};
use crate::domain::validation::{utf16_to_utf8, utf8_to_utf16};
use unicode_width::UnicodeWidthStr;

/// Byte offset of the start of every `\n`-split line. Line 0 always starts at 0.
pub fn line_starts(text: &str) -> Vec<usize> {
    let mut starts = vec![0];
    for (byte, ch) in text.char_indices() {
        if ch == '\n' {
            starts.push(byte + 1);
        }
    }
    starts
}

/// Split exactly the way `nvim_buf_get_lines` joins with `\n`.
pub fn split_lines(text: &str) -> Vec<&str> {
    if text.is_empty() {
        return vec![""];
    }
    text.split('\n').collect()
}

/// Join lines the way `nvim_buf_set_lines(0, -1)` round-trips.
pub fn join_lines(lines: &[String]) -> String {
    lines.join("\n")
}

/// Total UTF-16 code units in the whole document.
pub fn utf16_len(text: &str) -> u32 {
    u32::try_from(text.encode_utf16().count()).unwrap_or(u32::MAX)
}

/// Convert a global UTF-16 offset to 0-indexed `(row, byte_col_in_line)`.
///
/// Rejects surrogate-pair splits and out-of-bounds exactly like
/// [`utf16_to_utf8`], then locates the containing line.
pub fn global_utf16_to_line_byte(
    text: &str,
    offset: Utf16Offset,
) -> Result<(u32, u32), ContractError> {
    let global_byte = utf16_to_utf8(text, offset)?.0 as usize;
    let starts = line_starts(text);
    // Last start <= global_byte wins.
    let mut row = 0;
    for (index, start) in starts.iter().enumerate() {
        if *start <= global_byte {
            row = index;
        } else {
            break;
        }
    }
    let line_start = starts[row];
    let col = global_byte - line_start;
    Ok((
        u32::try_from(row).map_err(|_| ContractError::OffsetOutOfBounds)?,
        u32::try_from(col).map_err(|_| ContractError::OffsetOutOfBounds)?,
    ))
}

/// Inverse of [`global_utf16_to_line_byte`].
///
/// `byte_col` must be a UTF-8 char boundary inside the addressed line and must
/// not exceed the line length; otherwise `NotUtf8Boundary` / `OffsetOutOfBounds`
/// is returned so callers never split a scalar inside Neovim.
pub fn line_byte_to_global_utf16(
    text: &str,
    row: u32,
    byte_col: u32,
) -> Result<Utf16Offset, ContractError> {
    let starts = line_starts(text);
    let row_usize = row as usize;
    if row_usize >= starts.len() {
        return Err(ContractError::OffsetOutOfBounds);
    }
    let line_start = starts[row_usize];
    let line_end = if row_usize + 1 < starts.len() {
        // Exclude the `\n` itself.
        starts[row_usize + 1] - 1
    } else {
        text.len()
    };
    let col_usize = byte_col as usize;
    if col_usize > line_end - line_start {
        return Err(ContractError::OffsetOutOfBounds);
    }
    let global_byte = line_start + col_usize;
    if !text.is_char_boundary(global_byte) {
        return Err(ContractError::NotUtf8Boundary);
    }
    utf8_to_utf16(text, Utf8ByteOffset(global_byte as u32))
}

/// Display-cell width of a string using Unicode Standard Annex #11 rules.
///
/// Used for GUI display columns. The integration tests assert this matches real
/// Neovim `strdisplaywidth()` for ASCII, Japanese, emoji, and mixed text.
/// Combining marks contribute 0; CJK and most emoji contribute 2.
pub fn display_width(text: &str) -> usize {
    UnicodeWidthStr::width(text)
}

/// Display-cell width of one line up to (not including) a UTF-8 byte column.
pub fn line_display_prefix(line: &str, byte_col: usize) -> Result<usize, ContractError> {
    if byte_col > line.len() {
        return Err(ContractError::OffsetOutOfBounds);
    }
    if !line.is_char_boundary(byte_col) {
        return Err(ContractError::NotUtf8Boundary);
    }
    Ok(UnicodeWidthStr::width(&line[..byte_col]))
}

#[cfg(test)]
mod unit {
    use super::*;

    #[test]
    fn converts_global_offsets_to_neovim_positions() {
        // "a😀日本語\r\ne\u{301}" — same shape as the wire fixture.
        let text = "a😀日本語\r\ne\u{301}";
        // a=1 unit, 😀=2 units, 日 本 語 =3 units, \r=1, \n=1, e=1, combining=0? (U+0301 is 1 unit)
        assert_eq!(utf16_len(text), 10);
        assert_eq!(global_utf16_to_line_byte(text, Utf16Offset(0)), Ok((0, 0)));
        // After "a" (1 unit) -> byte 1, still line 0.
        assert_eq!(global_utf16_to_line_byte(text, Utf16Offset(1)), Ok((0, 1)));
        // After emoji (3 units) -> byte 5.
        assert_eq!(global_utf16_to_line_byte(text, Utf16Offset(3)), Ok((0, 5)));
        // After "\r\n" boundary: \n is at byte 18? "a"(1)+"😀"(4)+"日"(3)+"本"(3)+"語"(3)+"\r"(1)=15, "\n"=1 -> next line at 16? Let's trust bytes.
        let nl_byte = text.find('\n').unwrap();
        let nl_utf16 = utf8_to_utf16(text, Utf8ByteOffset(nl_byte as u32)).unwrap();
        // Start of second line is one past \n.
        let second_start_utf16 = utf8_to_utf16(text, Utf8ByteOffset((nl_byte + 1) as u32)).unwrap();
        assert_eq!(
            global_utf16_to_line_byte(text, second_start_utf16),
            Ok((1, 0))
        );
        // Round-trip every scalar boundary through line positions.
        for byte in (0..=text.len()).filter(|b| text.is_char_boundary(*b)) {
            let utf16 = utf8_to_utf16(text, Utf8ByteOffset(byte as u32)).unwrap();
            let (row, col) = global_utf16_to_line_byte(text, utf16).unwrap();
            assert_eq!(line_byte_to_global_utf16(text, row, col), Ok(utf16));
        }
        let _ = nl_utf16;
    }

    #[test]
    fn rejects_bad_positions() {
        let text = "a😀日本語";
        assert_eq!(
            global_utf16_to_line_byte(text, Utf16Offset(2)),
            Err(ContractError::SplitSurrogatePair)
        );
        assert_eq!(
            line_byte_to_global_utf16(text, 0, 2),
            Err(ContractError::NotUtf8Boundary)
        );
        assert_eq!(
            line_byte_to_global_utf16(text, 5, 0),
            Err(ContractError::OffsetOutOfBounds)
        );
    }

    #[test]
    fn measures_display_width() {
        assert_eq!(display_width("a"), 1);
        assert_eq!(display_width("日本語"), 6);
        assert_eq!(display_width("😀"), 2);
        assert_eq!(display_width("a😀日本語"), 9);
        assert_eq!(display_width("e\u{301}"), 1);
    }
}
