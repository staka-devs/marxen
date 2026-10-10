//! Neovim `nvim_get_mode()` <-> [`crate::contracts::VimMode`] mapping.
//!
//! Neovim reports short mode codes (`n`, `i`, `V`, `\x16`, `c`, `t`, ...).
//! This module is the single place that interprets them so the actor, IPC,
//! and tests agree. Select modes (`s`/`S`/`^S`) map to the closest visual
//! variant because the v1 contract has no dedicated select state.

use crate::contracts::VimMode;
use crate::infrastructure::neovim::rpc::RpcError;
use rmpv::Value;

/// Interpret one `nvim_get_mode()` response value (map with `mode` key).
/// Live sessions attach an embedded UI before using this fast API.
pub fn parse_mode(value: &Value) -> Result<VimMode, RpcError> {
    let map = match value {
        Value::Map(entries) => entries,
        other => {
            return Err(RpcError::Invalid(format!(
                "nvim_get_mode returned non-map: {other:?}"
            )))
        }
    };
    let mut short: Option<String> = None;
    for (key, val) in map {
        let is_mode = matches!(key, Value::String(text) if text.as_str() == Some("mode"));
        if is_mode {
            short = match val {
                Value::String(text) => text.as_str().map(str::to_owned),
                _ => None,
            };
        }
    }
    let Some(short) = short else {
        return Err(RpcError::Invalid(format!(
            "nvim_get_mode map lacks mode: {value:?}"
        )));
    };
    short_to_mode(&short)
        .ok_or_else(|| RpcError::Invalid(format!("unknown Neovim mode: {short:?}")))
}

/// Interpret a short `mode()` string (`n`, `i`, `V`, `\x16`, `c`, `t`, ...).
/// Also used to interpret short codes in redraw notifications.
pub fn from_short(short: &str) -> Result<VimMode, RpcError> {
    // Control-V arrives as "\u{16}".
    short_to_mode(short).ok_or_else(|| RpcError::Invalid(format!("unknown Neovim mode: {short:?}")))
}

/// Read the boolean `blocking` field from a mode response, rejecting missing,
/// non-boolean, or non-map values as protocol errors.
pub fn parse_blocking(value: &Value) -> Result<bool, RpcError> {
    value
        .as_map()
        .and_then(|entries| {
            entries
                .iter()
                .find(|(key, _)| key.as_str() == Some("blocking"))
                .and_then(|(_, value)| value.as_bool())
        })
        .ok_or_else(|| RpcError::Invalid("nvim_get_mode lacks boolean blocking".into()))
}

/// Map the leading native mode code to the nearest contract mode, folding select
/// modes into visual modes; empty or unrecognized codes yield `None`.
fn short_to_mode(short: &str) -> Option<VimMode> {
    if short == "\u{16}" || short == "\u{16}s" {
        return Some(VimMode::VisualBlock);
    }
    let first = short.chars().next()?;
    match first {
        'n' => Some(VimMode::Normal),
        'i' => Some(VimMode::Insert),
        'R' => Some(VimMode::Replace),
        'v' => Some(VimMode::Visual),
        'V' => Some(VimMode::VisualLine),
        's' => Some(VimMode::Visual),
        'S' => Some(VimMode::VisualLine),
        'c' | 'r' | '!' => Some(VimMode::CommandLine),
        't' => Some(VimMode::Terminal),
        '\u{16}' => Some(VimMode::VisualBlock),
        _ => None,
    }
}

#[cfg(test)]
mod unit {
    use super::*;
    use rmpv::Value;

    /// Build a native-mode response fixture with the supplied code and nonblocking input.
    fn mode_map(short: &str) -> Value {
        Value::Map(vec![
            (Value::from("mode"), Value::from(short)),
            (Value::from("blocking"), Value::from(false)),
        ])
    }

    /// Cover normal/insert submodes, replace, visual variants, command line,
    /// terminal mode, and `nt` remaining normal inside a terminal buffer.
    #[test]
    fn maps_common_modes() {
        for (short, expected) in [
            ("n", VimMode::Normal),
            ("no", VimMode::Normal),
            ("niI", VimMode::Normal),
            ("i", VimMode::Insert),
            ("ic", VimMode::Insert),
            ("R", VimMode::Replace),
            ("v", VimMode::Visual),
            ("V", VimMode::VisualLine),
            ("c", VimMode::CommandLine),
            ("t", VimMode::Terminal),
            ("nt", VimMode::Normal),
        ] {
            // `nt` starts with n (normal in terminal buffer); contract keeps it Normal.
            assert_eq!(parse_mode(&mode_map(short)), Ok(expected), "{short}");
        }
        assert_eq!(parse_mode(&mode_map("\u{16}")), Ok(VimMode::VisualBlock));
    }
}
