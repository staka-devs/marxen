// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { DatabaseTable } from "../../contracts/contracts";
import { hydrateDatabases } from "./hydrate-databases";

const table: DatabaseTable = {
  columns: [{ name: "status", editable: true }],
  rows: [
    { id: "tasks/a.md", cells: { status: "todo" }, path: "tasks/a.md" },
    { id: "tasks/b.md", cells: {}, path: "tasks/b.md" },
  ],
  truncated: false,
};

/** Mount one database block the way the render pipeline emits it. */
function mount(source: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = `<div class="marxen-special" data-marxen-kind="database"><div class="marxen-database"></div><details class="marxen-source"><pre><code></code></pre></details></div>`;
  root.querySelector("code")!.textContent = source;
  document.body.append(root);
  return root;
}

describe("hydrateDatabases", () => {
  it("explains how to enable the view when no viewer is given", async () => {
    const root = mount("folder: tasks");
    await hydrateDatabases(root, undefined);
    expect(root.querySelector(".marxen-database")?.textContent).toContain("データベース表示を有効にする");
  });

  it("draws note rows and sends cell edits, row adds and note opens", async () => {
    const root = mount("folder: tasks");
    const viewer = { query: vi.fn().mockResolvedValue(table), edit: vi.fn().mockResolvedValue(table), openNote: vi.fn() };
    await hydrateDatabases(root, viewer);
    expect(viewer.query).toHaveBeenCalledWith({ kind: "folder", path: "tasks" });
    const inputs = root.querySelectorAll<HTMLInputElement>("input.marxen-database-input");
    expect([...inputs].map((input) => input.value)).toEqual(["todo", ""]);

    inputs[1].value = "done";
    inputs[1].dispatchEvent(new Event("change"));
    expect(viewer.edit).toHaveBeenCalledWith({ kind: "folder", path: "tasks" }, { kind: "setCell", id: "tasks/b.md", column: "status", value: "done" });

    root.querySelector<HTMLButtonElement>(".marxen-database-link")!.click();
    expect(viewer.openNote).toHaveBeenCalledWith("tasks/a.md");
    [...root.querySelectorAll<HTMLButtonElement>(".marxen-database-toolbar button")][0].click();
    expect(viewer.edit).toHaveBeenLastCalledWith({ kind: "folder", path: "tasks" }, { kind: "addRow" });
  });

  it("keeps cell keys away from the surrounding editor", async () => {
    const root = mount("sqlite: a.db");
    const viewer = { query: vi.fn().mockResolvedValue({ ...table, rows: [{ id: "1", cells: { status: "x" }, path: null }] }), edit: vi.fn() };
    const outer = vi.fn();
    root.addEventListener("keydown", outer);
    await hydrateDatabases(root, viewer);
    root.querySelector("input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }));
    expect(outer).not.toHaveBeenCalled();
  });

  it("shows a load failure next to the block", async () => {
    const root = mount("folder: missing");
    await hydrateDatabases(root, { query: vi.fn().mockRejectedValue(new Error("NotFound")), edit: vi.fn() });
    expect(root.querySelector("[role=alert]")?.textContent).toContain("NotFound");
  });
});
