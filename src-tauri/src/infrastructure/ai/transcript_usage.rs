//! Read-only local transcript scanning for measured session totals.
//!
//! Inspects only the CLIs' default session stores below the user's home:
//! Codex rollout JSONL, Claude project JSONL, and the opencode SQLite
//! database. Copilot session events carry no token data and report that
//! honestly. Prompt text, credentials, and absolute live paths never leave
//! this module; only measured counters and bounded display labels do.
use crate::application::ai::transcript_usage::TranscriptUsageReader;
use crate::contracts::ai::*;
use crate::domain::transcript_usage::*;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// Largest directory entries visited while locating one agent's transcripts.
const MAX_WALK_ENTRIES: usize = 4096;
/// Largest recursion depth below a transcript root.
const MAX_WALK_DEPTH: usize = 8;

/// Resolve the user's home directory without consulting a shell.
/// Windows prefers `USERPROFILE`; other platforms use `HOME`.
/// Non-absolute results yield `None` so callers report a missing store.
fn home_dir() -> Option<PathBuf> {
    let key = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    let home = PathBuf::from(std::env::var_os(key)?);
    home.is_absolute().then_some(home)
}

/// Resolve the platform data directory for the opencode database.
/// An absolute `XDG_DATA_HOME` wins; otherwise the home-relative
/// `.local/share` fallback applies on every platform.
fn data_dir(home: &Path) -> PathBuf {
    if let Some(xdg) = std::env::var_os("XDG_DATA_HOME") {
        let candidate = PathBuf::from(xdg);
        if candidate.is_absolute() {
            return candidate;
        }
    }
    home.join(".local/share")
}

/// Read one file's modification time as Unix milliseconds.
/// Clock failures yield `None` instead of failing the owning scan.
fn mtime_ms(path: &Path) -> Option<u64> {
    let modified = fs::symlink_metadata(path).ok()?.modified().ok()?;
    modified
        .duration_since(SystemTime::UNIX_EPOCH)
        .ok()
        .map(|elapsed| elapsed.as_millis().min(u128::from(u64::MAX)) as u64)
}

/// Collect transcript files below `root` up to the walk budgets.
/// Symlinks are never followed; only regular files with a bounded depth
/// and the caller's filename predicate qualify.
fn collect_files(root: &Path, accept: &dyn Fn(&Path) -> bool) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    let mut visited = 0usize;
    while let Some((dir, depth)) = stack.pop() {
        if depth > MAX_WALK_DEPTH || visited >= MAX_WALK_ENTRIES {
            break;
        }
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for entry in entries {
            visited += 1;
            if visited > MAX_WALK_ENTRIES || out.len() >= MAX_TRANSCRIPT_FILES_PER_AGENT {
                break;
            }
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => continue,
            };
            let kind = match entry.file_type() {
                Ok(kind) => kind,
                Err(_) => continue,
            };
            if kind.is_symlink() {
                continue;
            }
            let path = entry.path();
            if kind.is_dir() {
                stack.push((path, depth + 1));
            } else if kind.is_file() && accept(&path) {
                out.push(path);
            }
        }
    }
    out.sort();
    out
}

/// Read at most the leading bounded bytes of one transcript file.
/// Oversized files contribute their prefix; missing files yield `None`.
fn read_capped(path: &Path) -> Option<String> {
    use std::io::Read;
    let file = fs::File::open(path).ok()?;
    let mut capped = file.take(MAX_TRANSCRIPT_FILE_BYTES + 1);
    let mut buf = Vec::new();
    capped.read_to_end(&mut buf).ok()?;
    if buf.len() as u64 > MAX_TRANSCRIPT_FILE_BYTES {
        buf.truncate(MAX_TRANSCRIPT_FILE_BYTES as usize);
    }
    String::from_utf8(buf).ok()
}

/// Accept Codex rollout transcripts, skipping compressed twins.
/// `.zst` files are never decompressed; only plain JSONL is scanned.
fn is_codex_rollout(path: &Path) -> bool {
    path.extension().and_then(|ext| ext.to_str()) == Some("jsonl")
        && path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("rollout-"))
}

