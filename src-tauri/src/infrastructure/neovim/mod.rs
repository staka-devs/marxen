//! Bundled Neovim resolution and the authoritative buffer session.
//!
//! [`NeovimSession`] spawns the real `src-tauri/resources/neovim` binary with
//! `--embed`, keeps its buffer as the document source of truth, and exposes
//! the RPC surface the document actor needs: lines/text range edits, modes,
//! keymaps, display widths, cursor, undo, `:w` interception, UI grid, and
//! buffer notifications. Pure position math lives in [`crate::domain::coordinates`].

pub mod buffer;
pub mod config;
pub mod grid;
pub mod mapping;
pub mod mode;
pub mod rpc;
pub mod search;

use crate::domain::coordinates::{join_lines, split_lines};
use config::{argv_for, collect_errors, describe_source, ConfigReport, ConfigSource};
use rpc::{EmbedClient, RpcError};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

static RESOURCE_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Configure the installed Tauri resource directory before opening documents.
/// Only the first call takes effect because the directory is stored in a `OnceLock`.
pub fn configure_resource_dir(directory: PathBuf) {
    let _ = RESOURCE_DIR.set(directory);
}

pub use crate::domain::coordinates::{
    display_width, global_utf16_to_line_byte, line_byte_to_global_utf16,
};

/// Resolved bundled binary, runtime, and manifest target.
#[derive(Debug, Clone)]
pub struct BundlePaths {
    pub exe: PathBuf,
    pub runtime: PathBuf,
    pub manifest_target: String,
}

/// Resolve installed resources first. Source-tree resources are for dev/tests.
pub fn bundle_paths() -> Result<BundlePaths, String> {
    if let Some(directory) = RESOURCE_DIR.get() {
        let installed = directory.join("neovim");
        if installed.is_dir() || !cfg!(debug_assertions) {
            return bundle_paths_at(&installed);
        }
    }
    if cfg!(debug_assertions) || !cfg!(feature = "desktop") {
        return bundle_paths_at(
            &PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/neovim"),
        );
    }
    Err("Neovim のアプリ配布資源ディレクトリが設定されていません".into())
}

/// Require the platform binary, runtime directory, and a readable JSON manifest
/// with a nonempty target string under this bundle root; return localized diagnostics on failure.
fn bundle_paths_at(root: &Path) -> Result<BundlePaths, String> {
    let exe = root.join(if cfg!(windows) {
        "bin/nvim.exe"
    } else {
        "bin/nvim"
    });
    let runtime = root.join("share/nvim/runtime");
    if !exe.is_file() || !runtime.is_dir() {
        return Err(format!(
            "Neovim の実行ファイルまたは runtime が見つかりません: {}",
            root.display()
        ));
    }
    let metadata: serde_json::Value = serde_json::from_slice(
        &std::fs::read(root.join("marxen-bundle.json"))
            .map_err(|cause| format!("Neovim の配布情報を読み込めません: {cause}"))?,
    )
    .map_err(|cause| format!("Neovim の配布情報が不正です: {cause}"))?;
    let manifest_target = metadata
        .get("target")
        .and_then(serde_json::Value::as_str)
        .filter(|target| !target.is_empty())
        .ok_or_else(|| "Neovim の配布情報に target がありません".to_owned())?
        .to_owned();
    Ok(BundlePaths {
        exe,
        runtime,
        manifest_target,
    })
}

/// Authoritative embedded-Neovim buffer session.
pub struct NeovimSession {
    client: EmbedClient,
    buf: rmpv::Value,
    config: ConfigReport,
}

impl NeovimSession {
    /// Open the bundled embedded Neovim without reading user init files or plugins.
    pub fn spawn_isolated() -> Result<Self, String> {
        Self::spawn_with_config(ConfigSource::Isolated)
    }

