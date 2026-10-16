//! Native command-line and message presentation reduced from Neovim UI events.
use crate::contracts::VimCommandLine;
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Default)]
pub struct VimUi {
    lines: BTreeMap<u64, (String, String, usize)>,
    block: Vec<String>,
    pub message: Option<String>,
}

/// Join Neovim's highlighted chunks without changing whitespace.
fn chunks(value: &Value) -> String {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|chunk| chunk.get(1).and_then(Value::as_str))
        .collect()
}

impl VimUi {
    /// Consume redraw events in order, retaining nested prompts and function definitions.
    pub fn redraw(&mut self, updates: &Value) {
        for update in updates.as_array().into_iter().flatten() {
            let Some(event) = update.get(0).and_then(Value::as_str) else {
                continue;
            };
            for args in update.as_array().into_iter().flatten().skip(1) {
                match event {
                    "cmdline_show" => {
                        let prefix = format!(
                            "{}{}{}",
                            args[2].as_str().unwrap_or(""),
                            args[3].as_str().unwrap_or(""),
                            " ".repeat(args[4].as_u64().unwrap_or(0).min(500) as usize)
                        );
                        self.lines.insert(
                            args[5].as_u64().unwrap_or(1),
                            (
                                prefix,
                                chunks(&args[0]),
                                args[1].as_u64().unwrap_or(0) as usize,
                            ),
                        );
                    }
                    "cmdline_pos" => {
                        if let Some(line) = self.lines.get_mut(&args[1].as_u64().unwrap_or(1)) {
                            line.2 = args[0].as_u64().unwrap_or(0) as usize;
                        }
                    }
                    "cmdline_hide" => {
                        self.lines.remove(&args[0].as_u64().unwrap_or(1));
                    }
                    "cmdline_block_show" => {
                        self.block = args[0]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .map(chunks)
                            .collect();
                    }
                    "cmdline_block_append" => self.block.push(chunks(&args[0])),
                    "cmdline_block_hide" => self.block.clear(),
                    "msg_show" => {
                        let text = chunks(&args[1]);
                        self.message = if text.is_empty() { None } else { Some(text) };
                    }
                    "msg_clear" => self.message = None,
                    _ => {}
                }
            }
        }
    }

    /// Present the innermost prompt with a UTF-16 cursor for browser text slicing.
    pub fn command_line(&self) -> Option<VimCommandLine> {
        let (_, (prefix, content, position)) = self.lines.last_key_value()?;
        let block = if self.block.is_empty() {
            String::new()
        } else {
            format!("{}\n", self.block.join("\n"))
        };
        let before = content
            .char_indices()
            .take_while(|(byte, _)| byte < position)
            .map(|(_, c)| c.len_utf16())
            .sum::<usize>();
        Some(VimCommandLine {
            cursor: (block.encode_utf16().count() + prefix.encode_utf16().count() + before) as u32,
            text: format!("{block}{prefix}{content}"),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Keep command text, Unicode cursor, nesting, function blocks and Ex errors native.
    #[test]
    fn native_prompt_events() {
        let mut ui = VimUi::default();
        ui.redraw(&json!([[
            "cmdline_show",
            [[[0, "a😀b"]], 5, ":", "", 0, 1]
        ]]));
        assert_eq!(
            ui.command_line(),
            Some(VimCommandLine {
                text: ":a😀b".into(),
                cursor: 4
            })
        );
        ui.redraw(&json!([
            ["cmdline_show", [[[0, "nested"]], 2, "=", "", 0, 2]],
            ["cmdline_hide", [2]]
        ]));
        assert_eq!(ui.command_line().unwrap().text, ":a😀b");
        ui.redraw(&json!([
            ["cmdline_block_show", [[[[0, "function Test()"]]]]],
            ["cmdline_pos", [1, 1]],
            ["msg_show", ["emsg", [[0, "E492: unknown command"]], false]]
        ]));
        assert!(ui
            .command_line()
            .unwrap()
            .text
            .starts_with("function Test()\n:"));
        assert_eq!(ui.message.as_deref(), Some("E492: unknown command"));
        ui.redraw(&json!([
            ["cmdline_hide", [1]],
            ["cmdline_block_hide", []],
            ["msg_clear", []]
        ]));
        assert!(ui.command_line().is_none());
        assert!(ui.message.is_none());
    }
}