/// Accept Claude project transcripts by JSONL extension.
fn is_claude_transcript(path: &Path) -> bool {
    path.extension().and_then(|ext| ext.to_str()) == Some("jsonl")
}

/// Scan one Codex rollout file for its cumulative token totals.
/// `token_count` rows restate running totals, so the per-file fold keeps
/// maxima; files without such rows contribute no session.
fn scan_codex_file(path: &Path) -> Option<TranscriptSession> {
    let text = read_capped(path)?;
    let mut fold = TokenFold::default();
    for (index, line) in text.lines().enumerate() {
        if index >= MAX_TRANSCRIPT_FILE_LINES {
            break;
        }
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let row: serde_json::Value = match serde_json::from_str(line) {
            Ok(row) => row,
            Err(_) => continue,
        };
        // `token_count` rows restate cumulative totals; only the payload
        // marker matters, never the envelope type.
        if row
            .pointer("/payload/type")
            .and_then(|kind| kind.as_str())
            != Some("token_count")
        {
            continue;
        }
        if let Some(info) = row.pointer("/payload/info") {
            fold_codex_total_usage(&mut fold, info);
        }
    }
    let tokens = fold_to_tokens(fold);
    if tokens.input_tokens.is_none()
        && tokens.output_tokens.is_none()
        && tokens.cached_read_tokens.is_none()
        && tokens.cached_write_tokens.is_none()
        && tokens.reasoning_tokens.is_none()
    {
        return None;
    }
    let stem = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("session");
    Some(TranscriptSession {
        session_id: truncate_session_id(stem),
        model: None,
        title: None,
        tokens,
        updated_ms: mtime_ms(path),
    })
}

/// Scan one Claude project file, summing per-message usage.
/// Assistant rows without a `message.usage` object are skipped; files
/// without any usage contribute no session.
fn scan_claude_file(path: &Path) -> Option<TranscriptSession> {
    let text = read_capped(path)?;
    let mut fold = TokenFold::default();
    for (index, line) in text.lines().enumerate() {
        if index >= MAX_TRANSCRIPT_FILE_LINES {
            break;
        }
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let row: serde_json::Value = match serde_json::from_str(line) {
            Ok(row) => row,
            Err(_) => continue,
        };
        if row.get("type").and_then(|kind| kind.as_str()) != Some("assistant") {
            continue;
        }
        if let Some(usage) = row.pointer("/message/usage") {
            fold_claude_message_usage(&mut fold, usage);
        }
    }
    let tokens = fold_to_tokens(fold);
    if tokens.input_tokens.is_none()
        && tokens.output_tokens.is_none()
        && tokens.cached_read_tokens.is_none()
        && tokens.cached_write_tokens.is_none()
        && tokens.reasoning_tokens.is_none()
    {
        return None;
    }
    let stem = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("session");
    Some(TranscriptSession {
        session_id: truncate_session_id(stem),
        model: None,
        title: None,
        tokens,
        updated_ms: mtime_ms(path),
    })
}

/// Normalize an opencode millisecond-or-second timestamp to milliseconds.
/// Millisecond values pass through; second values scale up; anything else
/// becomes absent instead of a dishonest date.
pub(crate) fn normalize_opencode_time(value: i64) -> Option<u64> {
    if (1_000_000_000..10_000_000_000).contains(&value) {
        return u64::try_from(value)
            .ok()?
            .checked_mul(1_000);
    }
    if (1_000_000_000_000..9_000_000_000_000_000).contains(&value) {
        return u64::try_from(value).ok();
    }
    None
}

