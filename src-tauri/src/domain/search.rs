//! One native matching policy for workspace results and revision-bound replacement plans.
use crate::contracts::{SearchLimit, SearchOptions, Utf16Offset, Utf16Range, WorkspaceError};
use regex::{Regex, RegexBuilder};

pub const MAX_PATTERN_BYTES: usize = 4096;
pub const MAX_TEXT_BYTES: usize = 1024 * 1024;
pub const MAX_MATCHES: usize = 2000;
const MAX_CANDIDATES: usize = 10_000;

/// Compiled Unicode matcher, with context-based whole-word filtering.
pub struct Matcher {
    regex: Regex,
    word: Regex,
    whole_word: bool,
}

/// Bounded non-overlapping authoritative byte ranges and an explicit incomplete reason.
pub struct Matches {
    pub ranges: Vec<std::ops::Range<usize>>,
    pub limit: Option<SearchLimit>,
}

impl Matcher {
    /// Compile literal or Rust regex syntax with bounded parser depth and automaton size.
    pub fn compile(query: &str, options: &SearchOptions) -> Result<Self, WorkspaceError> {
        if query.is_empty() || query.len() > MAX_PATTERN_BYTES {
            return Err(WorkspaceError::SearchPattern);
        }
        let pattern = if options.regex {
            query.to_owned()
        } else {
            regex::escape(query)
        };
        let regex = RegexBuilder::new(&pattern)
            .case_insensitive(!options.case_sensitive)
            .multi_line(true)
            .unicode(true)
            .nest_limit(64)
            .size_limit(1024 * 1024)
            .dfa_size_limit(1024 * 1024)
            .build()
            .map_err(|_| WorkspaceError::SearchPattern)?;
        Ok(Self {
            regex,
            word: Regex::new(r"\A\w\z").map_err(|_| WorkspaceError::SearchPattern)?,
            whole_word: options.whole_word,
        })
    }

    /// Test one Unicode scalar using the same Unicode word class as the native regex.
    fn is_word(&self, scalar: Option<char>) -> bool {
        scalar.is_some_and(|ch| self.word.is_match(ch.encode_utf8(&mut [0; 4])))
    }

    /// Search bounded input, counting accepted matches after whole-word filtering.
    pub fn find(&self, text: &str, maximum: usize) -> Matches {
        if text.len() > MAX_TEXT_BYTES {
            return Matches {
                ranges: vec![],
                limit: Some(SearchLimit::FileBytes),
            };
        }
        let mut ranges = Vec::new();
        for (candidate, found) in self.regex.find_iter(text).enumerate() {
            if candidate >= MAX_CANDIDATES {
                return Matches {
                    ranges,
                    limit: Some(SearchLimit::Candidates),
                };
            }
            if self.whole_word
                && (self.is_word(text[..found.start()].chars().next_back())
                    || self.is_word(text[found.end()..].chars().next()))
            {
                continue;
            }
            if ranges.len() >= maximum {
                return Matches {
                    ranges,
                    limit: Some(SearchLimit::Matches),
                };
            }
            ranges.push(found.range());
        }
        Matches {
            ranges,
            limit: None,
        }
    }
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

    /// Build one expected range without confusing it with a vector of its member offsets.
    fn one_range(range: std::ops::Range<usize>) -> Vec<std::ops::Range<usize>> {
        std::iter::once(range).collect()
    }

    #[test]
    /// Match greedy continuations, alternations, line anchors, escapes and Unicode natively.
    fn maintained_matching_fixtures() {
        let options = SearchOptions {
            regex: true,
            ..SearchOptions::default()
        };
        for (pattern, text, expected) in [
            ("a+a", "aaa", one_range(0..3)),
            ("(a|ab)c", "abc", one_range(0..3)),
            ("a.c", "ac abc", one_range(3..6)),
            ("^foo$", "x\nfoo\n", one_range(2..5)),
            (r"\x61", "a", one_range(0..1)),
            (r"\w+", "😀𐐀_日本", one_range(4..15)),
            (r"\d", "𝟚", one_range(0..4)),
            ("σ", "ς Σ σ", vec![0..2, 3..5, 6..8]),
            ("a.b", "a\rb", one_range(0..3)),
        ] {
            let found = Matcher::compile(pattern, &options)
                .unwrap()
                .find(text, MAX_MATCHES);
            assert_eq!(found.ranges, expected, "{pattern:?} on {text:?}");
            assert_eq!(found.limit, None);
        }
        let sensitive = SearchOptions {
            case_sensitive: true,
            ..options
        };
        assert!(Matcher::compile("σ", &sensitive)
            .unwrap()
            .find("ς", MAX_MATCHES)
            .ranges
            .is_empty());
    }

