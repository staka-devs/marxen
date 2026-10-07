import { describe, expect, it, vi } from "vitest";
import { CompositionGate, READONLY_MESSAGE, ReadonlyTransport } from "./document-client";
import { applyTextEdits } from "./utf16";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: () => false }));

describe("readonly transport never simulates authority", () => {
  it("rejects mutations and saves in the browser demo", async () => {
    const transport = new ReadonlyTransport();
    await expect(transport.applyGuiEdits("doc-1", 0, [{ range: { start: 0, end: 0 }, text: "x" }])).rejects.toThrow(
      READONLY_MESSAGE,
    );
    await expect(transport.saveDocument("doc-1", 0)).rejects.toThrow(READONLY_MESSAGE);
    await expect(transport.undoDocument()).rejects.toThrow(READONLY_MESSAGE);
  });

  it("keeps range-apply pure and reversible without a fake actor", () => {
    const base = "hello";
    const edited = applyTextEdits(base, [{ range: { start: 5, end: 5 }, text: " world" }]);
    expect(edited).toBe("hello world");
    // Inverse range returns to the source (Undo sharing itself stays in real Neovim).
    expect(applyTextEdits(edited, [{ range: { start: 5, end: 11 }, text: "" }])).toBe(base);
  });
});

describe("composition gate commits once", () => {
  it("buffers preedit and commits a single edit", () => {
    const gate = new CompositionGate();
    gate.start();
    expect(gate.offer([{ range: { start: 5, end: 5 }, text: "にほんご" }])).toBeNull();
    const committed = gate.commit([{ range: { start: 5, end: 9 }, text: "日本語" }]);
    expect(committed).toEqual([{ range: { start: 5, end: 9 }, text: "日本語" }]);
    expect(gate.isComposing).toBe(false);
  });
});
