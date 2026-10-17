//! Vim-native workspace matching evaluated by embedded Neovim.
//!
//! GUI search and replacement use Vim regular-expression semantics instead of
//! a parallel implementation: one `nvim_exec_lua` call matches a scratch
//! buffer with `matchbufline()` and expands replacements with `substitute()`.
//! Ranges map back to byte offsets of the exact text that was sent, so the
//! existing UTF-16 conversion, previews, and revision guards stay untouched.
use super::rpc::RpcError;
use super::NeovimSession;
use crate::contracts::WorkspaceError;
use crate::domain::search::{VimHit, VimSearchOutcome};
use rmpv::Value;
use std::sync::Mutex;

/// Cached isolated Neovim session dedicated to workspace matching.
///
/// Isolated configuration keeps user options (`ignorecase`, mappings,
/// autocmds) out of GUI search; case handling arrives as pattern prefixes.
pub struct NativeVimSearch {
    session: Mutex<Option<NeovimSession>>,
}

impl NativeVimSearch {
    /// Create the searcher without spawning; the session starts on first use.
    pub fn new() -> Self {
        Self {
            session: Mutex::new(None),
        }
    }

    /// Borrow the cached session, spawning an isolated one on first use.
    fn session(&self) -> Result<std::sync::MutexGuard<'_, Option<NeovimSession>>, WorkspaceError> {
        let mut guard = self.session.lock().map_err(|_| WorkspaceError::Neovim {
            detail: "search lock poisoned".into(),
        })?;
        if guard.is_none() {
            let session =
                NeovimSession::spawn_isolated().map_err(|cause| WorkspaceError::Neovim {
                    detail: format!("search session: {cause}"),
                })?;
            *guard = Some(session);
        }
        Ok(guard)
    }

    /// Match one text with Vim semantics and expand replacements natively.
    ///
    /// `pattern` is already translated (`translate_pattern`); `replacement`
    /// `None` skips substitution for display-only searches. Ranges reference
    /// `text` byte offsets; out-of-order or out-of-bounds hits are dropped.
    pub fn search_replace(
        &self,
        text: &str,
        pattern: &str,
        replacement: Option<&str>,
        max_hits: usize,
    ) -> Result<VimSearchOutcome, WorkspaceError> {
        const SCRIPT: &str = r#"
            local text, pattern, replacement, max_hits = ...
            vim.o.ignorecase = false
            vim.o.smartcase = false
            local lines = vim.split(text, '\n', { plain = true })
            local buf = vim.api.nvim_create_buf(false, true)
            vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
            local ok, matches = pcall(vim.fn.matchbufline, buf, pattern, 1, #lines)
            vim.api.nvim_buf_delete(buf, { force = true })
            if not ok then
                local bytes = {}
                for i = 1, math.min(#pattern, 60) do
                    bytes[#bytes + 1] = tostring(string.byte(pattern, i))
                end
                return { error = 'BYTES=[' .. table.concat(bytes, ',') .. '] ERR=' .. tostring(matches) }
            end
            local starts = {}
            local offset = 0
            for index, line in ipairs(lines) do
                starts[index] = offset
                offset = offset + #line + 1
            end
            local hits = {}
            local truncated = #matches > max_hits
            for index = 1, math.min(#matches, max_hits) do
                local item = matches[index]
                local s = starts[item.lnum] + item.byteidx
                local e = s + #item.text
                local rep = ''
                if replacement ~= nil and replacement ~= vim.NIL then
                    rep = vim.fn.substitute(text:sub(s + 1, e), pattern, replacement, '')
                end
                hits[#hits + 1] = { s, e, rep }
            end
            return { hits = hits, truncated = truncated }
        "#;
        let mut guard = self.session()?;
        let result = guard
            .as_ref()
            .ok_or_else(|| WorkspaceError::Neovim {
                detail: "search session missing".into(),
            })?
            .client()
            .call(
                "nvim_exec_lua",
                vec![
                    Value::from(SCRIPT),
                    Value::Array(vec![
                        Value::from(text),
                        Value::from(pattern),
                        replacement.map(Value::from).unwrap_or(Value::Nil),
                        Value::from(max_hits as u64),
                    ]),
                ],
            );
        let result = match result {
            Ok(value) => value,
            Err(RpcError::Timeout(_)) => {
                // Drop the wedged session so the next search respawns fresh.
                guard.take();
                return Ok(VimSearchOutcome {
                    hits: Vec::new(),
                    truncated: false,
                    timed_out: true,
                });
            }
            Err(cause) => {
                return Err(WorkspaceError::Neovim {
                    detail: format!("search: {cause}"),
                })
            }
        };
        parse_outcome(&result, text, max_hits)
    }
}

impl Default for NativeVimSearch {
    /// Create the searcher without spawning; the session starts on first use.
    fn default() -> Self {
        Self::new()
    }
}

impl crate::application::ports::VimSearch for NativeVimSearch {
    /// Match one text with Vim semantics through the cached isolated session.
    fn search_replace(
        &self,
        text: &str,
        pattern: &str,
        replacement: Option<&str>,
        max_hits: usize,
    ) -> Result<VimSearchOutcome, WorkspaceError> {
        self.search_replace(text, pattern, replacement, max_hits)
    }
}

/// Read one Lua result table into hits, dropping unusable entries.
fn parse_outcome(
    result: &Value,
    text: &str,
    max_hits: usize,
) -> Result<VimSearchOutcome, WorkspaceError> {
    let mut map = Vec::new();
    if let Value::Map(entries) = result {
        for (key, value) in entries {
            if let Some(name) = key.as_str() {
                map.push((name.to_owned(), value.clone()));
            }
        }
    }
    let get = |name: &str| {
        map.iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value)
    };
    if get("error").and_then(Value::as_str).is_some() {
        return Err(WorkspaceError::SearchPattern);
    }
    let mut hits: Vec<VimHit> = Vec::new();
    if let Some(Value::Array(items)) = get("hits") {
        for item in items {
            let Value::Array(triple) = item else { continue };
            let (Some(Value::Integer(s)), Some(Value::Integer(e)), Some(Value::String(rep))) =
                (triple.first(), triple.get(1), triple.get(2))
            else {
                continue;
            };
            let (Some(start), Some(end)) = (s.as_u64(), e.as_u64()) else {
                continue;
            };
            let (Ok(start), Ok(end)) = (usize::try_from(start), usize::try_from(end)) else {
                continue;
            };
            if start > end || end > text.len() || text.get(start..end).is_none() {
                continue;
            }
            if hits.len() >= max_hits {
                break;
            }
            if let Some(previous) = hits.last() {
                if start < previous.end {
                    continue;
                }
            }
            hits.push(VimHit {
                start,
                end,
                replacement: rep.as_str().unwrap_or("").into(),
            });
        }
    }
    let truncated = get("truncated").and_then(Value::as_bool).unwrap_or(false);
    Ok(VimSearchOutcome {
        hits,
        truncated,
        timed_out: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Match whole words through a real scratch buffer without GUI plumbing.
    #[test]
    fn whole_word_search_matches_natively() {
        let searcher = NativeVimSearch::new();
        let outcome = searcher
            .search_replace("scat cat\ndog", r"\ccat", None, 100)
            .unwrap();
        assert_eq!(outcome.hits.len(), 2);
        assert_eq!((outcome.hits[1].start, outcome.hits[1].end), (5, 8));
    }
}
