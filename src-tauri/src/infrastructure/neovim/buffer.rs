//! Native authoritative-buffer adapter for document use cases.
use super::{rpc::RpcError, NeovimSession};
use crate::application::ports::*;
use crate::contracts::VimMode;
use std::collections::BTreeMap;
use std::path::Path;
pub struct NativeBuffer(pub NeovimSession);
pub struct NativeBufferFactory;
impl From<RpcError> for BufferError {
    /// Convert transport diagnostics without exposing the RPC client to use cases.
    fn from(error: RpcError) -> Self {
        Self(error.to_string())
    }
}
impl BufferFactory for NativeBufferFactory {
    /// Start the real isolated buffer, install write/yank interception, and preserve native undo initialization.
    fn open(
        &self,
        config: ConfigSource,
        text: &str,
        path: Option<&Path>,
        clean: bool,
    ) -> Result<Box<dyn Buffer>, BufferError> {
        let nvim = NeovimSession::spawn_with_config(config).map_err(BufferError)?;
        super::grid::attach(nvim.client(), 80, 24)?;
        if clean {
            if let Some(path) = path {
                let _ = nvim.set_buf_name(&path.to_string_lossy());
            }
        }
        let levels = nvim.client().call(
            "nvim_get_option_value",
            vec!["undolevels".into(), rmpv::Value::Map(vec![])],
        )?;
        nvim.command("setlocal undolevels=-1")?;
        nvim.set_text(text)?;
        nvim.client().call(
            "nvim_set_option_value",
            vec!["undolevels".into(), levels, rmpv::Value::Map(vec![])],
        )?;
        if !clean {
            if let Some(path) = path {
                nvim.set_buf_name(&path.to_string_lossy())?;
            }
        }
        nvim.install_save_intercept()?;
        nvim.install_yank_observer()?;
        nvim.command("setlocal buftype=acwrite")?;
        if clean {
            nvim.command("silent! setlocal nomodified")?;
        }
        Ok(Box::new(NativeBuffer(nvim)))
    }
}
impl Buffer for NativeBuffer {
    fn is_alive(&self) -> Result<bool, BufferError> {
        Ok(self.0.is_alive()?)
    }
    fn get_text(&self) -> Result<String, BufferError> {
        Ok(self.0.get_text()?)
    }
    fn set_text(&self, text: &str) -> Result<(), BufferError> {
        Ok(self.0.set_text(text)?)
    }
    fn set_buf_name(&self, name: &str) -> Result<(), BufferError> {
        Ok(self.0.set_buf_name(name)?)
    }
    fn input(&self, keys: &str) -> Result<usize, BufferError> {
        Ok(self.0.input(keys)?)
    }
    fn mode(&self) -> Result<VimMode, BufferError> {
        Ok(self.0.mode()?)
    }
    fn mode_state(&self) -> Result<(VimMode, bool), BufferError> {
        Ok(self.0.mode_state()?)
    }
    fn input_pending(&self) -> Result<bool, BufferError> {
        Ok(self.0.input_pending()?)
    }
    fn visual_selection(&self) -> Result<(u32, u32, u32, u32, bool, bool), BufferError> {
        Ok(self.0.visual_selection()?)
    }
    fn win_cursor(&self) -> Result<(u64, u64), BufferError> {
        Ok(self.0.win_cursor()?)
    }
    fn undo(&self) -> Result<(), BufferError> {
        Ok(self.0.undo()?)
    }
    fn redo(&self) -> Result<(), BufferError> {
        Ok(self.0.redo()?)
    }
    fn copy_keys(&self) -> Result<BTreeMap<String, String>, BufferError> {
        Ok(self.0.copy_keys()?)
    }
    fn copy_config(&self) -> Result<(BTreeMap<String, String>, Vec<String>), BufferError> {
        Ok(self.0.copy_config()?)
    }
    fn same_key(&self, left: &str, right: &str) -> Result<bool, BufferError> {
        Ok(self.0.same_key(left, right)?)
    }