    #[test]
    /// Filter by adjacent Unicode word scalars before counting the accepted match limit.
    fn unicode_whole_word_and_filtering() {
        let options = SearchOptions {
            whole_word: true,
            ..SearchOptions::default()
        };
        assert_eq!(
            Matcher::compile("日本", &options)
                .unwrap()
                .find("日本 語", MAX_MATCHES)
                .ranges,
            vec![0..6]
        );
        assert_eq!(
            Matcher::compile("+", &options)
                .unwrap()
                .find("+", MAX_MATCHES)
                .ranges,
            vec![0..1]
        );
        assert!(Matcher::compile("日本", &options)
            .unwrap()
            .find("𐐀日本", MAX_MATCHES)
            .ranges
            .is_empty());
        let text = format!("{}cat", "scat ".repeat(2000));
        let found = Matcher::compile("cat", &options)
            .unwrap()
            .find(&text, MAX_MATCHES);
        assert_eq!(found.ranges, vec![10000..10003]);
        assert_eq!(found.limit, None);
    }

    #[test]
    /// Reject unsupported and budgeted patterns explicitly and bound pathological inputs.
    fn invalid_and_budgeted_patterns() {
        let options = SearchOptions {
            regex: true,
            ..SearchOptions::default()
        };
        for pattern in ["[", "(?=a)", r"(a)\1", "a{1000000}"] {
            assert!(Matcher::compile(pattern, &options).is_err(), "{pattern}");
        }
        assert!(Matcher::compile(&"a".repeat(MAX_PATTERN_BYTES + 1), &options).is_err());
        assert!(
            Matcher::compile(&format!("{}a{}", "(".repeat(65), ")".repeat(65)), &options).is_err()
        );
        let failing = format!("{}!", "a".repeat(20000));
        assert!(Matcher::compile("^(a+)+$", &options)
            .unwrap()
            .find(&failing, MAX_MATCHES)
            .ranges
            .is_empty());
        let matcher = Matcher::compile("a", &options).unwrap();
        assert_eq!(matcher.find("aa", 1).limit, Some(SearchLimit::Matches));
        assert_eq!(matcher.find("a", 1).limit, None);
        assert_eq!(
            matcher
                .find(&"a".repeat(MAX_TEXT_BYTES + 1), MAX_MATCHES)
                .limit,
            Some(SearchLimit::FileBytes)
        );
        let word = SearchOptions {
            whole_word: true,
            ..SearchOptions::default()
        };
        assert_eq!(
            Matcher::compile("a", &word)
                .unwrap()
                .find(&"ba ".repeat(10001), MAX_MATCHES)
                .limit,
            Some(SearchLimit::Candidates)
        );
    }

    #[test]
    /// Preserve UTF-16 coordinates and highlight only this match's visible native portion.
    fn utf16_preview_and_empty_matches() {
        let text = "😀日本\n語";
        assert_eq!(
            utf16_range(text, &(4..10)),
            Utf16Range {
                start: Utf16Offset(2),
                end: Utf16Offset(4)
            }
        );
        let (context, span) = preview(text, &(4..14), 0);
        assert_eq!(context, "😀日本");
        assert_eq!(
            span,
            Utf16Range {
                start: Utf16Offset(2),
                end: Utf16Offset(4)
            }
        );
        let found = Matcher::compile(
            "^",
            &SearchOptions {
                regex: true,
                ..SearchOptions::default()
            },
        )
        .unwrap()
        .find("x\ny", MAX_MATCHES);
        assert_eq!(found.ranges, vec![0..0, 2..2]);
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
