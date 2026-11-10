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

  it("rejects missing, doubled or non-database sources", () => {
    expect(parseDatabaseBlock("").ok).toBe(false);
    expect(parseDatabaseBlock("folder: a\nsqlite: b.db").ok).toBe(false);
    expect(parseDatabaseBlock("sqlite: notes.md").ok).toBe(false);
  });
});
