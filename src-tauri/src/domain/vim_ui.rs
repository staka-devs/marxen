//! Native command-line and message presentation reduced from Neovim UI events.
use crate::contracts::{ExReport, VimCommandLine, VimCompletion, VimCompletionItem};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Default)]
pub struct VimUi {
    lines: BTreeMap<u64, (String, String, usize)>,
    block: Vec<String>,
    popup: Option<(Vec<VimCompletionItem>, Option<u32>)>,
    search_armed: bool,
    wants_searchcount: bool,
    pending_ex: Option<String>,
    ex_report: Option<ExReport>,
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
                        if matches!(args[2].as_str(), Some("/" | "?")) {
                            self.search_armed = true;
                        }
                        // A new prompt supersedes any silent predecessor.
                        self.pending_ex = None;
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
                        let text = self.command_line().map(|line| line.text);
                        self.lines.remove(&args[0].as_u64().unwrap_or(1));
                        if let Some(text) = text {
                            if self.search_armed {
                                self.search_armed = false;
                                self.wants_searchcount = true;
                            }
                            if ex_report_command(&text).is_some() {
                                let mut command = text.trim().to_owned();
                                if command.len() > 200 {
                                    command.truncate(200);
                                }
                                self.pending_ex = Some(command);
                            }
                        }
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
                    "popupmenu_show" => {
                        let items = args[0]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .map(|item| VimCompletionItem {
                                word: item.get(0).and_then(Value::as_str).unwrap_or("").into(),
                                kind: item.get(1).and_then(Value::as_str).unwrap_or("").into(),
                                menu: item.get(2).and_then(Value::as_str).unwrap_or("").into(),
                            })
                            .collect();
                        let selected = args[1].as_i64().filter(|index| *index >= 0);
                        self.popup =
                            Some((items, selected.and_then(|index| u32::try_from(index).ok())));
                    }
                    "popupmenu_select" => {
                        if let Some((_, selected)) = self.popup.as_mut() {
                            let index = args[0].as_i64().filter(|index| *index >= 0);
                            *selected = index.and_then(|index| u32::try_from(index).ok());
                        }
                    }
                    "popupmenu_hide" => self.popup = None,
                    "msg_show" => {
                        let text = chunks(&args[1]);
                        if let Some(command) = self.pending_ex.take() {
                            if !text.is_empty() {
                                self.ex_report = Some(ExReport {
                                    command,
                                    text: text.clone(),
                                });
                            }
                        }
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

    /// Present the current completion popup, if Neovim is showing one.
    pub fn completion(&self) -> Option<VimCompletion> {
        let (items, selected) = self.popup.clone()?;
        Some(VimCompletion { items, selected })
    }

    /// Take one executed command report for the GUI search tab.
    pub fn take_ex_report(&mut self) -> Option<ExReport> {
        self.ex_report.take()
    }

    /// Consume a pending searchcount request from `/`, `?`, or `n`/`N` navigation.
    pub fn take_searchcount(&mut self) -> bool {
        std::mem::replace(&mut self.wants_searchcount, false)
    }

    /// Arm a one-shot searchcount read (e.g. after `n`/`N`/`*`/`#` navigation).
    pub fn arm_searchcount(&mut self) {
        self.wants_searchcount = true;
    }
}

/// Report whether a finished command line deserves a GUI search-tab entry.
///
/// Matches `:s`/`substitute` (with an Ex range prefix), `:g`/`:v` families,
/// `:vimgrep`, and `&`/`~` substitute repeats. Other commands keep only the
/// bottom message display.
fn ex_report_command(text: &str) -> Option<()> {
    let body = text.strip_prefix(':').unwrap_or(text).trim_start();
    let rest = body.trim_start_matches([
        '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', ' ', '\t', ',', '.', '$', '%', '*', '\'',
        '"', '<', '>', '+', '-', ';', '/', '?', '\\',
    ]);
    let word = |name: &str| {
        rest == name
            || rest
                .strip_prefix(name)
                .is_some_and(|tail| !tail.starts_with(|ch: char| ch.is_alphanumeric()))
    };
    if word("s") || word("substitute") || word("vimgrep") || word("global") || word("vglobal") {
        return Some(());
    }
    if let Some(head) = rest.chars().next() {
        if (head == 'g' || head == 'v' || head == '&' || head == '~')
            && rest[head.len_utf8()..]
                .chars()
                .next()
                .is_none_or(|ch| !ch.is_alphanumeric())
        {
            return Some(());
        }
    }
    None
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

    /// Keep Tab-completion candidates and selection from popupmenu events.
    #[test]
    fn native_completion_popup_events() {
        let mut ui = VimUi::default();
        assert!(ui.completion().is_none());
        ui.redraw(&json!([[
            "popupmenu_show",
            [[["blue", "", ""], ["darkblue", "", ""]], 0, 0, 0, 0]
        ]]));
        let popup = ui.completion().expect("popup visible");
        assert_eq!(popup.items.len(), 2);
        assert_eq!(popup.items[0].word, "blue");
        assert_eq!(popup.selected, Some(0));
        ui.redraw(&json!([["popupmenu_select", [1]]]));
        assert_eq!(ui.completion().expect("popup visible").selected, Some(1));
        ui.redraw(&json!([["popupmenu_hide", []]]));
        assert!(ui.completion().is_none());
        // A -1 selection means visible without a highlight.
        ui.redraw(&json!([[
            "popupmenu_show",
            [[["slate", "c", "[Color]"]], -1, 0, 0, 0]
        ]]));
        let popup = ui.completion().expect("popup visible");
        assert_eq!(popup.items[0].menu, "[Color]");
        assert_eq!(popup.selected, None);
    }

    /// Attribute execution reports to their own command, never a later message.
    #[test]
    fn ex_reports_stay_with_their_command() {
        let mut ui = VimUi::default();
        // Silent :s arms a report but emits no message.
        ui.redraw(&json!([[
            "cmdline_show",
            [[[0, "s/a/b/"]], 8, ":", "", 0, 1]
        ]]));
        ui.redraw(&json!([["cmdline_hide", [1]]]));
        // An unrelated :echo must not inherit the stale command.
        ui.redraw(&json!([[
            "cmdline_show",
            [[[0, "echo 'hi'"]], 9, ":", "", 0, 1]
        ]]));
        ui.redraw(&json!([["cmdline_hide", [1]]]));
        ui.redraw(&json!([["msg_show", ["", [[0, "hi"]], false]]]));
        assert!(ui.take_ex_report().is_none());
        // A reporting :%s keeps its own message.
        ui.redraw(&json!([[
            "cmdline_show",
            [[[0, "%s/a/b/"]], 8, ":", "", 0, 1]
        ]]));
        ui.redraw(&json!([["cmdline_hide", [1]]]));
        ui.redraw(&json!([[
            "msg_show",
            ["", [[0, "3 substitutions on 3 lines"]], false]
        ]]));
        let report = ui.take_ex_report().expect("substitute reported");
        assert_eq!(report.command, ":%s/a/b/");
        assert!(ui.take_ex_report().is_none());
        // Search input arms a one-shot searchcount read.
        ui.redraw(&json!([["cmdline_show", [[[0, "dog"]], 3, "/", "", 0, 1]]]));
        ui.redraw(&json!([["cmdline_hide", [1]]]));
        assert!(ui.take_searchcount());
        assert!(!ui.take_searchcount());
    }
}
