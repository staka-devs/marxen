// Raw grid parsing for the Neovim原文ビュー (plugin screens).
// Mirrors src-tauri/src/neovim/grid.rs: `redraw` params are the updates array
// itself; each `grid_line` update carries [grid, row, col, cells] tuples with
// variable-length cells [text] / [text, hl] / [text, hl, repeat].

export interface GridCell {
  text: string;
  highlight?: number;
  repeat: number;
}

export interface GridLine {
  grid: number;
  row: number;
  colStart: number;
  cells: GridCell[];
}

/** Extract grid lines from one `redraw` notification's params. Unknown shapes are skipped. */
export function gridLinesFromRedraw(params: unknown[]): GridLine[] {
  const out: GridLine[] = [];
  for (const update of params) {
    if (!Array.isArray(update) || update.length === 0) continue;
    const [event, ...argsList] = update;
    if (event !== "grid_line") continue;
    for (const args of argsList) {
      if (!Array.isArray(args) || args.length < 4) continue;
      const [grid, row, col, rawCells] = args;
      if (typeof grid !== "number" || typeof row !== "number" || typeof col !== "number") continue;
      if (!Array.isArray(rawCells)) continue;
      const cells: GridCell[] = [];
      for (const raw of rawCells) {
        if (!Array.isArray(raw) || raw.length === 0) continue;
        const [text, hl, repeat] = raw;
        if (typeof text !== "string") continue;
        cells.push({
          text,
          highlight: typeof hl === "number" ? hl : undefined,
          repeat: typeof repeat === "number" ? repeat : 1,
        });
      }
      out.push({ grid, row, colStart: col, cells });
    }
  }
  return out;
}

/** Rendered text of a grid line (highlights stripped, repeats expanded). */
export function gridLineText(line: GridLine): string {
  let text = "";
  for (const cell of line.cells) {
    const times = Math.max(1, cell.repeat);
    for (let i = 0; i < times; i += 1) text += cell.text;
  }
  return text;
}
