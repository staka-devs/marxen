//! User mapping helpers. User mappings always win over builtins.
//!
//! Marxen ships no default insert/normal mappings that shadow user keys. This
//! module only inspects (`nvim_get_keymap`) and applies user-supplied Lua
//! (`vim.keymap.set`). Priority is verified by integration tests: a user
//! `inoremap jj <Esc>` must appear in the keymap and must fire on
//! `nvim_input("jj")`, escaping Insert to Normal.

use crate::neovim::rpc::{EmbedClient, RpcError};
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

/// True when a user mapping for `lhs` exists in `mode`.
pub fn has_mapping(client: &EmbedClient, mode: &str, lhs: &str) -> Result<bool, RpcError> {
    Ok(list_keymaps(client, mode)?
        .iter()
        .any(|entry| entry.lhs == lhs))
}

/// Apply user Lua that registers mappings. Used by tests and the future
/// config loader; never installs competing defaults.
pub fn apply_user_lua(client: &EmbedClient, lua: &str) -> Result<Value, RpcError> {
    client.call(
        "nvim_exec_lua",
        vec![Value::from(lua), Value::Array(vec![])],
    )
}
