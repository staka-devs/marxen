//! Pure transcript-usage aggregation without filesystem or database access.
//!
//! Folding helpers for locally recorded session totals (Codex rollout JSONL,
//! Claude project JSONL, opencode SQLite rows). Cumulative rows fold by
//! maximum, per-message rows fold by saturating sum; absent counters stay
//! absent and are never zero-filled or estimated.
use crate::contracts::ai::*;
use serde_json::Value;

/// Largest session list returned for one transcript agent.
pub const MAX_TRANSCRIPT_SESSIONS_PER_AGENT: usize = 128;
/// Largest transcript file set inspected for one agent before stopping.
pub const MAX_TRANSCRIPT_FILES_PER_AGENT: usize = 512;
/// Largest JSONL transcript read for one session file.
pub const MAX_TRANSCRIPT_FILE_BYTES: u64 = 8_388_608;
/// Largest JSONL line count parsed for one session file.
pub const MAX_TRANSCRIPT_FILE_LINES: usize = 200_000;
/// Largest SQLite row set read from one transcript table.
pub const MAX_TRANSCRIPT_SQLITE_ROWS: usize = 512;
/// Largest display length of a transcript session identifier.
pub const MAX_TRANSCRIPT_SESSION_ID_CHARS: usize = 128;
/// Largest display length of a transcript model name.
pub const MAX_TRANSCRIPT_MODEL_CHARS: usize = 128;
/// Largest display length of a transcript session title.
pub const MAX_TRANSCRIPT_TITLE_CHARS: usize = 256;

/// Optionally reported counters folded across transcript rows.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TokenFold {
    /// Folded input tokens, or `None` when no row reported them.
    pub input: Option<u64>,
    /// Folded output tokens, or `None` when no row reported them.
    pub output: Option<u64>,
    /// Folded cache-read tokens, or `None` when no row reported them.
    pub cached_read: Option<u64>,
    /// Folded cache-write tokens, or `None` when no row reported them.
    pub cached_write: Option<u64>,
    /// Folded reasoning tokens, or `None` when no row reported them.
    pub reasoning: Option<u64>,
}

/// Fold one optionally reported counter by saturating sum.
/// `None` inputs leave the accumulator untouched so absent stays absent.
pub fn fold_sum(current: Option<u64>, addition: Option<u64>) -> Option<u64> {
    match (current, addition) {
        (Some(base), Some(extra)) => Some(base.saturating_add(extra)),
        (None, extra) => extra,
        (current, None) => current,
    }
}

/// Fold one cumulative counter by maximum.
/// Cumulative transcript rows restate running totals, so the largest
/// observation wins instead of summing every restatement.
pub fn fold_max(current: Option<u64>, candidate: Option<u64>) -> Option<u64> {
    match (current, candidate) {
        (Some(base), Some(extra)) => Some(base.max(extra)),
        (None, extra) => extra,
        (current, None) => current,
    }
}

/// Sum one optionally reported wire counter into the fold.
pub fn add_counter(fold: &mut TokenFold, field: TokenField, value: Option<u64>) {
    match field {
        TokenField::Input => fold.input = fold_sum(fold.input, value),
        TokenField::Output => fold.output = fold_sum(fold.output, value),
        TokenField::CachedRead => fold.cached_read = fold_sum(fold.cached_read, value),
        TokenField::CachedWrite => fold.cached_write = fold_sum(fold.cached_write, value),
        TokenField::Reasoning => fold.reasoning = fold_sum(fold.reasoning, value),
    }
}

/// Maximize one cumulative wire counter in the fold.
pub fn max_counter(fold: &mut TokenFold, field: TokenField, value: Option<u64>) {
    match field {
        TokenField::Input => fold.input = fold_max(fold.input, value),
        TokenField::Output => fold.output = fold_max(fold.output, value),
        TokenField::CachedRead => fold.cached_read = fold_max(fold.cached_read, value),
        TokenField::CachedWrite => fold.cached_write = fold_max(fold.cached_write, value),
        TokenField::Reasoning => fold.reasoning = fold_max(fold.reasoning, value),
    }
}

/// One named token counter shared by every transcript row shape.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenField {
    /// Prompt input tokens.
    Input,
    /// Generated output tokens.
    Output,
    /// Tokens served from cache.
    CachedRead,
    /// Tokens written to cache.
    CachedWrite,
    /// Reasoning tokens.
    Reasoning,
}

