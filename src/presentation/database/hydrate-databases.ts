// Database views for fenced `database` blocks (presentation).
//
// Builds an editable table with DOM APIs only (no HTML strings from data).
// Rows come from the injected viewer, which the shell binds to one document;
// without a viewer the block shows how to enable the feature.

import type { DatabaseEdit, DatabaseSource, DatabaseTable } from "../../contracts/contracts";
import type { Translator } from "../../contracts/localization";
import { parseDatabaseBlock } from "../../domain/database-block";
import { japaneseTranslator } from "../../domain/localization";

/** Document-bound access to database views. */
export interface DatabaseViewer {
  /** Read the rows of a view. */
  query(source: DatabaseSource): Promise<DatabaseTable>;
  /** Apply one edit and return the refreshed rows. */
  edit(source: DatabaseSource, edit: DatabaseEdit): Promise<DatabaseTable>;
  /** Open a folder-view note in the editor. */
  openNote?(path: string): void;
}

/** Create an element with a class and optional text. */
function node<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

/** Read the block's raw fenced source. */
function sourceText(block: Element): string {
  return block.querySelector("details.marxen-source pre code, pre.marxen-raw > code")?.textContent?.replace(/\n$/, "") ?? "";
}

/** Error text from an IPC failure or thrown error. */
function failure(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (cause && typeof cause === "object") return JSON.stringify(cause);
  return String(cause);
}

/** Note file name without folders or the Markdown extension. */
function noteTitle(path: string): string {
  return (path.split("/").at(-1) ?? path).replace(/\.(md|markdown)$/i, "");
}

/** Mutable state of one hydrated view. */
interface View {
  container: HTMLElement;
  source: DatabaseSource;
  viewer: DatabaseViewer;
  t: Translator;
  signal?: AbortSignal;
}

/** Run an edit, then redraw; focus returns to the same row and column when they still exist. */
async function apply(view: View, edit: DatabaseEdit, focus?: { row: number; column: string }): Promise<void> {
  try {
    const table = await view.viewer.edit(view.source, edit);
    if (view.signal?.aborted || !view.container.isConnected) return;
    draw(view, table);
    if (focus) view.container.querySelector<HTMLInputElement>(`input[data-row="${focus.row}"][data-column="${CSS.escape(focus.column)}"]`)?.focus();
  } catch (cause) {
    if (view.signal?.aborted) return;
    showError(view, view.t("データベースを更新できません。{{value0}}", { value0: failure(cause) }));
  }
}

/** Show one alert above the table, replacing an earlier one. */
function showError(view: View, message: string): void {
  view.container.querySelector(":scope > .marxen-error")?.remove();
  const box = node("div", "marxen-error", message);
  box.setAttribute("role", "alert");
  view.container.prepend(box);
}

/** One editable cell; Enter commits and moves down, Escape restores the stored value. */
function cellInput(view: View, table: DatabaseTable, rowIndex: number, column: string): HTMLInputElement {
  const row = table.rows[rowIndex];
  const stored = row.cells[column] ?? "";
  const input = node("input", "marxen-database-input");
  input.value = stored;
  input.dataset.row = String(rowIndex);
  input.dataset.column = column;
  input.setAttribute("aria-label", `${column} ${rowIndex + 1}`);
  input.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    if (event.key === "Escape") {
      input.value = stored;
      input.blur();
    } else if (event.key === "Enter") {
      event.preventDefault();
      const next = Math.min(rowIndex + 1, table.rows.length - 1);
      if (input.value === stored) view.container.querySelector<HTMLInputElement>(`input[data-row="${next}"][data-column="${CSS.escape(column)}"]`)?.focus();
      else void apply(view, { kind: "setCell", id: row.id, column, value: input.value }, { row: next, column });
    }
  });
  input.addEventListener("change", () => {
    if (input.value !== stored) void apply(view, { kind: "setCell", id: row.id, column, value: input.value });
  });
  return input;
}

/** Inline name field for a new column; Enter adds it, Escape cancels. */
function columnForm(view: View, toolbar: HTMLElement): void {
  if (toolbar.querySelector("input")) return;
  const input = node("input", "marxen-database-input");
  input.placeholder = view.t("新しい列の名前");
  input.setAttribute("aria-label", view.t("新しい列の名前"));
  input.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    if (event.key === "Escape") input.remove();
    if (event.key === "Enter" && input.value.trim()) void apply(view, { kind: "addColumn", name: input.value.trim() });
  });
  toolbar.append(input);
  input.focus();
}

