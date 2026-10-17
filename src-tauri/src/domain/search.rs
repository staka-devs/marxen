//! Vim-native matching policy for workspace results and revision-bound replacement plans.
//!
//! Patterns translate to Vim regular expressions here; evaluation itself runs
//! inside embedded Neovim (`infrastructure::neovim::search`) so GUI search,
//! `:substitute`, and `/` share one engine. Byte ranges map back to UTF-16,
//! previews, and revision guards exactly as before.
use crate::contracts::{SearchOptions, Utf16Offset, Utf16Range, WorkspaceError};

pub const MAX_PATTERN_BYTES: usize = 4096;
pub const MAX_TEXT_BYTES: usize = 1024 * 1024;
pub const MAX_MATCHES: usize = 2000;

/// One Vim-native match with its substituted replacement text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VimHit {
    /// Byte range within the exact text that was sent to Neovim.
    pub start: usize,
    pub end: usize,
    /// Replacement expanded by Vim (`\1`, `&`, `~` behave natively).
    pub replacement: String,
}

/// Outcome of one buffer search: ordered hits with budget flags.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VimSearchOutcome {
    pub hits: Vec<VimHit>,
    pub truncated: bool,
    pub timed_out: bool,
}

/// Translate a GUI query plus options into one Vim regular expression.
///
/// Literal queries escape Vim magic characters; case handling arrives as an
/// explicit `\c`/`\C` prefix while the search session forces `ignorecase` off
/// so user options cannot leak in. Whole words use Vim boundary assertions
/// with `$` ordered first: `matchbufline()` rejects `$` directly before `\)`,
/// so `\%($\|\W\)` is required instead of `\%(\W\|$)`. Only emptiness and
/// size are rejected here; pattern validity is decided by Neovim itself.
pub fn translate_pattern(query: &str, options: &SearchOptions) -> Result<String, WorkspaceError> {
    if query.is_empty() || query.len() > MAX_PATTERN_BYTES {
        return Err(WorkspaceError::SearchPattern);
    }
    let pattern = if options.regex {
        query.to_owned()
    } else {
        let mut escaped = String::with_capacity(query.len());
        for scalar in query.chars() {
            if matches!(scalar, '\\' | '^' | '$' | '.' | '*' | '[' | ']' | '~') {
                escaped.push('\\');
            }
            escaped.push(scalar);
        }
        escaped
    };
    let flag = if options.case_sensitive { r"\C" } else { r"\c" };
    if options.whole_word {
        return Ok(format!(r"{flag}\%(^\|\W\)\zs\%({pattern}\)\ze\%($\|\W\)"));
    }
    Ok(format!("{flag}{pattern}"))
}

/// Forward-only position scan for the matcher's ascending, non-overlapping byte ranges.
pub struct MatchPositions {
    byte: usize,
    utf16: u32,
    line: u32,
    line_start: usize,
}

impl Default for MatchPositions {
    /// Initialize the first line and zero offsets for the forward-only scan.
    fn default() -> Self {
        Self {
            byte: 0,
            utf16: 0,
            line: 1,
            line_start: 0,
        }
    }
}

impl MatchPositions {
    /// Start one file's positions without building or retaining a general text index.
    pub fn new() -> Self {
        Self::default()
    }

    /// Advance once through unvisited scalars, preserving Unicode and LF line coordinates.
    fn advance(&mut self, text: &str, target: usize) {
        for (local, scalar) in text[self.byte..target].char_indices() {
            self.utf16 += scalar.len_utf16() as u32;
            if scalar == '\n' {
                self.line += 1;
                self.line_start = self.byte + local + 1;
            }
        }
        self.byte = target;
    }

    /// Convert the next authoritative match and return its starting line/context boundary.
    pub fn next(&mut self, text: &str, range: &std::ops::Range<usize>) -> (Utf16Range, u32, usize) {
        self.advance(text, range.start);
        let start = Utf16Offset(self.utf16);
        let line = self.line;
        let line_start = self.line_start;
        self.advance(text, range.end);
        (
            Utf16Range {
                start,
                end: Utf16Offset(self.utf16),
            },
            line,
            line_start,
        )
    }
}

/// Convert a bounded preview's byte range into relative UTF-16 code-unit offsets.
fn utf16_range(text: &str, range: &std::ops::Range<usize>) -> Utf16Range {
    Utf16Range {
        start: Utf16Offset(text[..range.start].encode_utf16().count() as u32),
        end: Utf16Offset(text[..range.end].encode_utf16().count() as u32),
    }
}

/// Build bounded first-line context and the visible portion of this specific match.
pub fn preview(
    text: &str,
    range: &std::ops::Range<usize>,
    line_start: usize,
) -> (String, Utf16Range) {
    let prefix: String = text[line_start..range.start]
        .chars()
        .rev()
        .take(80)
        .collect();
    let start = range.start - prefix.len();
    let end = text[start..]
        .char_indices()
        .take(240)
        .find(|(_, ch)| *ch == '\n')
        .map(|(i, _)| start + i)
        .unwrap_or_else(|| {
            text[start..]
                .char_indices()
                .nth(240)
                .map_or(text.len(), |(i, _)| start + i)
        });
    let span = utf16_range(
        &text[start..end],
        &(range.start - start..range.end.min(end) - start),
    );
    (text[start..end].to_owned(), span)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    /// Translate GUI queries to explicit Vim patterns without deciding validity.
    fn translated_patterns_carry_case_word_and_literal_modes() {
        let literal = SearchOptions {
            regex: false,
            ..SearchOptions::default()
        };
        assert_eq!(translate_pattern("a.c", &literal).as_deref(), Ok(r"\ca\.c"));
        let sensitive = SearchOptions {
            case_sensitive: true,
            regex: true,
            ..SearchOptions::default()
        };
        assert_eq!(
            translate_pattern(r"\vfoo|bar", &sensitive).as_deref(),
            Ok(r"\C\vfoo|bar")
        );
        assert!(translate_pattern("", &literal).is_err());
        assert!(translate_pattern(&"a".repeat(MAX_PATTERN_BYTES + 1), &literal).is_err());
        let word = SearchOptions {
            whole_word: true,
            ..SearchOptions::default()
        };
        assert_eq!(
            translate_pattern("cat", &word).as_deref(),
            Ok(r"\c\%(^\|\W\)\zs\%(cat\)\ze\%($\|\W\)")
        );
    }

    #[test]
    /// Scan non-overlapping supplementary, multiline and empty matches exactly once in order.
    fn incremental_match_positions() {
        let text = "😀cat\n日本\n𐐀";
        let mut positions = MatchPositions::new();
        for (bytes, utf16, line, line_start) in [
            (4..7, 2..5, 1, 0),
            (8..8, 6..6, 2, 8),
            (8..14, 6..8, 2, 8),
            (15..19, 9..11, 3, 15),
        ] {
            let (range, actual_line, actual_start) = positions.next(text, &bytes);
            assert_eq!(
                range,
                Utf16Range {
                    start: Utf16Offset(utf16.start),
                    end: Utf16Offset(utf16.end)
                }
            );
            assert_eq!((actual_line, actual_start), (line, line_start));
        }
    }
}