    fn config_report(&self) -> &ConfigReport {
        self.0.config_report()
    }
    fn has_mapping(&self, mode: &str, lhs: &str) -> Result<bool, BufferError> {
        Ok(super::mapping::has_mapping(self.0.client(), mode, lhs)?)
    }
    fn apply_ranges(&self, edits: &[PositionedEdit]) -> Result<(), BufferError> {
        let edits = edits
            .iter()
            .rev()
            .map(|(sr, sc, er, ec, text)| {
                rmpv::Value::Array(vec![
                    (*sr).into(),
                    (*sc).into(),
                    (*er).into(),
                    (*ec).into(),
                    rmpv::Value::Array(text.split('\n').map(rmpv::Value::from).collect()),
                ])
            })
            .collect();
        self.0.client().call("nvim_exec_lua",vec![rmpv::Value::from("local buf, edits = ...; for i,e in ipairs(edits) do if i > 1 then vim.cmd('undojoin') end; vim.api.nvim_buf_set_text(buf,e[1],e[2],e[3],e[4],e[5]) end"),rmpv::Value::Array(vec![self.0.buf().clone(),rmpv::Value::Array(edits)])])?;
        Ok(())
    }
    fn selection_exclusive(&self) -> Result<bool, BufferError> {
        Ok(self
            .0
            .client()
            .call(
                "nvim_get_option_value",
                vec!["selection".into(), rmpv::Value::Map(vec![])],
            )?
            .as_str()
            == Some("exclusive"))
    }
    fn virtualedit(&self) -> Result<String, BufferError> {
        Ok(self
            .0
            .exec_lua("return vim.wo.virtualedit")?
            .as_str()
            .unwrap_or_default()
            .to_owned())
    }
    fn restore_virtualedit(&self, original: &str) -> Result<(), BufferError> {
        self.0.client().call(
            "nvim_set_option_value",
            vec![
                "virtualedit".into(),
                original.into(),
                rmpv::Value::Map(vec![("win".into(), 0.into())]),
            ],
        )?;
        Ok(())
    }
    fn install_selection(
        &self,
        anchor: (u32, u32),
        head: (u32, u32),
        linewise: bool,
    ) -> Result<(), BufferError> {
        let kind = if linewise { "V" } else { "v" };
        self.0.exec_lua(&format!("vim.cmd('normal! ' .. string.char(27)); local ve = vim.wo.virtualedit; if not ve:find('onemore', 1, true) and not ve:find('all', 1, true) then vim.wo.virtualedit = ve == '' and 'onemore' or ve .. ',onemore' end; vim.api.nvim_win_set_cursor(0, {{{}, {}}}); vim.cmd('normal! {}'); vim.api.nvim_win_set_cursor(0, {{{}, {}}})",anchor.0+1,anchor.1,kind,head.0+1,head.1))?;
        Ok(())
    }
    fn exit_visual(&self) -> Result<(), BufferError> {
        self.0.exec_lua("vim.cmd('normal! ' .. string.char(27))")?;
        Ok(())
    }
    fn set_cursor(&self, row: u32, col: u32) -> Result<(), BufferError> {
        self.0.client().call(
            "nvim_win_set_cursor",
            vec![
                0.into(),
                rmpv::Value::Array(vec![(row + 1).into(), col.into()]),
            ],
        )?;
        Ok(())
    }
    fn resize_grid(&self, width: u32, height: u32) -> Result<(), BufferError> {
        self.0
            .client()
            .call("nvim_ui_try_resize", vec![width.into(), height.into()])?;
        self.0.command("redraw!")?;
        Ok(())
    }
    fn clear_modified(&self) -> Result<(), BufferError> {
        Ok(self.0.command("setlocal nomodified")?)
    }
    fn install_save_intercept(&self) -> Result<(), BufferError> {
        self.0.install_save_intercept()?;
        self.0.command("setlocal buftype=acwrite")?;
        Ok(())
    }
    fn command_for_fixture(&self, command: &str) -> Result<(), BufferError> {
        Ok(self.0.command(command)?)
    }
    fn drain_save_requests(&self) -> Vec<String> {
        self.0
            .drain_save_requests()
            .into_iter()
            .map(|n| n.method)
            .collect()
    }
    fn drain_notifications(&self) -> Vec<BufferNotification> {
        self.0
            .drain_notifications()
            .into_iter()
            .filter_map(|n| match n.method.as_str() {
                "marxen:yanked" => n
                    .params
                    .first()
                    .and_then(rmpv::Value::as_str)
                    .map(|t| BufferNotification::Yank(t.to_owned())),
                "marxen:save-requested" => Some(BufferNotification::SaveRequested),
                "redraw" => serde_json::to_value(n.params)
                    .ok()
                    .map(BufferNotification::Redraw),
                _ => None,
            })
            .collect()
    }
}