/// Render a folded accumulator as contract tokens.
/// Absent counters stay absent; no zero-filling happens here.
pub fn fold_to_tokens(fold: TokenFold) -> TranscriptTokens {
    TranscriptTokens {
        input_tokens: fold.input,
        output_tokens: fold.output,
        cached_read_tokens: fold.cached_read,
        cached_write_tokens: fold.cached_write,
        reasoning_tokens: fold.reasoning,
    }
}

/// Read one Codex `token_count` cumulative row into the fold by maximum.
/// `info` is the `payload.info` object carrying `total_token_usage`;
/// rows without it leave the fold untouched.
pub fn fold_codex_total_usage(fold: &mut TokenFold, info: &Value) {
    let usage = match info.get("total_token_usage") {
        Some(usage) => usage,
        None => return,
    };
    max_counter(fold, TokenField::Input, counter(usage.get("input_tokens")));
    max_counter(
        fold,
        TokenField::Output,
        counter(usage.get("output_tokens")),
    );
    max_counter(
        fold,
        TokenField::CachedRead,
        counter(usage.get("cached_input_tokens")),
    );
    max_counter(
        fold,
        TokenField::CachedWrite,
        counter(usage.get("cache_write_input_tokens")),
    );
    max_counter(
        fold,
        TokenField::Reasoning,
        counter(usage.get("reasoning_output_tokens")),
    );
}

/// Sum one Claude assistant `message.usage` object into the fold.
/// `cache_creation_input_tokens` counts tokens written to cache, so they
/// fold into the cache-write counter.
pub fn fold_claude_message_usage(fold: &mut TokenFold, usage: &Value) {
    add_counter(fold, TokenField::Input, counter(usage.get("input_tokens")));
    add_counter(
        fold,
        TokenField::Output,
        counter(usage.get("output_tokens")),
    );
    add_counter(
        fold,
        TokenField::CachedRead,
        counter(usage.get("cache_read_input_tokens")),
    );
    add_counter(
        fold,
        TokenField::CachedWrite,
        counter(usage.get("cache_creation_input_tokens")),
    );
}

/// Validate one SQLite integer counter as an exact non-negative value within
/// the JavaScript-safe range. Negative and out-of-range values yield `None`.
pub fn sqlite_counter(value: i64) -> Option<u64> {
    u64::try_from(value)
        .ok()
        .filter(|counter| *counter <= crate::domain::ai::JS_SAFE_INTEGER_MAX)
}

/// Validate one transcript JSON counter with the shared wire rule.
/// Non-integer, negative, and out-of-range values yield `None`.
pub fn counter(value: Option<&Value>) -> Option<u64> {
    value.and_then(crate::domain::ai::validate_token_counter)
}

/// Shorten a transcript session identifier to the display bound.
/// File stems and row IDs pass through unchanged when already short.
pub fn truncate_session_id(id: &str) -> String {
    id.chars().take(MAX_TRANSCRIPT_SESSION_ID_CHARS).collect()
}

/// Shorten an optional transcript model name to the display bound.
/// Empty names become absent instead of an empty label.
pub fn truncate_model(model: Option<&str>) -> Option<String> {
    model.and_then(|model| {
        let trimmed: String = model.chars().take(MAX_TRANSCRIPT_MODEL_CHARS).collect();
        (!trimmed.is_empty()).then_some(trimmed)
    })
}

/// Shorten an optional transcript title to the display bound.
/// Empty titles become absent instead of an empty label.
pub fn truncate_title(title: Option<&str>) -> Option<String> {
    title.and_then(|title| {
        let trimmed: String = title.chars().take(MAX_TRANSCRIPT_TITLE_CHARS).collect();
        (!trimmed.is_empty()).then_some(trimmed)
    })
}

/// Order sessions newest first for display, keeping undated rows last.
/// Ordering is a pure display concern and never invents timestamps.
pub fn sort_sessions_newest_first(sessions: &mut [TranscriptSession]) {
    sessions.sort_by(|left, right| match (left.updated_ms, right.updated_ms) {
        (Some(a), Some(b)) => b.cmp(&a),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    });
}
