import { describe, expect, it } from "vitest";
import { parseDatabaseBlock } from "./database-block";

describe("parseDatabaseBlock", () => {
  it("reads a folder source", () => {
    expect(parseDatabaseBlock("folder: tasks")).toEqual({ ok: true, source: { kind: "folder", path: "tasks" } });
    expect(parseDatabaseBlock("folder:")).toEqual({ ok: true, source: { kind: "folder", path: "" } });
  });

  it("reads a SQLite source with a default table", () => {
    expect(parseDatabaseBlock("sqlite: /data/tasks.db\n")).toEqual({ ok: true, source: { kind: "sqlite", path: "/data/tasks.db", table: "items" } });
    expect(parseDatabaseBlock("sqlite: a.sqlite\ntable: タスク")).toMatchObject({ source: { table: "タスク" } });
  });

  it("reads a board view grouped by a property", () => {
    expect(parseDatabaseBlock("folder: .\nview: board")).toMatchObject({ ok: true, board: "status" });
    expect(parseDatabaseBlock("sqlite: a.db\nview: Board\ngroup: 段階")).toMatchObject({ ok: true, board: "段階" });
    expect(parseDatabaseBlock("folder: .\ngroup: x")).not.toHaveProperty("board", "x");
  });

  it("rejects missing, doubled or non-database sources", () => {
    expect(parseDatabaseBlock("").ok).toBe(false);
    expect(parseDatabaseBlock("folder: a\nsqlite: b.db").ok).toBe(false);
    expect(parseDatabaseBlock("sqlite: notes.md").ok).toBe(false);
  });
});
