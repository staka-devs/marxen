//! Raw UI grid (`nvim_ui_attach`) and `redraw` event parsing.
//!
//! Display-coordinate work needs the authoritative grid, not a browser
//! estimate. Attaching a headless UI makes Neovim emit `redraw` notifications
//! with `grid_line`, `grid_cursor_goto`, and `win_viewport` events. Tests
//! attach a small UI, assert grid text for Japanese/emoji, and compare Rust
//! display widths against `strdisplaywidth()`.

use crate::neovim::rpc::{EmbedClient, RpcError};
use rmpv::Value;

/// One `grid_line` event: `grid` id, `row`, `col_start`, ordered cells.
/// Each cell is `(text, hl_id, repeat)`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GridLine {
    pub grid: u64,
    pub row: u64,
    pub col_start: u64,
    pub cells: Vec<GridCell>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GridCell {
    pub text: String,
    pub highlight: Option<u64>,
    pub repeat: u64,
}

/// Attach a headless UI. `width`/`height` are grid cells.
pub fn attach(client: &EmbedClient, width: u64, height: u64) -> Result<Value, RpcError> {
    let options = Value::Map(vec![
        (Value::from("ext_linegrid"), Value::from(true)),
        (Value::from("rgb"), Value::from(false)),
    ]);
    client.call(
        "nvim_ui_attach",
        vec![Value::from(width), Value::from(height), options],
    )
}

pub fn detach(client: &EmbedClient) -> Result<Value, RpcError> {
    client.call("nvim_ui_detach", vec![])
}

/// Extract `grid_line` events from one `redraw` notification's params.
///
/// `params` is the updates array itself: each element is
/// `[event, ...args]`, and one `grid_line` update may carry several
/// `[grid, row, col_start, cells]` tuples.
pub fn grid_lines_from_redraw(params: &[Value]) -> Vec<GridLine> {
    let mut out = Vec::new();
    for update in params {
        let Value::Array(parts) = update else {
            continue;
        };
        if parts.is_empty() {
            continue;
        }
        let event = match &parts[0] {
            Value::String(text) => text.as_str().unwrap_or_default().to_owned(),
            _ => continue,
        };
        if event != "grid_line" {
            continue;
        }
        for args in parts.iter().skip(1) {
            let Value::Array(args) = args else { continue };
            // `[grid, row, col, cells]` plus an optional trailing `wrap`.
            if args.len() < 4 {
                continue;
            }
            let (Some(grid), Some(row), Some(col), Value::Array(raw_cells)) = (
                as_u64(&args[0]),
                as_u64(&args[1]),
                as_u64(&args[2]),
                &args[3],
            ) else {
                continue;
            };
            // Neovim may append a 5th `wrap` boolean; cells stay at index 3.
            let mut cells = Vec::new();
            for raw in raw_cells {
                let Value::Array(cell) = raw else { continue };
                if cell.is_empty() {
                    continue;
                }
                let text = match &cell[0] {
                    Value::String(text) => text.as_str().unwrap_or_default().to_owned(),
                    _ => continue,
                };
                let highlight = cell.get(1).and_then(as_u64);
                let repeat = cell.get(2).and_then(as_u64).unwrap_or(1);
                cells.push(GridCell {
                    text,
                    highlight,
                    repeat,
                });
            }
            out.push(GridLine {
                grid,
                row,
                col_start: col,
                cells,
            });
        }
    }
    out
}

/// Rendered text of a grid line (highlights stripped, repeats expanded).
pub fn grid_line_text(line: &GridLine) -> String {
    let mut text = String::new();
    for cell in &line.cells {
        for _ in 0..cell.repeat.max(1) {
            text.push_str(&cell.text);
        }
    }
    text
}

fn as_u64(value: &Value) -> Option<u64> {
    match value {
        Value::Integer(int) => int.as_u64(),
        _ => None,
    }
}

#[cfg(test)]
mod unit {
    use super::*;

    #[test]
    fn parses_grid_line_redraw() {
        let params = vec![Value::Array(vec![
            Value::from("grid_line"),
            Value::Array(vec![
                Value::from(2),
                Value::from(0),
                Value::from(0),
                Value::Array(vec![
                    Value::Array(vec![Value::from("日"), Value::Nil, Value::from(1)]),
                    Value::Array(vec![Value::from("本"), Value::Nil, Value::from(1)]),
                ]),
            ]),
        ])];
        let lines = grid_lines_from_redraw(&params);
        assert_eq!(lines.len(), 1);
        assert_eq!(grid_line_text(&lines[0]), "日本");
    }
}