    /// Boot isolated Neovim, capture its current buffer, then explicitly source a
    /// selected user config. Source errors are retained in the report while the
    /// session remains usable; missing/unsupported config, bundle, spawn, and required RPC failures return errors.
    pub fn spawn_with_config(source: ConfigSource) -> Result<Self, String> {
        let bundle = bundle_paths().map_err(|detail| format!("neovim bundle: {detail}"))?;
        // Always boot isolated; user files are sourced explicitly afterwards so
        // load failures arrive as RPC errors instead of vanishing on the
        // embed channel (verified: `--embed -u bad.lua` reports nothing on
        // stderr or :messages, while `:luafile`/`:source` returns E492/E5113).
        let isolated_argv =
            argv_for(&ConfigSource::Isolated).map_err(|detail| format!("config: {detail}"))?;
        let source_label = describe_source(&source);
        let client = EmbedClient::spawn(&bundle.exe, &bundle.runtime, &isolated_argv)
            .map_err(|cause| format!("spawn embedded nvim: {cause}"))?;
        // The buffer is the source of truth; start empty with sane editor opts.
        client
            .call(
                "nvim_set_option_value",
                vec![
                    rmpv::Value::from("swapfile"),
                    rmpv::Value::from(false),
                    rmpv::Value::Map(vec![]),
                ],
            )
            .ok();
        let buf = client
            .call("nvim_get_current_buf", vec![])
            .map_err(|cause| format!("nvim_get_current_buf: {cause}"))?;

        let mut errors = Vec::new();
        client
            .call(
                "nvim_exec_lua",
                vec![
                    rmpv::Value::from(
                        r#"
            local target
            for _, channel in ipairs(vim.api.nvim_list_chans()) do
                if channel.stream == 'stdio' then target = channel.id; break end
            end
            if not target then error('embedded stdio channel not found') end
            vim.api.nvim_create_user_command('Marxen', function(opts)
                vim.fn.rpcnotify(target, 'marxen:command', opts.args)
            end, {nargs = 1})
            vim.api.nvim_create_autocmd('QuickFixCmdPost', {
                group = vim.api.nvim_create_augroup('marxen_quickfix', {clear = true}),
                callback = function() vim.fn.rpcnotify(target, 'marxen:quickfix') end,
            })
            vim.g.mapleader = ' '
        "#,
                    ),
                    rmpv::Value::Array(vec![]),
                ],
            )
            .map_err(|cause| format!("Marxen command: {cause}"))?;
        if let ConfigSource::UserFile(path) = &source {
            if !path.is_file() {
                return Err(format!("config not found: {}", path.display()));
            }
            if !config::is_supported_config_name(path) {
                return Err(format!(
                    "unsupported config name (want vimrc/_vimrc/init.vim/init.lua): {}",
                    path.display()
                ));
            }
            let is_lua = path
                .extension()
                .and_then(|ext| ext.to_str())
                .is_some_and(|ext| ext.eq_ignore_ascii_case("lua"));
            let verb = if is_lua { "luafile" } else { "source" };
            let escaped = client
                .call(
                    "nvim_call_function",
                    vec![
                        rmpv::Value::from("fnameescape"),
                        rmpv::Value::Array(vec![rmpv::Value::from(
                            path.to_string_lossy().as_ref(),
                        )]),
                    ],
                )
                .map_err(|cause| format!("config path: {cause}"))?;
            let escaped = escaped
                .as_str()
                .ok_or_else(|| "config path: fnameescape returned invalid text".to_owned())?;
            let cmd = format!("{verb} {escaped}");
            if let Err(cause) = client.call("nvim_command", vec![rmpv::Value::from(cmd.as_str())]) {
                errors.push(trim_remote(cause.to_string()));
            }
        }
        client.call("nvim_exec_lua", vec![rmpv::Value::from(r#"
            local shortcuts = {
                ['s'] = 'file-save', ['p'] = 'palette-quickopen',
                ['S-p'] = 'palette-open', [','] = 'palette-settings',
                ['S-i'] = 'inline-chat', ['M-i'] = 'palette-ai', ['f'] = 'find-file',
            }
            -- Vimrc-first: user mappings always win (mapcheck), and setting
            -- g:marxen_default_shortcuts to 0 skips these defaults entirely
            -- so every shortcut can be defined in vimrc instead.
            if vim.g.marxen_default_shortcuts ~= 0 then
            for _, modifier in ipairs({'C', 'D'}) do
                for key, command in pairs(shortcuts) do
                    local lhs = '<' .. modifier .. '-' .. key .. '>'
                    for _, mode in ipairs({'n', 'x', 'i'}) do
                        if vim.fn.mapcheck(lhs, mode) == '' then
                            vim.keymap.set(mode, lhs, '<Cmd>Marxen ' .. command .. '<CR>', {silent = true})
                        end
                    end
                end
            end
            end
        "#), rmpv::Value::Array(vec![])])
            .map_err(|cause| format!("Marxen shortcuts: {cause}"))?;
        let messages = client
            .call("nvim_command_output", vec![rmpv::Value::from("messages")])
            .ok()
            .and_then(|value| match value {
                rmpv::Value::String(text) => text.as_str().map(str::to_owned),
                _ => None,
            })
            .unwrap_or_default();
        // Give the child a moment to flush early config errors to stderr.
        std::thread::sleep(std::time::Duration::from_millis(100));
        errors.extend(collect_errors(&client.stderr_text(), &messages));
        errors.sort();
        errors.dedup();
        Ok(Self {
            client,
            buf,
            config: ConfigReport {
                source: source_label,
                errors,
            },
        })
    }

    /// Borrow the configuration source label and collected startup errors.
    pub fn config_report(&self) -> &ConfigReport {
        &self.config
    }

    /// Borrow the synchronous RPC client owned by this buffer session.
    pub fn client(&self) -> &EmbedClient {
        &self.client
    }

    /// Borrow the native buffer handle captured when the session was opened.
    pub fn buf(&self) -> &rmpv::Value {
        &self.buf
    }

    // -- buffer text -------------------------------------------------------

    /// Fetch every line of the owned buffer and require an array of UTF-8 strings.
    /// Native/transport failures and malformed response values propagate as RPC errors.
    pub fn get_lines(&self) -> Result<Vec<String>, RpcError> {
        let result = self.client.call(
            "nvim_buf_get_lines",
            vec![
                self.buf.clone(),
                rmpv::Value::from(0),
                rmpv::Value::from(-1),
                rmpv::Value::from(false),
            ],
        )?;
        match result {
            rmpv::Value::Array(items) => items
                .into_iter()
                .map(|item| match item {
                    rmpv::Value::String(text) => text
                        .as_str()
                        .map(str::to_owned)
                        .ok_or_else(|| RpcError::Invalid("non-utf8 line".into())),
                    other => Err(RpcError::Invalid(format!("line not string: {other:?}"))),
                })
                .collect(),
            other => Err(RpcError::Invalid(format!(
                "nvim_buf_get_lines non-array: {other:?}"
            ))),
        }
    }

    /// Join all authoritative buffer lines with LF without appending an extra newline.
    pub fn get_text(&self) -> Result<String, RpcError> {
        Ok(join_lines(&self.get_lines()?))
    }

    /// Replace the owned buffer using LF-split lines, preserving a final empty
    /// line and representing empty text as one empty native line.
    pub fn set_text(&self, text: &str) -> Result<(), RpcError> {
        let lines: Vec<rmpv::Value> = split_lines(text)
            .into_iter()
            .map(rmpv::Value::from)
            .collect();
        self.client.call(
            "nvim_buf_set_lines",
            vec![
                self.buf.clone(),
                rmpv::Value::from(0),
                rmpv::Value::from(-1),
                rmpv::Value::from(false),
                rmpv::Value::Array(lines),
            ],
        )?;
        Ok(())
    }

    /// Apply one `nvim_buf_set_text` range. Rows are 0-indexed, cols are UTF-8
    /// bytes inside the line. `replacement` may contain `\n`.
    pub fn set_text_range(
        &self,
        start_row: u32,
        start_col: u32,
        end_row: u32,
        end_col: u32,
        replacement: &str,
    ) -> Result<(), RpcError> {
        let lines: Vec<rmpv::Value> = replacement.split('\n').map(rmpv::Value::from).collect();
        self.client.call(
            "nvim_buf_set_text",
            vec![
                self.buf.clone(),
                rmpv::Value::from(start_row),
                rmpv::Value::from(start_col),
                rmpv::Value::from(end_row),
                rmpv::Value::from(end_col),
                rmpv::Value::Array(lines),
            ],
        )?;
        Ok(())
    }

    /// Subscribe to `nvim_buf_lines_event` / changedtick notifications.
    pub fn attach_buffer(&self) -> Result<(), RpcError> {
        self.client.call(
            "nvim_buf_attach",
            vec![
                self.buf.clone(),
                rmpv::Value::from(false),
                rmpv::Value::Map(vec![]),
            ],
        )?;
        Ok(())
    }

    // -- modes, input, commands --------------------------------------------

    /// Query the contract mode via the fast mode API, discarding its blocking flag.
    pub fn mode(&self) -> Result<crate::contracts::VimMode, RpcError> {
        Ok(self.mode_state()?.0)
    }

    /// Fast API: answers while an operator, mapping, or prompt awaits input.
    /// An embedded UI must be attached before querying the live mode.
    pub fn mode_state(&self) -> Result<(crate::contracts::VimMode, bool), RpcError> {
        let value = self.client.call("nvim_get_mode", vec![])?;
        Ok((mode::parse_mode(&value)?, mode::parse_blocking(&value)?))
    }

    /// Detect blocking or command-line input before querying native pending-state
    /// flags with `state('moS')`; reject a non-string result.
    pub fn input_pending(&self) -> Result<bool, RpcError> {
        let (mode, blocking) = self.mode_state()?;
        if blocking || mode == crate::contracts::VimMode::CommandLine {
            return Ok(true);
        }
        // Operators permit API reads, but a GUI edit must not interrupt them.
        // A fast blocking check must precede this deferred state() query.
        let value = self.call_function("state", vec![rmpv::Value::from("moS")])?;
        value
            .as_str()
            .map(|flags| !flags.is_empty())
            .ok_or_else(|| RpcError::Invalid("state() returned non-string".into()))
    }

    /// Native character/line selection as half-open byte coordinates.
    /// getregion supplies complete composing characters and follows 'selection'.
    /// Rectangular selections cannot be expressed as one contiguous range.
    /// Return zero-based start/end rows, UTF-8 byte columns, newline inclusion,
    /// and forward direction; reject malformed native tuples or coordinates.
    pub fn visual_selection(&self) -> Result<(u32, u32, u32, u32, bool, bool), RpcError> {
        let value = self.exec_lua(
            r#"
                local anchor, head = vim.fn.getpos('v'), vim.fn.getpos('.')
                local kind = vim.fn.mode(1):sub(1, 1)
                if kind == 's' then kind = 'v' elseif kind == 'S' then kind = 'V' end
                local opts = { type = kind, eol = true }
                local regions = vim.fn.getregionpos(anchor, head, opts)
                local text = vim.fn.getregion(anchor, head, { type = kind })
                if #regions == 0 or #text == 0 then error('empty visual region') end
                local first, last = regions[1][1], regions[#regions][2]
                local last_start = regions[#regions][1]
                local first_line = vim.fn.getline(first[2])
                local last_line = vim.fn.getline(last[2])
                local start_col = math.min(math.max(first[3] - 1, 0), #first_line)
                local end_col = math.min(math.max(last_start[3] - 1, 0) + #text[#text], #last_line)
                    local upper = anchor[2] > head[2] or (anchor[2] == head[2] and anchor[3] > head[3])
                    local upper_pos = upper and anchor or head
                    local exclusive = vim.o.selection == 'exclusive'
                    local newline = (kind == 'V' or last[3] > #last_line
                        or (not exclusive and upper_pos[2] == last[2] and upper_pos[3] > #last_line)
                        or (exclusive and upper_pos[2] > last[2]))
                    and last[2] < vim.api.nvim_buf_line_count(0)
                local forward = anchor[2] < head[2]
                    or (anchor[2] == head[2] and anchor[3] <= head[3])
                return { first[2] - 1, start_col, last[2] - 1, end_col, newline, forward }
            "#,
        )?;
        let values = value
            .as_array()
            .filter(|items| items.len() == 6)
            .ok_or_else(|| RpcError::Invalid("invalid visual coordinates".into()))?;
        let coordinate = |index: usize| {
            values[index]
                .as_u64()
                .and_then(|number| u32::try_from(number).ok())
                .ok_or_else(|| RpcError::Invalid("invalid visual byte coordinate".into()))
        };
        let flag = |index: usize| {
            values[index]
                .as_bool()
                .ok_or_else(|| RpcError::Invalid("invalid visual direction".into()))
        };
        Ok((
            coordinate(0)?,
            coordinate(1)?,
            coordinate(2)?,
            coordinate(3)?,
            flag(4)?,
            flag(5)?,
        ))
    }

    /// Name the owned buffer (enables `:w` with a filename so `BufWriteCmd`
    /// intercepts instead of E32 on unnamed buffers).
    pub fn set_buf_name(&self, name: &str) -> Result<(), RpcError> {
        self.client.call(
            "nvim_buf_set_name",
            vec![self.buf.clone(), rmpv::Value::from(name)],
        )?;
        Ok(())
    }

    /// Feed keys as typed, honoring user mappings (wraps `nvim_input`).
    /// Return the number of input bytes accepted, not the number of executed commands.
    pub fn input(&self, keys: &str) -> Result<usize, RpcError> {
        let result = self
            .client
            .call("nvim_input", vec![rmpv::Value::from(keys)])?;
        match result {
            rmpv::Value::Integer(n) => Ok(n.as_u64().unwrap_or(0) as usize),
            other => Err(RpcError::Invalid(format!("nvim_input: {other:?}"))),
        }
    }

    /// Execute one Ex command and propagate native command or transport errors.
    pub fn command(&self, cmd: &str) -> Result<(), RpcError> {
        self.client
            .call("nvim_command", vec![rmpv::Value::from(cmd)])?;
        Ok(())
    }

    /// Execute an Ex command and capture its output; require a string response,
    /// using empty text if its MessagePack string is not valid UTF-8.
    pub fn command_output(&self, cmd: &str) -> Result<String, RpcError> {
        let result = self
            .client
            .call("nvim_command_output", vec![rmpv::Value::from(cmd)])?;
        match result {
            rmpv::Value::String(text) => Ok(text.as_str().unwrap_or_default().to_owned()),
            other => Err(RpcError::Invalid(format!("command_output: {other:?}"))),
        }
    }

    /// Execute Lua without positional arguments and return its raw MessagePack value.
    pub fn exec_lua(&self, code: &str) -> Result<rmpv::Value, RpcError> {
        self.client.call(
            "nvim_exec_lua",
            vec![rmpv::Value::from(code), rmpv::Value::Array(vec![])],
        )
    }

    /// Read Marxen's optional copy selectors from the already sourced vimrc.
    /// The defaults deliberately use function keys, which are not motions or
    /// operators in Normal mode. A user's vimrc can change them without
    /// asking the frontend to parse Vimscript:
    /// `let g:marxen_copy_markdown_key = '<F6>'` (empty disables a selector).
    pub fn copy_keys(&self) -> Result<BTreeMap<String, String>, RpcError> {
        Ok(self.copy_config()?.0)
    }

    /// Read copy selectors with F6–F9 defaults; empty strings disable selectors.
    /// Collect diagnostics for invalid/reserved/duplicate keys and omit rejected
    /// selectors, removing both colliding formats; malformed result data is an RPC error.
    pub fn copy_config(&self) -> Result<(BTreeMap<String, String>, Vec<String>), RpcError> {
        let value = self.exec_lua(
            r#"
                local out = {keys = vim.empty_dict(), errors = {}}
                local seen = {}
                local reserved = {['<left>']=true, ['<right>']=true, ['<up>']=true,
                    ['<down>']=true, ['<home>']=true, ['<end>']=true}
                for i, name in ipairs({'markdown', 'text', 'rich', 'html'}) do
                    local setting = 'marxen_copy_' .. name .. '_key'
                    local value = vim.g[setting]
                    if value == nil then value = '<F' .. (i + 5) .. '>' end
                    local problem
                    if type(value) ~= 'string' then problem = '文字列で指定してください。'
                    elseif value ~= '' then
                        local term = vim.api.nvim_replace_termcodes(value, true, true, true)
                        local key = vim.fn.keytrans(term):lower()
                        local single = vim.fn.strchars(term) == 1 or key:match('^<[^<>]+>$')
                        if #value > 64 or not single then problem = '一つのキーを指定してください。'
                        elseif reserved[key] or (key:find('[cd]%-') and key:match('[ps]>$')) then
                            problem = 'アプリのショートカット・表示行移動のキーは指定できません。'
                        elseif seen[term] then
                            problem = 'g:marxen_copy_' .. seen[term] .. '_key と重複しています。'
                            out.keys[seen[term]] = nil
                        else seen[term] = name; out.keys[name] = value end
                    end
                    if problem then table.insert(out.errors, 'g:' .. setting .. ': ' .. problem) end
                end
                return out
            "#,
        )?;
        #[derive(serde::Deserialize)]
        struct Config {
            keys: BTreeMap<String, String>,
            errors: Vec<String>,
        }
        let config: Config = rmpv::ext::from_value(value)
            .map_err(|error| RpcError::Invalid(format!("copy configuration: {error}")))?;
        Ok((config.keys, config.errors))
    }

    /// Compare canonical Neovim termcodes, including case aliases such as
    /// `<c-f6>`. Called only when native input is ready for another command.
    pub fn same_key(&self, left: &str, right: &str) -> Result<bool, RpcError> {
        let value = self.client.call("nvim_exec_lua", vec![
            rmpv::Value::from("local a,b = ...; return vim.api.nvim_replace_termcodes(a,true,true,true) == vim.api.nvim_replace_termcodes(b,true,true,true)"),
            rmpv::Value::Array(vec![left.into(), right.into()]),
        ])?;
        value
            .as_bool()
            .ok_or_else(|| RpcError::Invalid("key comparison is not boolean".into()))
    }

    /// Observe actual yanks (including mapped, repeated, named-register and
    /// rectangular yanks). Never read a deferred register API while Vim is
    /// waiting for a motion. Delete/change events do not arm copy selectors.
    pub fn install_yank_observer(&self) -> Result<(), RpcError> {
        self.client.call(
            "nvim_exec_lua",
            vec![
                rmpv::Value::from(
                    r#"
                local owned = ...
                local target = 1
                for _, channel in ipairs(vim.api.nvim_list_chans()) do
                    if channel.stream == 'stdio' then target = channel.id; break end
                end
                local group = vim.api.nvim_create_augroup('marxen_yank_' .. owned, {clear = true})
                vim.api.nvim_create_autocmd('TextYankPost', {
                    group = group, buffer = owned,
                    callback = function()
                        local event = vim.v.event
                        if event.operator ~= 'y' then return end
                        local text = table.concat(event.regcontents, '\n')
                        if event.regtype == 'V' then text = text .. '\n' end
                        vim.fn.rpcnotify(target, 'marxen:yanked', text)
                    end,
                })
            "#,
                ),
                rmpv::Value::Array(vec![self.buf.clone()]),
            ],
        )?;
        Ok(())
    }

    /// Call a named Vimscript function with supplied values and return its raw result.
    pub fn call_function(
        &self,
        func: &str,
        args: Vec<rmpv::Value>,
    ) -> Result<rmpv::Value, RpcError> {
        self.client.call(
            "nvim_call_function",
            vec![rmpv::Value::from(func), rmpv::Value::Array(args)],
        )
    }

    /// Measure native display-cell width with the active Neovim settings.
    /// Reject negative or non-integer results rather than treating them as widths.
    pub fn strdisplaywidth(&self, text: &str) -> Result<u64, RpcError> {
        let result = self.call_function("strdisplaywidth", vec![rmpv::Value::from(text)])?;
        match result {
            rmpv::Value::Integer(n) => n
                .as_u64()
                .ok_or_else(|| RpcError::Invalid("strdisplaywidth".into())),
            other => Err(RpcError::Invalid(format!("strdisplaywidth: {other:?}"))),
        }
    }

    /// 1-indexed row, 0-indexed UTF-8 byte col (Neovim window cursor).
    pub fn win_cursor(&self) -> Result<(u64, u64), RpcError> {
        let win = self.client.call("nvim_get_current_win", vec![])?;
        let result = self.client.call("nvim_win_get_cursor", vec![win])?;
        match result {
            rmpv::Value::Array(items) if items.len() == 2 => {
                let row = match &items[0] {
                    rmpv::Value::Integer(n) => n.as_u64(),
                    _ => None,
                };
                let col = match &items[1] {
                    rmpv::Value::Integer(n) => n.as_u64(),
                    _ => None,
                };
                match (row, col) {
                    (Some(row), Some(col)) => Ok((row, col)),
                    _ => Err(RpcError::Invalid("win_get_cursor".into())),
                }
            }
            other => Err(RpcError::Invalid(format!("win_get_cursor: {other:?}"))),
        }
    }

    /// Run `silent! undo`, suppressing native undo errors while preserving transport errors.
    pub fn undo(&self) -> Result<(), RpcError> {
        // `silent!` keeps an empty undo history from failing the test setup.
        self.command("silent! undo")?;
        Ok(())
    }

    /// Run `silent! redo`, suppressing native redo errors while preserving transport errors.
    pub fn redo(&self) -> Result<(), RpcError> {
        self.command("silent! redo")?;
        Ok(())
    }

    /// Capture the current native `:messages` history for diagnostics.
    pub fn messages(&self) -> Result<String, RpcError> {
        self.command_output("messages")
    }

    // -- :w delegation ------------------------------------------------------

    /// Intercept `:w` via `BufWriteCmd` and notify Rust instead of writing.
    /// Rust owns the file; the autocmd deliberately performs no write.
    pub fn install_save_intercept(&self) -> Result<(), RpcError> {
        let lua = r#"
            local owned = ...
            local chans = vim.api.nvim_list_chans()
            local target = 1
            for _, c in ipairs(chans) do
              if c.stream == 'stdio' then target = c.id break end
            end
            local group = vim.api.nvim_create_augroup('marxen_save_' .. owned, {clear = true})
            local function canonical(path)
              local result = vim.fn.resolve(vim.fn.fnamemodify(path, ':p'))
              if vim.fn.has('win32') == 1 then result = result:lower() end
              return result
            end
            vim.api.nvim_create_autocmd('BufWriteCmd', {
              group = group,
              buffer = owned,
              callback = function(args)
                local name = vim.api.nvim_buf_get_name(owned)
                if args.buf ~= owned or (args.file ~= '' and canonical(args.file) ~= canonical(name)) then
                  error('Marxen: 別名での保存はアプリの名前を付けて保存を使ってください')
                end
                vim.fn.rpcnotify(target, 'marxen:save-requested', owned)
              end,
            })
            vim.api.nvim_create_autocmd({'FileWriteCmd', 'FileAppendCmd'}, {
              group = group,
              buffer = owned,
              callback = function()
                error('Marxen: 範囲保存と追記は文書の保存操作に対応していません')
              end,
            })
        "#;
        self.client.call(
            "nvim_exec_lua",
            vec![lua.into(), rmpv::Value::Array(vec![self.buf.clone()])],
        )?;
        Ok(())
    }

    /// Poll child-process status without issuing an RPC to a potentially exited peer.
    pub fn is_alive(&self) -> Result<bool, RpcError> {
        self.client.is_alive()
    }

    /// Read the session quickfix list for the GUI search tab, capped for display.
    ///
    /// Entries carry absolute paths; the GUI resolves workspace roots. Only
    /// failures to reach Neovim surface; malformed entries are skipped.
    pub fn read_quickfix(&self) -> Result<crate::contracts::QuickfixList, RpcError> {
        use crate::contracts::{QuickfixEntry, QuickfixList};
        let list = self.client.call(
            "nvim_call_function",
            vec![rmpv::Value::from("getqflist"), rmpv::Value::Array(vec![])],
        )?;
        let mut names: std::collections::HashMap<u64, String> = std::collections::HashMap::new();
        let mut items = Vec::new();
        let mut total = 0usize;
        if let rmpv::Value::Array(entries) = &list {
            total = entries.len();
            for entry in entries.iter().take(200) {
                let cell = |key: &str| {
                    entry.as_map().and_then(|pairs| {
                        pairs
                            .iter()
                            .find_map(|(name, value)| (name.as_str() == Some(key)).then_some(value))
                    })
                };
                let bufnr = cell("bufnr").and_then(rmpv::Value::as_u64).unwrap_or(0);
                let line = cell("lnum").and_then(rmpv::Value::as_u64).unwrap_or(0);
                let col = cell("col").and_then(rmpv::Value::as_u64).unwrap_or(0);
                let text = cell("text").and_then(rmpv::Value::as_str).unwrap_or("");
                if line == 0 {
                    continue;
                }
                let path = match names.get(&bufnr) {
                    Some(name) => name.clone(),
                    None => {
                        let name = self
                            .client
                            .call("nvim_buf_get_name", vec![rmpv::Value::from(bufnr)])
                            .ok()
                            .and_then(|value| value.as_str().map(str::to_owned))
                            .unwrap_or_default();
                        names.insert(bufnr, name.clone());
                        name
                    }
                };
                let mut display = text.to_owned();
                if display.len() > 500 {
                    display.truncate(500);
                }
                items.push(QuickfixEntry {
                    path,
                    line: u32::try_from(line).unwrap_or(u32::MAX),
                    col: u32::try_from(col).unwrap_or(u32::MAX),
                    text: display,
                });
            }
        }
        Ok(QuickfixList { items, total })
    }

    /// Read the current `/` position via `searchcount()`; `None` without an active search.
    pub fn search_count(&self) -> Result<Option<crate::contracts::SearchCount>, RpcError> {
        use crate::contracts::SearchCount;
        let options = vec![
            (rmpv::Value::from("timeout"), rmpv::Value::from(100u64)),
            (rmpv::Value::from("maxcount"), rmpv::Value::from(9999u64)),
        ];
        let result = self.client.call(
            "nvim_call_function",
            vec![
                rmpv::Value::from("searchcount"),
                rmpv::Value::Array(vec![rmpv::Value::Map(options)]),
            ],
        )?;
        let cell = |key: &str| {
            result.as_map().and_then(|pairs| {
                pairs
                    .iter()
                    .find_map(|(name, value)| (name.as_str() == Some(key)).then_some(value))
            })
        };
        let total = cell("total").and_then(rmpv::Value::as_u64).unwrap_or(0);
        if total == 0 {
            return Ok(None);
        }
        Ok(Some(SearchCount {
            current: cell("current")
                .and_then(rmpv::Value::as_u64)
                .and_then(|value| usize::try_from(value).ok())
                .unwrap_or(0),
            total: usize::try_from(total).unwrap_or(usize::MAX),
            exact: !cell("incomplete")
                .and_then(rmpv::Value::as_u64)
                .is_some_and(|flag| flag != 0),
        }))
    }

    /// Drain `marxen:save-requested` notifications queued since the last call.
    /// Consume the whole queue and discard every other notification kind.
    pub fn drain_save_requests(&self) -> Vec<rpc::Notification> {
        self.client
            .drain_notifications()
            .into_iter()
            .filter(|note| note.method == "marxen:save-requested")
            .collect()
    }

    /// All pending notifications (buffer events, redraw, save, ...).
    pub fn drain_notifications(&self) -> Vec<rpc::Notification> {
        self.client.drain_notifications()
    }
}

/// Shorten `neovim error: nvim_command: [...]` wrappers for config reports.
fn trim_remote(detail: String) -> String {
    const PREFIX: &str = "neovim error: nvim_command: ";
    detail
        .strip_prefix(PREFIX)
        .unwrap_or(&detail)
        .chars()
        .take(500)
        .collect()
}
