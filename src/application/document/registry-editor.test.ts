import { describe, expect, it, vi } from "vitest";
import { RegistryClient } from "./registry-client";
import { workspaceApi } from "../../infrastructure/tauri/workspace-api";
import { applyTextEdits } from "../../domain/coordinates/utf16";
import { StaleResync } from "../../domain/document-errors";
import type { CursorUpdate, DocumentSnapshot, EditorContext, VimInputResult, VimMode } from "../../contracts/contracts";

/** Create a mutable native transport fixture that records edit/cursor/key execution order. */
function fixture(text = "prose", mode: VimMode = "insert", mapped = false) {
  let current: DocumentSnapshot = { documentId: "doc", revision: 4, text, dirty: false };
  let cursor: CursorUpdate = { documentId: "doc", revision: 4, anchor: text.length, head: text.length };
  const events: string[] = [];
  const transport = {
    ...workspaceApi,
    /** Read actual fixture mode at its live revision. */
    fetchMode: vi.fn(async () => ({ documentId: "doc", revision: current.revision, mode })),
    /** Query actual fixture mapping priority. */
    hasMapping: vi.fn(async () => mapped),
    /** Read the cursor installed by the previous queued GUI commit. */
    fetchCursor: vi.fn(async () => ({ ...cursor, revision: current.revision })),
    /** Apply revision-bound UTF16 edits and record their order. */
    applyEdits: vi.fn(async (request, edits) => { expect(request.baseRevision).toBe(current.revision); events.push(`edit:${request.baseRevision}`); current = { ...current, text: applyTextEdits(current.text, edits), revision: current.revision + 1 }; return current; }),
    /** Record the revision-bound cursor acknowledgement. */
    reportCursor: vi.fn(async (update: CursorUpdate) => { expect(update.revision).toBe(current.revision); events.push(`cursor:${update.head}@${update.revision}`); cursor = update; return cursor; }),
    /** Record native key input at execution revision. */
    inputWithCopy: vi.fn(async (request, keys): Promise<VimInputResult> => { expect(request.baseRevision).toBe(current.revision); events.push(`key:${keys}@${request.baseRevision}`); return { snapshot: current, copyReady: false, copy: null }; }),
    /** Re-read drifted state for stale rejection assertions. */
    fetchSnapshot: vi.fn(async () => current),
  } satisfies typeof workspaceApi;
  const client = new RegistryClient(transport);
  client.noteSnapshot(current);
  return { client, transport, events,
    /** Read final authoritative fixture text. */
    text: () => current.text,
  };
}