/** Replace the view's contents with a toolbar and table for the given rows. */
function draw(view: View, table: DatabaseTable): void {
  const { container, source, t } = view;
  container.replaceChildren();
  const folder = source.kind === "folder";
  const toolbar = node("div", "marxen-database-toolbar");
  const addRow = node("button", "marxen-database-button", t("行を追加"));
  addRow.type = "button";
  addRow.addEventListener("click", () => void apply(view, { kind: "addRow" }));
  const addColumn = node("button", "marxen-database-button", t("列を追加"));
  addColumn.type = "button";
  addColumn.addEventListener("click", () => columnForm(view, toolbar));
  toolbar.append(addRow, addColumn);
  container.append(toolbar);

  const grid = node("table", "marxen-database-table");
  const head = grid.createTHead().insertRow();
  if (folder) head.append(node("th", "", t("ノート")));
  for (const column of table.columns) head.append(node("th", "", column.name));
  head.append(node("th", "marxen-database-actions"));
  const body = grid.createTBody();
  table.rows.forEach((row, rowIndex) => {
    const tr = body.insertRow();
    if (folder && row.path) {
      const cell = node("td", "marxen-database-note");
      const open = node("button", "marxen-database-link", noteTitle(row.path));
      open.type = "button";
      const path = row.path;
      open.addEventListener("click", () => view.viewer.openNote?.(path));
      cell.append(open);
      tr.append(cell);
    }
    for (const column of table.columns) {
      const cell = node("td", "");
      if (column.editable) cell.append(cellInput(view, table, rowIndex, column.name));
      else cell.textContent = row.cells[column.name] ?? "";
      tr.append(cell);
    }
    const actions = node("td", "marxen-database-actions");
    const remove = node("button", "marxen-database-button", "×");
    remove.type = "button";
    remove.setAttribute("aria-label", t("行を削除"));
    remove.title = t("行を削除");
    remove.addEventListener("click", () => void apply(view, { kind: "deleteRow", id: row.id }));
    actions.append(remove);
    tr.append(actions);
  });
  container.append(grid);
  if (table.rows.length === 0) container.append(node("p", "marxen-database-note-text", t("行がありません。")));
  if (table.truncated) container.append(node("p", "marxen-database-note-text", t("先頭 1000 行だけを表示しています。")));
}

/**
 * Hydrate every database block under `root`.
 *
 * Without a viewer (feature off or browser demo) each block explains how to
 * enable it. No DOM is written after `signal` aborts.
 */
export async function hydrateDatabases(root: HTMLElement, viewer: DatabaseViewer | undefined, signal?: AbortSignal, t: Translator = japaneseTranslator): Promise<void> {
  const blocks = [...root.querySelectorAll<HTMLElement>('[data-marxen-kind="database"]:not([data-invalid]):not([data-hydrated])')];
  await Promise.all(blocks.map(async (block) => {
    const container = block.querySelector<HTMLElement>(".marxen-database");
    const parsed = parseDatabaseBlock(sourceText(block), t);
    if (!container || !parsed.ok || signal?.aborted) return;
    block.dataset.hydrated = "true";
    // Keys typed into cells belong to the cells, not to the surrounding editor or Vim.
    for (const type of ["keydown", "keyup", "keypress", "compositionstart", "compositionend", "input", "paste"]) {
      container.addEventListener(type, (event) => event.stopPropagation());
    }
    if (!viewer) {
      container.replaceChildren(node("p", "marxen-database-note-text", t("設定 → エディターで「データベース表示を有効にする」をオンにすると表で表示します。")));
      return;
    }
    const view: View = { container, source: parsed.source, viewer, t, signal };
    container.replaceChildren(node("p", "marxen-database-note-text", t("読み込んでいます…")));
    try {
      const table = await viewer.query(parsed.source);
      if (signal?.aborted || !container.isConnected) return;
      draw(view, table);
    } catch (cause) {
      if (signal?.aborted) return;
      container.replaceChildren();
      showError(view, t("データベースを読み込めません。{{value0}}", { value0: failure(cause) }));
    }
  }));
}