/// Read measured session rows from one opencode table.
/// Unknown tables yield no rows; malformed rows are skipped individually.
fn read_opencode_table(
    connection: &rusqlite::Connection,
    table: &str,
) -> Vec<TranscriptSession> {
    if !matches!(table, "session" | "session_v2") {
        return Vec::new();
    }
    let sql = format!(
        "SELECT id, model, title, tokens_input, tokens_output, tokens_reasoning, \
         tokens_cache_read, tokens_cache_write, time_updated \
         FROM {table} ORDER BY time_updated DESC LIMIT {MAX_TRANSCRIPT_SQLITE_ROWS}"
    );
    let mut statement = match connection.prepare(&sql) {
        Ok(statement) => statement,
        Err(_) => return Vec::new(),
    };
    let rows = match statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, Option<String>>(1)?,
            row.get::<_, Option<String>>(2)?,
            row.get::<_, Option<i64>>(3)?,
            row.get::<_, Option<i64>>(4)?,
            row.get::<_, Option<i64>>(5)?,
            row.get::<_, Option<i64>>(6)?,
            row.get::<_, Option<i64>>(7)?,
            row.get::<_, Option<i64>>(8)?,
        ))
    }) {
        Ok(rows) => rows,
        Err(_) => return Vec::new(),
    };
    let mut out = Vec::new();
    for row in rows.flatten() {
        let (id, model, title, input, output, reasoning, cached_read, cached_write, updated) = row;
        let tokens = TranscriptTokens {
            input_tokens: input.and_then(sqlite_counter),
            output_tokens: output.and_then(sqlite_counter),
            cached_read_tokens: cached_read.and_then(sqlite_counter),
            cached_write_tokens: cached_write.and_then(sqlite_counter),
            reasoning_tokens: reasoning.and_then(sqlite_counter),
        };
        if tokens.input_tokens.is_none()
            && tokens.output_tokens.is_none()
            && tokens.cached_read_tokens.is_none()
            && tokens.cached_write_tokens.is_none()
            && tokens.reasoning_tokens.is_none()
        {
            continue;
        }
        out.push(TranscriptSession {
            session_id: truncate_session_id(&id),
            model: truncate_model(model.as_deref()),
            title: truncate_title(title.as_deref()),
            tokens,
            updated_ms: updated.and_then(normalize_opencode_time),
        });
    }
    out
}

/// Scan one opencode database file in read-only mode.
/// Both `session` and `session_v2` are read when present and merged by row
/// ID, keeping the newest write; the merged list arrives newest first.
pub(crate) fn scan_opencode_db(database: &Path) -> TranscriptAgentUsage {
    if !database.is_file() {
        return TranscriptAgentUsage {
            agent: TranscriptAgent::Opencode,
            sessions: Vec::new(),
            truncated: false,
            reason: Some(TranscriptUnavailableReason::StoreMissing),
            scanned_files: 0,
        };
    }
    let connection = match rusqlite::Connection::open_with_flags(
        &database,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    ) {
        Ok(connection) => connection,
        Err(_) => {
            return TranscriptAgentUsage {
                agent: TranscriptAgent::Opencode,
                sessions: Vec::new(),
                truncated: false,
                reason: Some(TranscriptUnavailableReason::ScanFailed),
                scanned_files: 0,
            };
        }
    };
    let mut merged: std::collections::BTreeMap<String, TranscriptSession> =
        std::collections::BTreeMap::new();
    let mut scanned_rows: u32 = 0;
    for table in ["session_v2", "session"] {
        let rows = read_opencode_table(&connection, table);
        scanned_rows = scanned_rows.saturating_add(rows.len() as u32);
        for session in rows {
            match merged.get(&session.session_id) {
                Some(known) if known.updated_ms.unwrap_or(0) >= session.updated_ms.unwrap_or(0) => {}
                _ => {
                    merged.insert(session.session_id.clone(), session);
                }
            }
        }
    }
    let mut sessions: Vec<TranscriptSession> = merged.into_values().collect();
    sort_sessions_newest_first(&mut sessions);
    let truncated = sessions.len() > MAX_TRANSCRIPT_SESSIONS_PER_AGENT;
    sessions.truncate(MAX_TRANSCRIPT_SESSIONS_PER_AGENT);
    let reason = sessions
        .is_empty()
        .then_some(TranscriptUnavailableReason::NoTokenData);
    TranscriptAgentUsage {
        agent: TranscriptAgent::Opencode,
        sessions,
        truncated,
        reason,
        scanned_files: scanned_rows,
    }
}

/// Scan the default opencode database below `home`.
fn scan_opencode(home: &Path) -> TranscriptAgentUsage {
    scan_opencode_db(&data_dir(home).join("opencode").join("opencode.db"))
}