describe("serialized editor Enter and table navigation", () => {
  it("selects authoritative Unicode source through the native cursor operation", async () => {
    const { client, transport } = fixture("日😀");
    const context: EditorContext = { cursor: { documentId: "doc", revision: 4, anchor: 3, head: 3 }, mode: "insert", presentation: { editable: true, selectionToolbar: false, mappings: [] } };
    transport.fetchEditorContext = vi.fn(async () => context);
    expect(await client.selectAll(context)).toEqual({ documentId: "doc", revision: 4, anchor: 0, head: 3 });
    expect(transport.reportCursor).toHaveBeenCalledExactlyOnceWith({ documentId: "doc", revision: 4, anchor: 0, head: 3 });
    expect(transport.inputWithCopy).not.toHaveBeenCalled(); expect(transport.applyEdits).not.toHaveBeenCalled();
  });
  it.each(["visual_block", "command_line", "terminal"] as const)("rejects native Select All in %s mode and after selection drift", async (mode) => {
    const { client, transport } = fixture();
    const expected: EditorContext = { cursor: { documentId: "doc", revision: 4, anchor: 0, head: 2 }, mode: "insert", presentation: { editable: true, selectionToolbar: false, mappings: [] } };
    transport.fetchEditorContext = vi.fn(async () => ({ ...expected, mode }));
    await expect(client.selectAll(expected)).rejects.toThrow();
    transport.fetchEditorContext = vi.fn(async () => ({ ...expected, cursor: { ...expected.cursor, head: 3 } }));
    await expect(client.selectAll(expected)).rejects.toThrow();
    expect(transport.reportCursor).not.toHaveBeenCalled();
  });
  it("rejects Select All after an earlier queued edit changes its captured revision", async () => {
    const { client, transport } = fixture("日😀");
    const context: EditorContext = { cursor: { documentId: "doc", revision: 4, anchor: 0, head: 3 }, mode: "insert", presentation: { editable: true, selectionToolbar: false, mappings: [] } };
    await client.applyGuiEdits({ documentId: "doc", baseRevision: 4 }, "日😀", [{ range: { start: 3, end: 3 }, text: "new" }]);
    await expect(client.selectAll(context)).rejects.toBeInstanceOf(StaleResync);
    expect(transport.reportCursor).not.toHaveBeenCalled();
  });
  it("installs GUI and hard-break cursors before native Enter at their actual revisions", async () => {
    const { client, events, text } = fixture("日😀");
    const gui = client.applyGuiEdits({ documentId: "doc", baseRevision: 4 }, "日😀", [{ range: { start: 3, end: 3 }, text: "本文" }], { anchor: 5, head: 5 });
    const enter = client.routeEditorEnter("doc", true, false, vi.fn());
    await Promise.all([gui, enter]);
    expect(text()).toBe("日😀本文  ");
    expect(events).toEqual(["edit:4", "cursor:5@5", "edit:5", "cursor:7@6", "key:<CR>@6"]);
  });
  it.each(["normal", "replace", "visual"] as const)("keeps %s Enter native", async (mode) => {
    const { client, transport, events } = fixture("prose", mode);
    await client.routeEditorEnter("doc", true, false, vi.fn());
    expect(events).toEqual(["key:<CR>@4"]);
    expect(transport.fetchCursor).not.toHaveBeenCalled();
  });
  it.each(["", "    code", "```ts\ncode", "# heading"])("does not add spaces after %j", async (text) => {
    const { client, events } = fixture(text);
    await client.routeEditorEnter("doc", true, false, vi.fn());
    expect(events).toEqual(["key:<CR>@4"]);
  });
  it("preserves selected replacement and a disabled/plain-text preference", async () => {
    for (const [enabled, selected] of [[true, true], [false, false]]) {
      const { client, events } = fixture();
      await client.routeEditorEnter("doc", enabled, selected, vi.fn());
      expect(events).toEqual(["key:<CR>@4"]);
    }
  });
  it("preserves mid-line Enter and actual Insert mappings", async () => {
    const mid = fixture();
    mid.transport.fetchCursor.mockResolvedValue({ documentId: "doc", revision: 4, anchor: 2, head: 2 });
    await mid.client.routeEditorEnter("doc", true, false, vi.fn());
    expect(mid.events).toEqual(["key:<CR>@4"]);
    const mapped = fixture("prose", "insert", true);
    await mapped.client.routeEditorEnter("doc", true, false, vi.fn());
    expect(mapped.events).toEqual(["key:<CR>@4"]);
    expect(mapped.transport.fetchCursor).not.toHaveBeenCalled();
  });
  it("rejects stale actual mode/cursor before modifying or sending Enter", async () => {
    const { client, transport, events } = fixture();
    transport.fetchCursor.mockResolvedValue({ documentId: "doc", revision: 5, anchor: 5, head: 5 });
    await expect(client.routeEditorEnter("doc", true, false, vi.fn())).rejects.toBeInstanceOf(StaleResync);
    expect(events).toEqual([]);
  });
  it("navigates source cells only when Insert Tab is unmapped", async () => {
    const text = "| A | B |\n| --- | --- |\n| A\\|B | `x|y` |";
    const plain = fixture(text);
    const result = await plain.client.routeTableTab("doc", false, text.indexOf(" A |"), text);
    expect(result).toHaveProperty("cursor.head", text.indexOf("B"));
    expect(plain.transport.inputWithCopy).not.toHaveBeenCalled();
    const mapped = fixture(text, "insert", true);
    await mapped.client.routeTableTab("doc", false, 0, text);
    expect(mapped.events).toEqual(["key:<Tab>@4"]);
  });
  it("rejects a context-menu action after a newer queued edit", async () => {
    const { client, transport } = fixture();
    await client.applyGuiEdits({ documentId: "doc", baseRevision: 4 }, "prose", [{ range: { start: 5, end: 5 }, text: "new" }]);
    await expect(client.editorAction({ documentId: "doc", revision: 4, anchor: 0, head: 2 }, "cut")).rejects.toBeInstanceOf(StaleResync);
    expect(transport.fetchSnapshot).toHaveBeenCalledOnce();
  });
  it("forwards the native selection guard and installs the formatting caret in the same task", async () => {
    const { client, transport, events } = fixture("abc");
    const cursor = { documentId: "doc", revision: 4, anchor: 0, head: 3 };
    expect((await client.formatEditorSelection(cursor, "abc", "bold")).text).toBe("**abc**");
    expect(transport.applyEdits).toHaveBeenCalledWith({ documentId: "doc", baseRevision: 4 }, [{ range: { start: 0, end: 3 }, text: "**abc**" }], cursor);
    expect(events).toEqual(["edit:4", "cursor:7@5"]);
  });
  it("keeps a mapped Tab copy side effect inside the native queue before later keys", async () => {
    const { client, transport, events } = fixture("prose", "insert", true);
    let release!: () => void;
    transport.inputWithCopy.mockResolvedValueOnce({ snapshot: { documentId: "doc", revision: 4, text: "prose", dirty: false }, copyReady: false, copy: { format: "markdown", text: "copied" } });
    /** Hold clipboard publication to prove that subsequent keys stay queued. */
    const copy = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const tab = client.routeTableTab("doc", false, 0, "prose", copy);
    const next = client.vimInputWithCopy("doc", "<Esc>", vi.fn());
    await vi.waitFor(() => expect(copy).toHaveBeenCalledOnce());
    expect(events).toEqual([]);
    release();
    await Promise.all([tab, next]);
    expect(events).toEqual(["key:<Esc>@4"]);
  });
  it("uses the acknowledged native caret for Tab following a captured GUI input burst", async () => {
    const source = "| A | B |\n| --- | --- |\n| a | b |";
    const { client, events } = fixture(source);
    const gui = client.applyGuiEdits({ documentId: "doc", baseRevision: 4 }, source, [{ range: { start: 3, end: 3 }, text: "x" }], { anchor: 4, head: 4 });
    const tab = client.routeTableTab("doc", false, 3, source);
    await gui;
    expect(await tab).toHaveProperty("cursor.head", source.indexOf("B") + 1);
    expect(events).toEqual(["edit:4", "cursor:4@5", "cursor:7@5"]);
  });
});
