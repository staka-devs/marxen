import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  CompositionGate,
  READONLY_MESSAGE,
  ReadonlyRegistry,
  RegistryClient,
  StaleResync,
  isStaleError,
  serializeVimKey,
  workspaceErrorText,
} from "./document-client";
import type { DocumentSnapshot } from "../shared/contracts";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: () => true }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const mockedInvoke = vi.mocked(invoke);

function snapshot(documentId: string, revision: number, text: string, dirty = true): DocumentSnapshot {
  return { documentId, revision, text, dirty };
}

beforeEach(() => vi.resetAllMocks());

describe("registry client sends revision-aware requests", () => {
  it("passes document IDs and base revisions through unchanged", async () => {
    const client = new RegistryClient();
    mockedInvoke.mockResolvedValueOnce(snapshot("doc_abc", 4, "hi"));
    const next = await client.applyEdits({ documentId: "doc_abc", baseRevision: 3 }, [
      { range: { start: 2, end: 2 }, text: "!" },
    ]);
    expect(mockedInvoke).toHaveBeenCalledWith("apply_gui_edits", {
      documentId: "doc_abc",
      baseRevision: 3,
      edits: [{ range: { start: 2, end: 2 }, text: "!" }],
    });
    expect(next).toEqual(snapshot("doc_abc", 4, "hi"));
  });

  it("serializes Vim key input per document in call order", async () => {
    const client = new RegistryClient();
    const gates: Array<() => void> = [];
    mockedInvoke.mockImplementation(
      () =>
        new Promise((resolve) => {
          gates.push(() => resolve(snapshot("doc_1", 1, "x")));
        }),
    );
    const first = client.vimInput({ documentId: "doc_1", baseRevision: 0 }, "j");
    const second = client.vimInput({ documentId: "doc_1", baseRevision: 0 }, "k");
    await Promise.resolve();
    await Promise.resolve();
    // The second request must not reach IPC before the first completes.
    expect(mockedInvoke).toHaveBeenCalledTimes(1);
    expect(mockedInvoke).toHaveBeenNthCalledWith(1, "nvim_input", { documentId: "doc_1", baseRevision: 0, keys: "j" });
    gates[0]();
    await first;
    await Promise.resolve();
    await Promise.resolve();
    expect(mockedInvoke).toHaveBeenCalledTimes(2);
    expect(mockedInvoke).toHaveBeenNthCalledWith(2, "nvim_input", { documentId: "doc_1", baseRevision: 0, keys: "k" });
    gates[1]();
    await second;
  });

  it("resyncs stale revisions with the fresh snapshot instead of retrying", async () => {
    const client = new RegistryClient();
    mockedInvoke.mockRejectedValueOnce({ code: "contract", error: { code: "stale_revision", expected: 7, received: 5 } });
    mockedInvoke.mockResolvedValueOnce(snapshot("doc_1", 7, "latest"));
    const failure = await client
      .applyEdits({ documentId: "doc_1", baseRevision: 5 }, [{ range: { start: 0, end: 0 }, text: "x" }])
      .then(
        () => null,
        (cause: unknown) => cause,
      );
    expect(failure).toBeInstanceOf(StaleResync);
    expect((failure as StaleResync).snapshot).toEqual(snapshot("doc_1", 7, "latest"));
    expect(mockedInvoke).toHaveBeenCalledWith("fetch_snapshot", { documentId: "doc_1" });
  });

  it("keeps undo/redo/save on the native side with the same document ID", async () => {
    const client = new RegistryClient();
    mockedInvoke.mockResolvedValueOnce(snapshot("doc_9", 2, "a"));
    mockedInvoke.mockResolvedValueOnce(snapshot("doc_9", 3, "ab"));
    mockedInvoke.mockResolvedValueOnce({ documentId: "doc_9", revision: 3, dirty: false });
    await client.undo("doc_9");
    await client.redo("doc_9");
    await client.save({ documentId: "doc_9", baseRevision: 3 });
    expect(mockedInvoke).toHaveBeenNthCalledWith(1, "undo_document", { documentId: "doc_9" });
    expect(mockedInvoke).toHaveBeenNthCalledWith(2, "redo_document", { documentId: "doc_9" });
    expect(mockedInvoke).toHaveBeenNthCalledWith(3, "save_document", { documentId: "doc_9", baseRevision: 3 });
  });
});

