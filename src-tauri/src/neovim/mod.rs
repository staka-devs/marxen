//! Bundled Neovim resolution and the authoritative buffer session.
//!
//! [`NeovimSession`] spawns the real `src-tauri/resources/neovim` binary with
//! `--embed`, keeps its buffer as the document source of truth, and exposes
//! the RPC surface the document actor needs: lines/text range edits, modes,
//! keymaps, display widths, cursor, undo, `:w` interception, UI grid, and
//! buffer notifications. Pure position math lives in [`coordinates`].

pub mod config;
pub mod coordinates;
pub mod grid;
pub mod mapping;
pub mod mode;
pub mod rpc;

use config::{argv_for, collect_errors, describe_source, ConfigReport, ConfigSource};
use coordinates::{join_lines, split_lines};
use rpc::{EmbedClient, RpcError};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

static RESOURCE_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Configure the installed Tauri resource directory before opening documents.
pub fn configure_resource_dir(directory: PathBuf) {
    let _ = RESOURCE_DIR.set(directory);
}

pub use coordinates::{display_width, global_utf16_to_line_byte, line_byte_to_global_utf16};

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
    pub fn spawn_isolated() -> Result<Self, String> {
        Self::spawn_with_config(ConfigSource::Isolated)
    }

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

    pub fn config_report(&self) -> &ConfigReport {
        &self.config
    }

    pub fn client(&self) -> &EmbedClient {
        &self.client
    }

    pub fn buf(&self) -> &rmpv::Value {
        &self.buf
    }

    // -- buffer text -------------------------------------------------------

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

    pub fn get_text(&self) -> Result<String, RpcError> {
        Ok(join_lines(&self.get_lines()?))
    }

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

    pub fn mode(&self) -> Result<crate::contracts::VimMode, RpcError> {
        // NOTE: `nvim_get_mode` never answers on this headless embed channel
        // (see mode::parse_mode docs); `mode()` via eval is authoritative.
        let value = self.call_function("mode", vec![])?;
        match value {
            rmpv::Value::String(text) => {
                let short = text.as_str().unwrap_or_default().to_owned();
                mode::from_short(&short)
            }
            other => Err(RpcError::Invalid(format!("mode(): {other:?}"))),
        }
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
    pub fn input(&self, keys: &str) -> Result<usize, RpcError> {
        let result = self
            .client
            .call("nvim_input", vec![rmpv::Value::from(keys)])?;
        match result {
            rmpv::Value::Integer(n) => Ok(n.as_u64().unwrap_or(0) as usize),
            other => Err(RpcError::Invalid(format!("nvim_input: {other:?}"))),
        }
    }

    pub fn command(&self, cmd: &str) -> Result<(), RpcError> {
        self.client
            .call("nvim_command", vec![rmpv::Value::from(cmd)])?;
        Ok(())
    }

    pub fn command_output(&self, cmd: &str) -> Result<String, RpcError> {
        let result = self
            .client
            .call("nvim_command_output", vec![rmpv::Value::from(cmd)])?;
        match result {
            rmpv::Value::String(text) => Ok(text.as_str().unwrap_or_default().to_owned()),
            other => Err(RpcError::Invalid(format!("command_output: {other:?}"))),
        }
    }

    pub fn exec_lua(&self, code: &str) -> Result<rmpv::Value, RpcError> {
        self.client.call(
            "nvim_exec_lua",
            vec![rmpv::Value::from(code), rmpv::Value::Array(vec![])],
        )
    }

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

    pub fn undo(&self) -> Result<(), RpcError> {
        // `silent!` keeps an empty undo history from failing the test setup.
        self.command("silent! undo")?;
        Ok(())
    }

    pub fn redo(&self) -> Result<(), RpcError> {
        self.command("silent! redo")?;
        Ok(())
    }

    pub fn messages(&self) -> Result<String, RpcError> {
        self.command_output("messages")
    }

    // -- :w delegation ------------------------------------------------------

    /// Intercept `:w` via `BufWriteCmd` and notify Rust instead of writing.
    /// Rust owns the file; the autocmd deliberately performs no write.
    pub fn install_save_intercept(&self) -> Result<(), RpcError> {
        let lua = r#"
            local chans = vim.api.nvim_list_chans()
            local target = 1
            for _, c in ipairs(chans) do
              if c.stream == 'stdio' then target = c.id break end
            end
            vim.api.nvim_create_autocmd('BufWriteCmd', {
              pattern = '*',
              callback = function(args)
                vim.fn.rpcnotify(target, 'marxen:save-requested', vim.api.nvim_get_current_buf())
              end,
            })
        "#;
        self.exec_lua(lua)?;
        Ok(())
    }

    /// Drain `marxen:save-requested` notifications queued since the last call.
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
