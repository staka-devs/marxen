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

export interface ScreenCell {
  text: string;
  highlight: number;
}

export interface ScreenGrid {
  width: number;
  height: number;
  rows: ScreenCell[][];
}

export interface GridHighlight {
  foreground?: number;
  background?: number;
  special?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  reverse?: boolean;
}

export interface NvimGridState {
  grids: Record<number, ScreenGrid>;
  highlights: Record<number, GridHighlight>;
  colors: GridHighlight;
  cursor: { grid: number; row: number; col: number } | null;
  busy: boolean;
}

export function createGridState(): NvimGridState {
  return { grids: {}, highlights: {}, colors: {}, cursor: null, busy: false };
}

const blankCell = (): ScreenCell => ({ text: " ", highlight: 0 });
const colorKeys = ["foreground", "background", "special"] as const;
const styleKeys = ["bold", "italic", "underline", "strikethrough", "reverse"] as const;

function parseHighlight(value: unknown): GridHighlight {
  const result: GridHighlight = {};
  if (!value || typeof value !== "object") return result;
  const data = value as Record<string, unknown>;
  for (const key of colorKeys) {
    const color = data[key];
    if (typeof color === "number" && Number.isInteger(color) && color >= 0 && color <= 0xffffff) result[key] = color;
  }
  for (const key of styleKeys) if (typeof data[key] === "boolean") result[key] = data[key];
  return result;
}

/** Apply one redraw batch without discarding untouched rows or cell columns. */
export function applyGridUpdates(previous: NvimGridState, updates: unknown[]): NvimGridState {
  const state: NvimGridState = {
    ...previous,
    grids: { ...previous.grids },
    highlights: { ...previous.highlights },
    colors: { ...previous.colors },
  };
  const cloned = new Set<number>();
  const writable = (id: number): ScreenGrid | null => {
    const grid = state.grids[id];
    if (!grid) return null;
    if (!cloned.has(id)) {
      state.grids[id] = { ...grid, rows: grid.rows.map((row) => row.slice()) };
      cloned.add(id);
    }
    return state.grids[id];
  };
  for (const update of updates) {
    if (!Array.isArray(update) || typeof update[0] !== "string") continue;
    const [event, ...tuples] = update;
    if (event === "busy_start") state.busy = true;
    if (event === "busy_stop") state.busy = false;
    for (const tuple of tuples) {
      if (!Array.isArray(tuple)) continue;
      const id = tuple[0];
      if (event === "default_colors_set") {
        state.colors = parseHighlight({ foreground: tuple[0], background: tuple[1], special: tuple[2] });
        continue;
      }
      if (typeof id !== "number" || !Number.isInteger(id) || id < 0) continue;
      if (event === "hl_attr_define") {
        state.highlights[id] = parseHighlight(tuple[1]);
      } else if (event === "grid_resize") {
        const [, width, height] = tuple;
        if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 500 || height > 300) continue;
        const old = state.grids[id];
        state.grids[id] = {
          width, height,
          rows: Array.from({ length: height }, (_, row) => Array.from({ length: width }, (_, col) => old?.rows[row]?.[col] ?? blankCell())),
        };
        cloned.add(id);
      } else if (event === "grid_destroy") {
        delete state.grids[id];
        if (state.cursor?.grid === id) state.cursor = null;
      } else if (event === "grid_cursor_goto") {
        const [, row, col] = tuple;
        if (Number.isInteger(row) && row >= 0 && Number.isInteger(col) && col >= 0) state.cursor = { grid: id, row, col };
      } else if (event === "grid_clear") {
        const grid = writable(id);
        if (grid) grid.rows = Array.from({ length: grid.height }, () => Array.from({ length: grid.width }, blankCell));
      } else if (event === "grid_line") {
        const [, row, start, cells] = tuple;
        const grid = writable(id);
        if (!grid || !Number.isInteger(row) || row < 0 || row >= grid.height || !Number.isInteger(start) || start < 0 || !Array.isArray(cells)) continue;
        let col = start;
        let highlight = 0;
        for (const raw of cells) {
          if (!Array.isArray(raw) || typeof raw[0] !== "string") continue;
          if (Number.isInteger(raw[1]) && raw[1] >= 0) highlight = raw[1];
          const repeat = Number.isInteger(raw[2]) && raw[2] > 0 ? Math.min(raw[2], grid.width) : 1;
          for (let count = 0; count < repeat && col < grid.width; count += 1, col += 1) grid.rows[row][col] = { text: raw[0], highlight };
        }
      } else if (event === "grid_scroll") {
        const [, top, bottom, left, right, rowShift, colShift] = tuple;
        const grid = writable(id);
        if (!grid || ![top, bottom, left, right, rowShift, colShift].every(Number.isInteger)) continue;
        if (top < 0 || bottom > grid.height || left < 0 || right > grid.width || bottom <= top || right <= left) continue;
        const source = grid.rows.map((row) => row.slice());
        for (let row = top; row < bottom; row += 1) {
          for (let col = left; col < right; col += 1) {
            const fromRow = row + rowShift, fromCol = col + colShift;
            grid.rows[row][col] = fromRow >= top && fromRow < bottom && fromCol >= left && fromCol < right
              ? source[fromRow][fromCol] : blankCell();
          }
        }
      }
    }
  }
  return state;
}

export function gridColor(color: number | undefined): string | undefined {
  return color === undefined ? undefined : `#${color.toString(16).padStart(6, "0")}`;
}