/// Scan one JSONL transcript agent below its store root.
/// Missing roots report `StoreMissing`; files without measured totals
/// contribute nothing but still count as scanned.
fn scan_jsonl_agent(
    agent: TranscriptAgent,
    root: &Path,
    accept: &dyn Fn(&Path) -> bool,
    scan: &dyn Fn(&Path) -> Option<TranscriptSession>,
) -> TranscriptAgentUsage {
    if !root.is_dir() {
        return TranscriptAgentUsage {
            agent,
            sessions: Vec::new(),
            truncated: false,
            reason: Some(TranscriptUnavailableReason::StoreMissing),
            scanned_files: 0,
        };
    }
    let files = collect_files(root, accept);
    let scanned_files = files.len().min(u32::MAX as usize) as u32;
    let mut sessions: Vec<TranscriptSession> = files.iter().filter_map(|path| scan(path)).collect();
    sort_sessions_newest_first(&mut sessions);
    let truncated = sessions.len() > MAX_TRANSCRIPT_SESSIONS_PER_AGENT;
    sessions.truncate(MAX_TRANSCRIPT_SESSIONS_PER_AGENT);
    let reason = sessions
        .is_empty()
        .then_some(TranscriptUnavailableReason::NoTokenData);
    TranscriptAgentUsage {
        agent,
        sessions,
        truncated,
        reason,
        scanned_files,
    }
}

/// Inspect every known local transcript store below `home`.
/// Copilot session events carry no token data, so a present store still
/// reports `NoTokenData` instead of invented totals.
pub fn scan_transcript_stores(home: &Path) -> Vec<TranscriptAgentUsage> {
    let codex = scan_jsonl_agent(
        TranscriptAgent::Codex,
        &home.join(".codex").join("sessions"),
        &is_codex_rollout,
        &scan_codex_file,
    );
    let claude = scan_jsonl_agent(
        TranscriptAgent::Claude,
        &home.join(".claude").join("projects"),
        &is_claude_transcript,
        &scan_claude_file,
    );
    let opencode = scan_opencode(home);
    let copilot_root = {
        let base = std::env::var_os("COPILOT_HOME")
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
            .unwrap_or_else(|| home.join(".copilot"));
        base.join("session-state")
    };
    let copilot = if copilot_root.is_dir() {
        TranscriptAgentUsage {
            agent: TranscriptAgent::Copilot,
            sessions: Vec::new(),
            truncated: false,
            reason: Some(TranscriptUnavailableReason::NoTokenData),
            scanned_files: 0,
        }
    } else {
        TranscriptAgentUsage {
            agent: TranscriptAgent::Copilot,
            sessions: Vec::new(),
            truncated: false,
            reason: Some(TranscriptUnavailableReason::StoreMissing),
            scanned_files: 0,
        }
    };
    vec![codex, claude, opencode, copilot]
}

/// Scan the current user's local transcript stores.
/// An unresolvable home reports every agent as store-missing.
pub fn read_transcript_usage() -> Vec<TranscriptAgentUsage> {
    NativeTranscriptUsageReader.read_agents()
}

/// Read default local transcript stores through the application port.
pub struct NativeTranscriptUsageReader;

impl TranscriptUsageReader for NativeTranscriptUsageReader {
    /// Scan the current user's local transcript stores without network or inference.
    fn read_agents(&self) -> Vec<TranscriptAgentUsage> {
        match home_dir() {
            Some(home) => scan_transcript_stores(&home),
            None => missing_home_report(),
        }
    }
}

/// Report every known agent as store-missing when no home resolves.
fn missing_home_report() -> Vec<TranscriptAgentUsage> {
    [
        TranscriptAgent::Codex,
        TranscriptAgent::Claude,
        TranscriptAgent::Opencode,
        TranscriptAgent::Copilot,
    ]
    .into_iter()
    .map(|agent| TranscriptAgentUsage {
        agent,
        sessions: Vec::new(),
        truncated: false,
        reason: Some(TranscriptUnavailableReason::StoreMissing),
        scanned_files: 0,
    })
    .collect()
}
