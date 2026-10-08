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
    const first = client.vimInput("doc_1", "j");
    const second = client.vimInput("doc_1", "k");
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
    // The second burst binds the acknowledged revision at execution time.
    expect(mockedInvoke).toHaveBeenNthCalledWith(2, "nvim_input", { documentId: "doc_1", baseRevision: 1, keys: "k" });
    gates[1]();
    await second;
  });

  it("binds native burst revisions at queue execution with delayed ACK", async () => {
    const client = new RegistryClient();
    client.noteSnapshot(snapshot("doc_1", 0, ""));
    const releases: Array<() => void> = [];
    const seen: number[] = [];
    mockedInvoke.mockImplementation((_command: string, args?: unknown) => {
      const revision = (args as { baseRevision: number }).baseRevision;
      seen.push(revision);
      return new Promise((resolve) => {
        releases.push(() => resolve(snapshot("doc_1", revision + 1, `r${revision}`)));
      });
    });
    const first = client.vimInput("doc_1", "g");
    const second = client.vimInput("doc_1", "g");
    const third = client.vimInput("doc_1", "i");
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toEqual([0]);
    releases[0]();
    const r1 = await first;
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toEqual([0, 1]);
    releases[1]();
    const r2 = await second;
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toEqual([0, 1, 2]);
    releases[2]();
    const r3 = await third;
    expect([r1.revision, r2.revision, r3.revision]).toEqual([1, 2, 3]);
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

describe("execution-mode character routing", () => {
  let nativeMode = "insert";

  beforeEach(() => {
    nativeMode = "insert";
  });

  function installModeAware(handlers: (command: string, args?: unknown) => Promise<unknown>) {
    mockedInvoke.mockImplementation((command: string, args?: unknown) => {
      if (command === "fetch_mode") return Promise.resolve({ documentId: "doc_1", revision: 0, mode: nativeMode });
      return handlers(command, args);
    });
  }

  it("queries the mapping prefix then feeds claimed keys natively, in order", async () => {
    const client = new RegistryClient();
    installModeAware((command: string) => {
      if (command === "has_nvim_mapping") return Promise.resolve(true);
      if (command === "nvim_input") return Promise.resolve(snapshot("doc_1", 1, "x"));
      throw new Error(`unexpected ${command}`);
    });
    const decision = await client.routeCharKey("doc_1", "j", { start: 0, end: 0 });
    expect(decision).toEqual({ action: "vim", snapshot: snapshot("doc_1", 1, "x") });
    const order = mockedInvoke.mock.calls.map(([command]) => command);
    expect(order).toEqual(["fetch_mode", "has_nvim_mapping", "nvim_input"]);
    expect(mockedInvoke).toHaveBeenNthCalledWith(2, "has_nvim_mapping", { documentId: "doc_1", mode: "i", lhs: "j" });
    expect(mockedInvoke).toHaveBeenNthCalledWith(3, "nvim_input", { documentId: "doc_1", baseRevision: 0, keys: "j" });
  });

  it("keeps the queue-owned pending prefix so multi-key mappings keep priority", async () => {
    const client = new RegistryClient();
    installModeAware((command: string) => {
      if (command === "has_nvim_mapping") return Promise.resolve(true);
      return Promise.resolve(snapshot("doc_1", 2, "x"));
    });
    await client.routeCharKey("doc_1", "j", { start: 0, end: 0 });
    await client.routeCharKey("doc_1", "j", { start: 1, end: 1 });
    expect(mockedInvoke).toHaveBeenNthCalledWith(2, "has_nvim_mapping", { documentId: "doc_1", mode: "i", lhs: "j" });
    expect(mockedInvoke).toHaveBeenNthCalledWith(5, "has_nvim_mapping", { documentId: "doc_1", mode: "i", lhs: "jj" });
  });

  it("replaces the exact selected range for unclaimed keys", async () => {
    const client = new RegistryClient();
    installModeAware((command: string) => {
      if (command === "has_nvim_mapping") return Promise.resolve(false);
      if (command === "apply_gui_edits") return Promise.resolve(snapshot("doc_1", 1, "ax"));
      throw new Error(`unexpected ${command}`);
    });
    const decision = await client.routeCharKey("doc_1", "a", { start: 2, end: 5 });
    expect(decision).toEqual({ action: "gui", snapshot: snapshot("doc_1", 1, "ax") });
    expect(mockedInvoke).toHaveBeenCalledWith("apply_gui_edits", {
      documentId: "doc_1",
      baseRevision: 0,
      edits: [{ range: { start: 2, end: 5 }, text: "a" }],
    });
    expect(mockedInvoke).not.toHaveBeenCalledWith("nvim_input", expect.anything());
  });

  it("feeds keys natively when the actual mode is visual, never appending GUI chars", async () => {
    const client = new RegistryClient();
    nativeMode = "visual";
    installModeAware((command: string) => {
      if (command === "nvim_input") return Promise.resolve(snapshot("doc_1", 1, "x"));
      throw new Error(`unexpected ${command}`);
    });
    const decision = await client.routeCharKey("doc_1", "x", { start: 2, end: 7 });
    expect(decision.action).toBe("vim");
    expect(mockedInvoke).toHaveBeenCalledWith("nvim_input", { documentId: "doc_1", baseRevision: 0, keys: "x" });
    expect(mockedInvoke.mock.calls.filter(([command]) => command === "has_nvim_mapping")).toHaveLength(0);
    expect(mockedInvoke.mock.calls.filter(([command]) => command === "apply_gui_edits")).toHaveLength(0);
  });

  it("feeds keys natively when the actual mode is normal despite an insert hint", async () => {
    const client = new RegistryClient();
    nativeMode = "normal";
    installModeAware((command: string) => {
      if (command === "nvim_input") return Promise.resolve(snapshot("doc_1", 1, "x"));
      throw new Error(`unexpected ${command}`);
    });
    const decision = await client.routeCharKey("doc_1", "g", { start: 0, end: 0 });
    expect(decision.action).toBe("vim");
    expect(mockedInvoke).toHaveBeenCalledWith("nvim_input", { documentId: "doc_1", baseRevision: 0, keys: "g" });
  });

  it("keeps bursts ordered against execution-time revisions", async () => {
    const client = new RegistryClient();
    let revision = 0;
    installModeAware((command: string, args?: unknown) => {
      const a = (args ?? {}) as { edits?: Array<{ range: { start: number; end: number }; text: string }> };
      if (command === "has_nvim_mapping") return Promise.resolve(false);
      if (command === "apply_gui_edits") {
        revision += 1;
        const edit = a.edits![0];
        return Promise.resolve(snapshot("doc_1", revision, `<${edit.range.start}-${edit.range.end}${edit.text}>`));
      }
      throw new Error(`unexpected ${command}`);
    });
    const results = await Promise.all([
      client.routeCharKey("doc_1", "a", { start: 0, end: 0 }),
      client.routeCharKey("doc_1", "b", { start: 1, end: 1 }),
      client.routeCharKey("doc_1", "c", { start: 2, end: 2 }),
    ]);
    expect(results.map((result) => result.snapshot.revision)).toEqual([1, 2, 3]);
    const bases = mockedInvoke.mock.calls
      .filter(([command]) => command === "apply_gui_edits")
      .map(([, args]) => (args as { baseRevision: number }).baseRevision);
    expect(bases).toEqual([0, 1, 2]);
  });

  it("fails closed without a GUI edit when the mapping state is unreadable", async () => {
    const client = new RegistryClient();
    installModeAware((command: string) => {
      if (command === "has_nvim_mapping") return Promise.reject(new Error("rpc down"));
      if (command === "apply_gui_edits") return Promise.resolve(snapshot("doc_1", 1, "a"));
      throw new Error(`unexpected ${command}`);
    });
    await expect(client.routeCharKey("doc_1", "a", { start: 0, end: 0 })).rejects.toThrow("rpc down");
    expect(mockedInvoke.mock.calls.filter(([command]) => command === "apply_gui_edits")).toHaveLength(0);
  });

  it("fails closed without feeding when the mode query is unreadable", async () => {
    const client = new RegistryClient();
    mockedInvoke.mockImplementation((command: string) => {
      if (command === "fetch_mode") return Promise.reject(new Error("mode down"));
      throw new Error(`unexpected ${command}`);
    });
    await expect(client.routeCharKey("doc_1", "a", { start: 0, end: 0 })).rejects.toThrow("mode down");
    expect(mockedInvoke.mock.calls.filter(([command]) => command === "apply_gui_edits")).toHaveLength(0);
    expect(mockedInvoke.mock.calls.filter(([command]) => command === "nvim_input")).toHaveLength(0);
  });

  it("resyncs instead of duplicating when the base went stale", async () => {
    const client = new RegistryClient();
    mockedInvoke.mockImplementationOnce(() => Promise.resolve({ documentId: "doc_1", revision: 3, mode: "insert" }));
    mockedInvoke.mockResolvedValueOnce(true);
    mockedInvoke.mockRejectedValueOnce({ code: "contract", error: { code: "stale_revision", expected: 4, received: 3 } });
    mockedInvoke.mockResolvedValueOnce(snapshot("doc_1", 4, "latest"));
    const failure = await client.routeCharKey("doc_1", "j", { start: 0, end: 0 }).then(
      () => null,
      (cause: unknown) => cause,
    );
    expect(failure).toBeInstanceOf(StaleResync);
    expect(mockedInvoke).toHaveBeenCalledWith("fetch_snapshot", { documentId: "doc_1" });
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

  it("normalizes named keys before modifiers", () => {
    expect(serializeVimKey({ key: "ArrowUp", ctrlKey: true })).toBe("<C-Up>");
    expect(serializeVimKey({ key: "ArrowDown", ctrlKey: true })).toBe("<C-Down>");
    expect(serializeVimKey({ key: "ArrowLeft", ctrlKey: true })).toBe("<C-Left>");
    expect(serializeVimKey({ key: "ArrowRight", ctrlKey: true })).toBe("<C-Right>");
    expect(serializeVimKey({ key: "Home", ctrlKey: true })).toBe("<C-Home>");
    expect(serializeVimKey({ key: "End", ctrlKey: true })).toBe("<C-End>");
    expect(serializeVimKey({ key: "F5", ctrlKey: true })).toBe("<C-F5>");
    expect(serializeVimKey({ key: "Enter", ctrlKey: true })).toBe("<C-CR>");
    expect(serializeVimKey({ key: "Escape", ctrlKey: true })).toBe("<C-Esc>");
    expect(serializeVimKey({ key: "ArrowLeft", altKey: true })).toBe("<M-Left>");
    expect(serializeVimKey({ key: "Enter", altKey: true })).toBe("<M-CR>");
  });

  it("leaves platform IME and composition keys to the OS", () => {
    // Actual Windows native Alt+backquote emits key=KanjiMode: returning null
    // keeps the real IME toggle alive and feeds no invalid Vim text.
    expect(serializeVimKey({ key: "KanjiMode" })).toBeNull();
    expect(serializeVimKey({ key: "KanjiMode", altKey: true })).toBeNull();
    expect(serializeVimKey({ key: "KanjiMode", ctrlKey: true })).toBeNull();
    for (const key of ["Convert", "NonConvert", "Hiragana", "Katakana", "Zenkaku", "Hankaku", "Alphanumeric", "ModeChange"]) {
      expect(serializeVimKey({ key })).toBeNull();
      expect(serializeVimKey({ key, altKey: true })).toBeNull();
    }
    expect(serializeVimKey({ key: "Process" })).toBeNull();
    expect(serializeVimKey({ key: "Dead" })).toBeNull();
    expect(serializeVimKey({ key: "Unidentified" })).toBeNull();
  });
});

describe("clipboard paste respects explicit mappings", () => {
  let nativeMode = "insert";

  beforeEach(() => {
    nativeMode = "insert";
  });

  function installPaste(handlers: (command: string, args?: unknown) => Promise<unknown>) {
    mockedInvoke.mockImplementation((command: string, args?: unknown) => {
      if (command === "fetch_mode") return Promise.resolve({ documentId: "doc_1", revision: 0, mode: nativeMode });
      return handlers(command, args);
    });
  }

  it("feeds a mapped Ctrl+V natively without inserting text", async () => {
    const client = new RegistryClient();
    installPaste((command: string) => {
      if (command === "has_nvim_mapping") return Promise.resolve(true);
      if (command === "nvim_input") return Promise.resolve(snapshot("doc_1", 1, "x"));
      throw new Error(`unexpected ${command}`);
    });
    const decision = await client.routeCapturedPaste("doc_1", "<C-v>", "貼付😀\n2行目", { start: 0, end: 0 });
    expect(decision.action).toBe("vim");
    expect(mockedInvoke).toHaveBeenNthCalledWith(2, "has_nvim_mapping", { documentId: "doc_1", mode: "i", lhs: "<C-v>" });
    expect(mockedInvoke).toHaveBeenNthCalledWith(3, "nvim_input", { documentId: "doc_1", baseRevision: 0, keys: "<C-v>" });
    expect(mockedInvoke.mock.calls.filter(([command]) => command === "apply_gui_edits")).toHaveLength(0);
  });

  it("replaces the exact selected range for unmapped text", async () => {
    const client = new RegistryClient();
    installPaste((command: string, args?: unknown) => {
      if (command === "has_nvim_mapping") return Promise.resolve(false);
      if (command === "apply_gui_edits") {
        const a = args as { baseRevision: number; edits: Array<{ range: { start: number; end: number }; text: string }> };
        return Promise.resolve(snapshot("doc_1", a.baseRevision + 1, `[${a.edits[0].range.start}-${a.edits[0].range.end}]`));
      }
      throw new Error(`unexpected ${command}`);
    });
    const decision = await client.routeCapturedPaste("doc_1", "<C-v>", "日本語😀\n2行目", { start: 3, end: 8 });
    expect(decision.action).toBe("gui");
    expect(mockedInvoke).toHaveBeenCalledWith("apply_gui_edits", {
      documentId: "doc_1",
      baseRevision: 0,
      edits: [{ range: { start: 3, end: 8 }, text: "日本語😀\n2行目" }],
    });
  });

  it("inserts context-menu captures directly without a mapping query", async () => {
    const client = new RegistryClient();
    installPaste((command: string, args?: unknown) => {
      if (command === "apply_gui_edits") {
        const a = args as { baseRevision: number };
        return Promise.resolve(snapshot("doc_1", a.baseRevision + 1, "menu"));
      }
      throw new Error(`unexpected ${command}`);
    });
    const decision = await client.routeCapturedPaste("doc_1", null, "メニュー", { start: 2, end: 2 });
    expect(decision.action).toBe("gui");
    expect(mockedInvoke.mock.calls.filter(([command]) => command === "has_nvim_mapping")).toHaveLength(0);
    expect(mockedInvoke).toHaveBeenCalledWith(
      "apply_gui_edits",
      expect.objectContaining({ documentId: "doc_1", edits: [{ range: { start: 2, end: 2 }, text: "メニュー" }] }),
    );
  });

  it("fails closed without an insert when a keyboard mapping query is unreadable", async () => {
    const client = new RegistryClient();
    installPaste((command: string) => {
      if (command === "has_nvim_mapping") return Promise.reject(new Error("rpc down"));
      throw new Error(`unexpected ${command}`);
    });
    await expect(client.routeCapturedPaste("doc_1", "<C-v>", "x", { start: 0, end: 0 })).rejects.toThrow("rpc down");
    expect(mockedInvoke.mock.calls.filter(([command]) => command === "apply_gui_edits")).toHaveLength(0);
    expect(mockedInvoke.mock.calls.filter(([command]) => command === "nvim_input")).toHaveLength(0);
  });
});

describe("cursor reporting stays serial without feedback", () => {
  it("coalesces rapid selections to a single latest report", async () => {
    const client = new RegistryClient();
    client.noteSnapshot(snapshot("doc_1", 5, "hello"));
    mockedInvoke.mockResolvedValue({ documentId: "doc_1", revision: 5, anchor: 4, head: 4 });
    const first = client.stageCursor("doc_1", 1, 1);
    const second = client.stageCursor("doc_1", 4, 4);
    const [r1, r2] = await Promise.all([first, second]);
    const reports = mockedInvoke.mock.calls.filter(([command]) => command === "report_cursor");
    expect(reports).toHaveLength(1);
    expect(reports[0][1]).toMatchObject({ documentId: "doc_1", revision: 5, anchor: 4, head: 4 });
    // The first task consumes the coalesced latest; the second finds nothing.
    expect(r1).toMatchObject({ anchor: 4, head: 4 });
    expect(r2).toBeNull();
  });

  it("reports jumps at the execution revision", async () => {
    const client = new RegistryClient();
    client.noteSnapshot(snapshot("doc_1", 7, "hello world"));
    mockedInvoke.mockResolvedValue({ documentId: "doc_1", revision: 7, anchor: 0, head: 5 });
    const cursor = await client.reportCursorNow("doc_1", 0, 5);
    expect(mockedInvoke).toHaveBeenCalledWith("report_cursor", { documentId: "doc_1", revision: 7, anchor: 0, head: 5 });
    expect(cursor).toMatchObject({ anchor: 0, head: 5 });
  });

  it("preserves a noncollapsed mouse anchor instead of collapsing to head", async () => {
    const client = new RegistryClient();
    client.noteSnapshot(snapshot("doc_1", 3, "hello world"));
    mockedInvoke.mockResolvedValue({ documentId: "doc_1", revision: 3, anchor: 2, head: 7 });
    const cursor = await client.reportCursorNow("doc_1", 2, 7);
    expect(mockedInvoke).toHaveBeenCalledWith("report_cursor", { documentId: "doc_1", revision: 3, anchor: 2, head: 7 });
    expect(cursor.anchor).toBe(2);
    expect(cursor.head).toBe(7);
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
    await expect(transport.vimInput("doc_1", "j")).rejects.toThrow(READONLY_MESSAGE);
    await expect(transport.routeCharKey("doc_1", "a", { start: 0, end: 0 })).rejects.toThrow(READONLY_MESSAGE);
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
