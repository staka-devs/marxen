//! User mapping helpers. User mappings always win over builtins.
//!
//! Marxen ships no default insert/normal mappings that shadow user keys. This
//! module only inspects (`nvim_get_keymap`) and applies user-supplied Lua
//! (`vim.keymap.set`). Priority is verified by integration tests: a user
//! `inoremap jj <Esc>` must appear in the keymap and must fire on
//! `nvim_input("jj")`, escaping Insert to Normal.

use crate::infrastructure::neovim::rpc::{EmbedClient, RpcError};
use rmpv::Value;

/// One entry of `nvim_get_keymap(mode)`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeymapEntry {
    pub lhs: String,
    pub rhs: Option<String>,
    pub buffer: bool,
}

fn value_to_string(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => text.as_str().map(str::to_owned),
        _ => None,
    }
}

/// List mappings for `mode` (`"n"`, `"i"`, `"v"`, ...).
pub fn list_keymaps(client: &EmbedClient, mode: &str) -> Result<Vec<KeymapEntry>, RpcError> {
    let result = client.call("nvim_get_keymap", vec![Value::from(mode)])?;
    let items = match result {
        Value::Array(items) => items,
        other => {
            return Err(RpcError::Invalid(format!(
                "nvim_get_keymap returned non-array: {other:?}"
            )))
        }
    };
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        let Value::Map(entries) = item else { continue };
        let mut lhs: Option<String> = None;
        let mut rhs: Option<String> = None;
        let mut buffer = false;
        for (key, val) in entries {
            match value_to_string(&key).as_deref() {
                Some("lhs") => lhs = value_to_string(&val),
                Some("rhs") => rhs = value_to_string(&val),
                Some("buffer") => {
                    buffer = matches!(val, Value::Integer(n) if n.as_u64() == Some(1))
                        || matches!(val, Value::Boolean(true))
                }
                _ => {}
            }
        }
        if let Some(lhs) = lhs {
            out.push(KeymapEntry { lhs, rhs, buffer });
        }
    }
    Ok(out)
}

/// Global and buffer mappings whose lhs starts with the typed Vim key.
/// Neovim termcodes normalize special keys without changing Unicode text.
pub fn has_mapping(client: &EmbedClient, mode: &str, lhs: &str) -> Result<bool, RpcError> {
    let value = client.call(
        "nvim_exec_lua",
        vec![
            Value::from(
                r#"
                local mode, lhs = ...
                local typed = vim.api.nvim_replace_termcodes(lhs, true, true, true)
                for _, mappings in ipairs({vim.api.nvim_get_keymap(mode), vim.api.nvim_buf_get_keymap(0, mode)}) do
                  for _, mapping in ipairs(mappings) do
                    local mapped = vim.api.nvim_replace_termcodes(mapping.lhs, true, true, true)
                    if mapped:sub(1, #typed) == typed then return true end
                  end
                end
                return false
                "#,
            ),
            Value::Array(vec![Value::from(mode), Value::from(lhs)]),
        ],
    )?;
    value
        .as_bool()
        .ok_or_else(|| RpcError::Invalid("mapping query returned non-boolean".into()))
}

/// Apply user Lua that registers mappings. Used by tests and the future
/// config loader; never installs competing defaults.
pub fn apply_user_lua(client: &EmbedClient, lua: &str) -> Result<Value, RpcError> {
    client.call(
        "nvim_exec_lua",
        vec![Value::from(lua), Value::Array(vec![])],
    )
}
