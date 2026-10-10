//! Neovim `nvim_get_mode()` <-> [`crate::contracts::VimMode`] mapping.
//!
//! Neovim reports short mode codes (`n`, `i`, `V`, `\x16`, `c`, `t`, ...).
//! This module is the single place that interprets them so the actor, IPC,
//! and tests agree. Select modes (`s`/`S`/`^S`) map to the closest visual
//! variant because the v1 contract has no dedicated select state.

use crate::contracts::VimMode;
use crate::neovim::rpc::RpcError;
use rmpv::Value;

/// Interpret one `nvim_get_mode()` response value (map with `mode` key).
/// Kept for completeness; live sessions use [`fetch_via_eval`] because
/// `nvim_get_mode` does not answer on this project's headless embed channel
/// (verified: `nvim_get_current_buf` / `nvim_eval("mode()")` answer, the map
/// call times out even in Normal with no UI attached).
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
/// Live sessions fetch this via `nvim_call_function("mode")`; see [`parse_mode`].
pub fn from_short(short: &str) -> Result<VimMode, RpcError> {
    // Control-V arrives as "\u{16}".
    short_to_mode(short).ok_or_else(|| RpcError::Invalid(format!("unknown Neovim mode: {short:?}")))
}

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
        's' | 'S' => Some(VimMode::Visual),
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

    fn mode_map(short: &str) -> Value {
        Value::Map(vec![
            (Value::from("mode"), Value::from(short)),
            (Value::from("blocking"), Value::from(false)),
        ])
    }

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