describe("Vim key contract", () => {
  it("serializes normal/insert/visual/operator/command-line keys", () => {
    expect(serializeVimKey({ key: "j" })).toBe("j");
    expect(serializeVimKey({ key: "Escape" })).toBe("<Esc>");
    expect(serializeVimKey({ key: "Enter" })).toBe("<CR>");
    expect(serializeVimKey({ key: "Backspace" })).toBe("<BS>");
    expect(serializeVimKey({ key: "Tab" })).toBe("<Tab>");
    expect(serializeVimKey({ key: "Delete" })).toBe("<Del>");
    expect(serializeVimKey({ key: "ArrowUp" })).toBe("<Up>");
    expect(serializeVimKey({ key: "ArrowDown" })).toBe("<Down>");
    expect(serializeVimKey({ key: "ArrowLeft" })).toBe("<Left>");
    expect(serializeVimKey({ key: "ArrowRight" })).toBe("<Right>");
    expect(serializeVimKey({ key: "Home" })).toBe("<Home>");
    expect(serializeVimKey({ key: "End" })).toBe("<End>");
    expect(serializeVimKey({ key: "PageUp" })).toBe("<PageUp>");
    expect(serializeVimKey({ key: "PageDown" })).toBe("<PageDown>");
    expect(serializeVimKey({ key: "F5" })).toBe("<F5>");
    expect(serializeVimKey({ key: "F5", shiftKey: true })).toBe("<S-F5>");
    expect(serializeVimKey({ key: ":" })).toBe(":");
    expect(serializeVimKey({ key: " " })).toBe(" ");
  });

  it("serializes control keys and ignores pure modifiers", () => {
    expect(serializeVimKey({ key: "w", ctrlKey: true })).toBe("<C-w>");
    expect(serializeVimKey({ key: "[" , ctrlKey: true })).toBe("<C-[>");
    expect(serializeVimKey({ key: "x", altKey: true })).toBe("<M-x>");
    expect(serializeVimKey({ key: "Control" })).toBeNull();
    expect(serializeVimKey({ key: "Shift" })).toBeNull();
    expect(serializeVimKey({ key: "Alt" })).toBeNull();
    expect(serializeVimKey({ key: "Meta" })).toBeNull();
  });
});

describe("error shapes", () => {
  it("detects stale contract errors and keeps text on conflicts", () => {
    expect(isStaleError({ code: "contract", error: { code: "stale_revision", expected: 2, received: 1 } })).toBe(true);
    expect(isStaleError({ code: "contract", error: { code: "overlapping_edits" } })).toBe(false);
    expect(isStaleError(new Error("boom"))).toBe(false);
    expect(workspaceErrorText({ code: "conflict", path: "a.md" })).toContain("本文は保持");
  });
});

describe("readonly registry never simulates authority", () => {
  it("rejects mutations and saves in the browser demo", async () => {
    const transport = new ReadonlyRegistry();
    await expect(transport.applyEdits()).rejects.toThrow(READONLY_MESSAGE);
    await expect(transport.save()).rejects.toThrow(READONLY_MESSAGE);
    await expect(transport.undo()).rejects.toThrow(READONLY_MESSAGE);
    await expect(transport.vimInput()).rejects.toThrow(READONLY_MESSAGE);
  });
});

describe("composition gate commits once", () => {
  // Browser-level DOM plumbing only. Real TSF/NSTextInput/IBus behavior is
  // unverified here; see the report for the per-OS native checklist.
  it("buffers preedit and commits a single edit", () => {
    const gate = new CompositionGate();
    gate.start();
    expect(gate.offer([{ range: { start: 5, end: 5 }, text: "にほんご" }])).toBeNull();
    const committed = gate.commit([{ range: { start: 5, end: 9 }, text: "日本語" }]);
    expect(committed).toEqual([{ range: { start: 5, end: 9 }, text: "日本語" }]);
    expect(gate.isComposing).toBe(false);
  });
});
