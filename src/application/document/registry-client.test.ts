import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  ReadonlyRegistry,
  RegistryClient,
} from "./registry-client";
import { workspaceApi } from "../../infrastructure/tauri/workspace-api";
import { CompositionGate } from "./composition-gate";
import {
  READONLY_MESSAGE,
  StaleResync,
  isStaleError,
  workspaceErrorText,
} from "../../domain/document-errors";
import { serializeVimKey } from "../../domain/vim-keys";
import { applySnapshot, docFromOpen } from "./document-helpers";
import type { DocumentSnapshot } from "../../contracts/contracts";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  /** Desktop transport flag for registry tests. */
  isTauri: () => true,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const mockedInvoke = vi.mocked(invoke);

/** Build a snapshot fixture for registry queue tests. */ function snapshot(documentId: string, revision: number, text: string, dirty = true): DocumentSnapshot {
  return { documentId, revision, text, dirty };
}

beforeEach(() => vi.resetAllMocks());

it("keeps a renamed view when an old-position snapshot arrives at the same text revision", () => {
  const scope = { rootId: "view-root", generation: "1" };
  const current = docFromOpen({ path: "new.md", snapshot: { ...snapshot("view", 4, "current"), location: { scope, path: "new.md", position: 2 } } });
  const late = { ...snapshot("view", 4, "old"), location: { scope, path: "old.md", position: 1 } };
  expect(applySnapshot(current, late)).toBe(current);
  expect(applySnapshot(current, { ...late, location: { scope: { ...scope, generation: "removed" }, path: "new.md", position: 3 } })).toBe(current);
});

it("rejects a queued save captured before a native rename without sending it to the new position", async () => {
  const client = new RegistryClient(workspaceApi);
  const scope = { rootId: "queue-root", generation: "1" };
  const initial = { ...snapshot("rename-queue", 4, "same", false), location: { scope, path: "old.md", position: 0 } };
  client.noteSnapshot(initial);
  let release!: (value: { path: string; snapshot: DocumentSnapshot }) => void;
  mockedInvoke.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
  const rename = client.rename({ documentId: initial.documentId, baseRevision: 4 }, "new.md");
  const save = client.save({ documentId: initial.documentId, baseRevision: 4 });
  const rejected = expect(save).rejects.toEqual({ code: "stale_location" });
  await vi.waitFor(() => expect(mockedInvoke).toHaveBeenCalledOnce());
  release({ path: "new.md", snapshot: { ...initial, location: { scope, path: "new.md", position: 1 } } });
  await rename; await rejected;
  expect(mockedInvoke).toHaveBeenCalledOnce();
});

it("keeps an operation's captured location while it awaits native reads", async () => {
  const client = new RegistryClient(workspaceApi);
  const scope = { rootId: "await-root", generation: "1" };
  const initial = { ...snapshot("await-owner", 0, "text", false), location: { scope, path: "old.md", position: 0 } };
  client.noteSnapshot(initial);
  let release!: (value: unknown) => void;
  mockedInvoke.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
  mockedInvoke.mockResolvedValueOnce({ ...initial, revision: 1 });
  const input = client.insertNativeText(initial.documentId, "x");
  await vi.waitFor(() => expect(mockedInvoke).toHaveBeenCalledOnce());
  client.noteSnapshot({ ...initial, location: { scope, path: "new.md", position: 1 } });
  release({ documentId: initial.documentId, revision: 0, mode: "insert" });
  await input;
  expect(mockedInvoke).toHaveBeenLastCalledWith("nvim_input", expect.objectContaining({ location: initial.location }));
});

it("rechecks a cancelled search guard when its edit reaches the native document queue", async () => {
  const client = new RegistryClient(workspaceApi);
  let release!: (value: DocumentSnapshot) => void;
  mockedInvoke.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
  let current = true;
  const earlier = client.applyEdits({ documentId: "search", baseRevision: 4 }, [{ range: { start: 0, end: 1 }, text: "a" }]);
  const queued = client.applyEdits({ documentId: "search", baseRevision: 5 }, [{ range: { start: 0, end: 1 }, text: "b" }], () => current);
  const rejected = expect(queued).rejects.toThrow("search context cancelled");
  await vi.waitFor(() => expect(mockedInvoke).toHaveBeenCalledOnce());
  current = false;
  release(snapshot("search", 5, "a"));
  await earlier; await rejected;
  expect(mockedInvoke).toHaveBeenCalledOnce();
});

it("serializes copy formatting and native writes before accepting the next key", async () => {
  const client = new RegistryClient(workspaceApi);
  let releaseCopy!: () => void;
  mockedInvoke.mockResolvedValue({ snapshot: snapshot("copy", 0, "source", false), copy: { format: "rich", text: "source" }, copyReady: false });
  /** Clipboard presentation hook for yank assertions. */ const onCopy = vi.fn(() => new Promise<void>((resolve) => { releaseCopy = resolve; }));
  const first = client.vimInputWithCopy("copy", "<F8>", onCopy);
  const second = client.vimInputWithCopy("copy", "j", vi.fn());
  await vi.waitFor(() => expect(onCopy).toHaveBeenCalledOnce());
  expect(mockedInvoke).toHaveBeenCalledOnce();
  releaseCopy();
  await first;
  await second;
  expect(mockedInvoke).toHaveBeenNthCalledWith(2, "nvim_input_with_copy", { documentId: "copy", baseRevision: 0, keys: "j" });
});

it("rejects a stale copy selector before writing the clipboard", async () => {
  const client = new RegistryClient(workspaceApi);
  mockedInvoke.mockRejectedValueOnce({ code: "contract", error: { code: "stale_revision", expected: 1, received: 0 } });
  mockedInvoke.mockResolvedValueOnce(snapshot("copy", 1, "fresh"));
  /** Clipboard presentation hook for yank assertions. */ const onCopy = vi.fn();
  await expect(client.vimInputWithCopy("copy", "<F6>", onCopy)).rejects.toBeInstanceOf(StaleResync);
  expect(onCopy).not.toHaveBeenCalled();
});

it("routes a printable copy selector using the queued native mode after an Insert to Normal burst", async () => {
  const client = new RegistryClient(workspaceApi);
  /** Clipboard presentation hook for yank assertions. */ const onCopy = vi.fn(async () => {});
  const keys: string[] = [];
  mockedInvoke.mockImplementation(async (command, args) => {
    if (command === "fetch_mode") return { mode: "normal", revision: 0 };
    if (command === "nvim_input_with_copy") {
      keys.push(String((args as { keys: string }).keys));
      return { snapshot: snapshot("copy", 0, "source", false), copyReady: keys.length === 3,
        copy: keys.length === 4 ? { format: "markdown", text: "source\n" } : null };
    }
    throw new Error(`Unexpected ${command}`);
  });
  const results = await Promise.all(["<Esc>", "y", "y", "m"].map(key => client.routeCharKey("copy", key, { start: 0, end: 0 }, onCopy)));
  expect(keys).toEqual(["<Esc>", "y", "y", "m"]);
  expect(onCopy).toHaveBeenCalledExactlyOnceWith({ format: "markdown", text: "source\n" });
  expect(results.at(-1)).toMatchObject({ action: "vim", copyReady: false });
});

describe("registry client sends revision-aware requests", () => {
  it("commits a delayed Unicode burst with exact source continuity, cursor order, Enter, and Undo", async () => {
    const client = new RegistryClient(workspaceApi);
    const initial = "abc\nx本文です\n";
    client.noteSnapshot(snapshot("doc_1", 0, initial));
    let text = initial;
    let revision = 0;
    let head = 5;
    const releases: Array<() => void> = [];
    const history = [text];
    mockedInvoke.mockImplementation((command, args) => {
      const a = args as { baseRevision?: number; edits?: Array<{ range: { start: number; end: number }; text: string }>; head?: number; keys?: string };
      if (command === "apply_gui_edits") {
        expect(a.baseRevision).toBe(revision);
        const edit = a.edits![0];
        text = text.slice(0, edit.range.start) + edit.text + text.slice(edit.range.end);
        revision += 1;
        history.push(text);
        const ack = snapshot("doc_1", revision, text);
        return new Promise((resolve) => releases.push(() => resolve(ack)));
      }
      if (command === "report_cursor") {
        expect(a.head).toBeLessThanOrEqual(text.length);
        head = a.head!;
        return Promise.resolve({ documentId: "doc_1", revision, anchor: head, head });
      }
      if (command === "nvim_input") {
        expect(a.keys).toBe("<CR>");
        expect(head).toBe(8);
        text = text.slice(0, head) + "\n" + text.slice(head);
        revision += 1;
        return Promise.resolve(snapshot("doc_1", revision, text));
      }
      if (command === "undo_document") {
        text = history.at(-1)!;
        revision += 1;
        return Promise.resolve(snapshot("doc_1", revision, text));
      }
      throw new Error(`unexpected ${command}`);
    });
    const first = client.applyGuiEdits({ documentId: "doc_1", baseRevision: 0 }, initial, [{ range: { start: 5, end: 5 }, text: "日" }], { anchor: 6, head: 6 });
    const second = client.applyGuiEdits({ documentId: "doc_1", baseRevision: 0 }, "abc\nx日本文です\n", [{ range: { start: 6, end: 6 }, text: "本" }], { anchor: 7, head: 7 });
    const third = client.applyGuiEdits({ documentId: "doc_1", baseRevision: 0 }, "abc\nx日本本文です\n", [{ range: { start: 7, end: 7 }, text: "語" }], { anchor: 8, head: 8 });
    const enter = client.vimInput("doc_1", "<CR>");
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    expect(mockedInvoke.mock.calls.filter(([command]) => command === "apply_gui_edits")).toHaveLength(1);
    for (const pending of [first, second, third]) {
      releases.shift()!();
      await pending;
      if (pending !== third) await vi.waitFor(() => expect(releases).toHaveLength(1));
    }
    expect((await enter).text).toBe("abc\nx日本語\n本文です\n");
    expect(head).toBe(8);
    expect((await client.undo("doc_1")).text).toBe("abc\nx日本語本文です\n");
    expect(mockedInvoke.mock.calls.filter(([command]) => command === "report_cursor").map(([, args]) => (args as { head: number }).head)).toEqual([6, 7, 8]);
  });

  it("resyncs without applying a queued range after an out-of-band source change", async () => {
    const client = new RegistryClient(workspaceApi);
    client.noteSnapshot(snapshot("doc_1", 0, "abc"));
    client.noteSnapshot(snapshot("doc_1", 1, "external abc"));
    mockedInvoke.mockResolvedValue(snapshot("doc_1", 1, "external abc"));
    await expect(client.applyGuiEdits({ documentId: "doc_1", baseRevision: 0 }, "abc", [{ range: { start: 1, end: 1 }, text: "日" }])).rejects.toBeInstanceOf(StaleResync);
    expect(mockedInvoke.mock.calls.filter(([command]) => command === "apply_gui_edits")).toHaveLength(0);
  });

  it("binds a captured composition commit to a newer revision only when the full source is identical", async () => {
    const client = new RegistryClient(workspaceApi);
    client.noteSnapshot(snapshot("doc_1", 0, "abc"));
    client.noteSnapshot(snapshot("doc_1", 2, "abc"));
    mockedInvoke.mockImplementation((command, args) => {
      if (command === "apply_gui_edits") return Promise.resolve(snapshot("doc_1", 3, "abc日本語"));
      if (command === "report_cursor") return Promise.resolve(args);
      throw new Error(`unexpected ${command}`);
    });
    const result = await client.applyGuiEdits({ documentId: "doc_1", baseRevision: 0 }, "abc", [{ range: { start: 3, end: 3 }, text: "日本語" }], { anchor: 6, head: 6 });
    expect(result.text).toBe("abc日本語");
    expect(mockedInvoke).toHaveBeenCalledWith("apply_gui_edits", { documentId: "doc_1", baseRevision: 2, edits: [{ range: { start: 3, end: 3 }, text: "日本語" }] });
    expect(mockedInvoke).toHaveBeenCalledWith("report_cursor", { documentId: "doc_1", revision: 3, anchor: 6, head: 6 });
  });

  it("rejects a native ACK whose text differs from the captured GUI edit", async () => {
    const client = new RegistryClient(workspaceApi);
    client.noteSnapshot(snapshot("doc_1", 0, "abc"));
    mockedInvoke.mockResolvedValue(snapshot("doc_1", 1, "out-of-band"));
    await expect(client.applyGuiEdits({ documentId: "doc_1", baseRevision: 0 }, "abc", [{ range: { start: 1, end: 1 }, text: "日" }])).rejects.toBeInstanceOf(StaleResync);
    expect(mockedInvoke.mock.calls.filter(([command]) => command === "report_cursor")).toHaveLength(0);
  });
  it("passes document IDs and base revisions through unchanged", async () => {
    const client = new RegistryClient(workspaceApi);
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
    const client = new RegistryClient(workspaceApi);
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
    const client = new RegistryClient(workspaceApi);
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
    const client = new RegistryClient(workspaceApi);
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
    const client = new RegistryClient(workspaceApi);
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

  /** Install mode-aware invoke mocks for character routing tests. */ function installModeAware(handlers: (command: string, args?: unknown) => Promise<unknown>, getRevision?: () => number) {
    mockedInvoke.mockImplementation((command: string, args?: unknown) => {
      if (command === "fetch_mode") return Promise.resolve({ documentId: "doc_1", revision: getRevision?.() ?? 0, mode: nativeMode });
      if (command === "report_cursor") return Promise.resolve(args);
      return handlers(command, args);
    });
  }

  it("queries the mapping prefix then feeds claimed keys natively, in order", async () => {
    const client = new RegistryClient(workspaceApi);
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
    const client = new RegistryClient(workspaceApi);
    let revision = 0;
    installModeAware(
      (command: string) => {
        if (command === "has_nvim_mapping") return Promise.resolve(true);
        if (command === "nvim_input") {
          revision += 1;
          return Promise.resolve(snapshot("doc_1", revision, "x"));
        }
        throw new Error(`unexpected ${command}`);
      },
      () => revision,
    );
    await client.routeCharKey("doc_1", "j", { start: 0, end: 0 });
    await client.routeCharKey("doc_1", "j", { start: 1, end: 1 });
    expect(mockedInvoke).toHaveBeenNthCalledWith(2, "has_nvim_mapping", { documentId: "doc_1", mode: "i", lhs: "j" });
    expect(mockedInvoke).toHaveBeenNthCalledWith(5, "has_nvim_mapping", { documentId: "doc_1", mode: "i", lhs: "jj" });
  });

  it("replaces the exact selected range for unclaimed keys", async () => {
    const client = new RegistryClient(workspaceApi);
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
    const client = new RegistryClient(workspaceApi);
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
    const client = new RegistryClient(workspaceApi);
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
    const client = new RegistryClient(workspaceApi);
    let revision = 0;
    installModeAware(
      (command: string, args?: unknown) => {
        const a = (args ?? {}) as { edits?: Array<{ range: { start: number; end: number }; text: string }> };
        if (command === "has_nvim_mapping") return Promise.resolve(false);
        if (command === "apply_gui_edits") {
          revision += 1;
          const edit = a.edits![0];
          return Promise.resolve(snapshot("doc_1", revision, `<${edit.range.start}-${edit.range.end}${edit.text}>`));
        }
        throw new Error(`unexpected ${command}`);
      },
      () => revision,
    );
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
    const client = new RegistryClient(workspaceApi);
    installModeAware((command: string) => {
      if (command === "has_nvim_mapping") return Promise.reject(new Error("rpc down"));
      if (command === "apply_gui_edits") return Promise.resolve(snapshot("doc_1", 1, "a"));
      throw new Error(`unexpected ${command}`);
    });
    await expect(client.routeCharKey("doc_1", "a", { start: 0, end: 0 })).rejects.toThrow("rpc down");
    expect(mockedInvoke.mock.calls.filter(([command]) => command === "apply_gui_edits")).toHaveLength(0);
  });

  it("fails closed without feeding when the mode query is unreadable", async () => {
    const client = new RegistryClient(workspaceApi);
    mockedInvoke.mockImplementation((command: string) => {
      if (command === "fetch_mode") return Promise.reject(new Error("mode down"));
      throw new Error(`unexpected ${command}`);
    });
    await expect(client.routeCharKey("doc_1", "a", { start: 0, end: 0 })).rejects.toThrow("mode down");
    expect(mockedInvoke.mock.calls.filter(([command]) => command === "apply_gui_edits")).toHaveLength(0);
    expect(mockedInvoke.mock.calls.filter(([command]) => command === "nvim_input")).toHaveLength(0);
  });

  it("resyncs instead of duplicating when the base went stale", async () => {
    const client = new RegistryClient(workspaceApi);
    mockedInvoke.mockImplementationOnce(() => Promise.resolve({ documentId: "doc_1", revision: 0, mode: "insert" }));
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

  /** Install paste invoke mocks for captured-paste tests. */ function installPaste(handlers: (command: string, args?: unknown) => Promise<unknown>) {
    mockedInvoke.mockImplementation((command: string, args?: unknown) => {
      if (command === "fetch_mode") return Promise.resolve({ documentId: "doc_1", revision: 0, mode: nativeMode });
      if (command === "report_cursor") return Promise.resolve(args);
      return handlers(command, args);
    });
  }

  it("feeds a mapped Ctrl+V natively without inserting text", async () => {
    const client = new RegistryClient(workspaceApi);
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
    const client = new RegistryClient(workspaceApi);
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
    const client = new RegistryClient(workspaceApi);
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
    const client = new RegistryClient(workspaceApi);
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
    const client = new RegistryClient(workspaceApi);
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
    const client = new RegistryClient(workspaceApi);
    client.noteSnapshot(snapshot("doc_1", 7, "hello world"));
    mockedInvoke.mockResolvedValue({ documentId: "doc_1", revision: 7, anchor: 0, head: 5 });
    const cursor = await client.reportCursorNow("doc_1", 0, 5);
    expect(mockedInvoke).toHaveBeenCalledWith("report_cursor", { documentId: "doc_1", revision: 7, anchor: 0, head: 5 });
    expect(cursor).toMatchObject({ anchor: 0, head: 5 });
  });

  it("preserves a noncollapsed mouse anchor instead of collapsing to head", async () => {
    const client = new RegistryClient(workspaceApi);
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




describe("GUI text and native Enter share one cursor", () => {
  /** Model a native buffer whose range edits do not implicitly move its cursor. */
  function installNativeBuffer(before: string) {
    let text = before;
    let revision = 0;
    let cursor = 0;
    mockedInvoke.mockImplementation(async (command, args) => {
      const values = args as Record<string, unknown>;
      if (command === "fetch_mode") return { mode: "insert", revision };
      if (command === "has_nvim_mapping") return false;
      if (command === "apply_gui_edits") {
        expect(values.baseRevision).toBe(revision);
        const edit = (values.edits as Array<{ range: { start: number; end: number }; text: string }>)[0];
        text = text.slice(0, edit.range.start) + edit.text + text.slice(edit.range.end);
        return snapshot("enter", ++revision, text);
      }
      if (command === "report_cursor") {
        expect(values.revision).toBe(revision);
        cursor = Number(values.head);
        return { documentId: "enter", revision, anchor: cursor, head: cursor };
      }
      if (command === "nvim_input_with_copy") {
        expect(values.keys).toBe("<CR>");
        expect(values.baseRevision).toBe(revision);
        text = text.slice(0, cursor) + "\n" + text.slice(cursor);
        cursor += 1;
        return { snapshot: snapshot("enter", ++revision, text), copy: null, copyReady: false };
      }
      throw new Error("Unexpected command " + command);
    });
    return new RegistryClient(workspaceApi);
  }

  it.each([
    { before: "本文\n", key: "a", range: { start: 0, end: 0 }, expected: "a\n本文\n" },
    { before: "日本語\n", key: "😀", range: { start: 3, end: 3 }, expected: "日本語😀\n\n" },
    { before: "前選択後\n", key: "字", range: { start: 1, end: 3 }, expected: "前字\n後\n" },
  ])("moves the native caret after GUI insertion before queued Enter: $key", async ({ before, key, range, expected }) => {
    const client = installNativeBuffer(before);
    const edit = client.routeCharKey("enter", key, range);
    const newline = client.vimInputWithCopy("enter", "<CR>", vi.fn());
    await edit;
    expect((await newline).snapshot.text).toBe(expected);
    const commands = mockedInvoke.mock.calls.map(([command]) => command);
    expect(commands.indexOf("report_cursor")).toBeLessThan(commands.indexOf("nvim_input_with_copy"));
  });

  it("keeps a rapid character burst and Enter in edit/cursor order", async () => {
    const client = installNativeBuffer("\n");
    const tasks = [
      client.routeCharKey("enter", "a", { start: 0, end: 0 }),
      client.routeCharKey("enter", "b", { start: 1, end: 1 }),
      client.routeCharKey("enter", "c", { start: 2, end: 2 }),
      client.vimInputWithCopy("enter", "<CR>", vi.fn()),
    ];
    const result = await Promise.all(tasks);
    expect(result.at(-1)).toMatchObject({ snapshot: { text: "abc\n\n" } });
  });

  it("synchronizes multiline paste before the following native Enter", async () => {
    const client = installNativeBuffer("前後\n");
    const paste = client.routeCapturedPaste("enter", null, "日本語😀\n次", { start: 1, end: 1 });
    const newline = client.vimInputWithCopy("enter", "<CR>", vi.fn());
    await paste;
    expect((await newline).snapshot.text).toBe("前日本語😀\n次\n後\n");
  });
});

describe("captured printable keyboard input", () => {
  it("rejects a range whose captured full source no longer matches", async () => {
    const client = new RegistryClient(workspaceApi);
    client.noteSnapshot(snapshot("doc_1", 2, "new text"));
    mockedInvoke.mockResolvedValue(snapshot("doc_1", 2, "new text"));
    await expect(client.routeCharKey("doc_1", "a", { start: 0, end: 0 }, undefined, "old text")).rejects.toBeInstanceOf(StaleResync);
    expect(mockedInvoke.mock.calls.map(([command]) => command)).toEqual(["fetch_snapshot"]);
  });
  it("does not move the cursor when a character acknowledgement contains different text", async () => {
    const client = new RegistryClient(workspaceApi);
    client.noteSnapshot(snapshot("doc_1", 0, "前後"));
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "fetch_mode") return { mode: "insert", revision: 0 };
      if (command === "has_nvim_mapping") return false;
      if (command === "apply_gui_edits") return snapshot("doc_1", 1, "別の文書");
      throw new Error("Unexpected " + command);
    });
    await expect(client.routeCharKey("doc_1", "a", { start: 1, end: 1 }, undefined, "前後")).rejects.toBeInstanceOf(StaleResync);
    expect(mockedInvoke.mock.calls.some(([command]) => command === "report_cursor")).toBe(false);
  });
});

it("continues a native mapping prefix even when GUI text contains the pending prefix", async () => {
  const client = new RegistryClient(workspaceApi);
  client.noteSnapshot(snapshot("doc_1", 0, "本文"));
  let revision = 0;
  mockedInvoke.mockImplementation(async (command, args) => {
    if (command === "fetch_mode") return { mode: "insert", revision };
    if (command === "has_nvim_mapping") return (args as { lhs: string }).lhs === "j";
    if (command === "nvim_input") {
      const key = (args as { keys: string }).keys;
      return snapshot("doc_1", key === "j" ? revision : ++revision, key === "j" ? "本文" : "jq本文");
    }
    throw new Error("Unexpected " + command);
  });
  await client.routeCharKey("doc_1", "j", { start: 0, end: 0 }, undefined, "本文");
  const result = await client.routeCharKey("doc_1", "q", { start: 1, end: 1 }, undefined, "j本文");
  expect(result).toMatchObject({ action: "vim", snapshot: { text: "jq本文" } });
  expect(mockedInvoke.mock.calls.filter(([command]) => command === "apply_gui_edits")).toHaveLength(0);
});

describe("text after a queued native cursor transition", () => {
  it("binds committed Unicode and literal angle brackets after the Enter acknowledgement", async () => {
    const client = new RegistryClient(workspaceApi);
    client.noteSnapshot(snapshot("doc_1", 0, "前後"));
    let revision = 0;
    mockedInvoke.mockImplementation(async (command, args) => {
      if (command === "fetch_mode") return { mode: "insert", revision };
      if (command === "nvim_input_with_copy") { revision += 1; return { snapshot: snapshot("doc_1", revision, "前\n後"), copy: null, copyReady: false }; }
      if (command === "nvim_input") {
        expect(args).toEqual({ documentId: "doc_1", baseRevision: 1, keys: "<lt>Esc>日本😀" });
        return snapshot("doc_1", ++revision, "前\n<Esc>日本😀後");
      }
      throw new Error("Unexpected " + command);
    });
    const enter = client.vimInputWithCopy("doc_1", "<CR>", vi.fn());
    const text = client.insertNativeText("doc_1", "<Esc>日本😀");
    await enter;
    expect((await text).text).toBe("前\n<Esc>日本😀後");
    expect(mockedInvoke.mock.calls.filter(([command]) => command === "apply_gui_edits")).toHaveLength(0);
  });
  it.each([{ mode: "normal", revision: 0 }, { mode: "insert", revision: 1 }])("rejects text in an unexpected native mode or revision: $mode/$revision", async (mode) => {
    const client = new RegistryClient(workspaceApi);
    client.noteSnapshot(snapshot("doc_1", 0, "本文"));
    mockedInvoke.mockImplementation(async (command) => command === "fetch_mode" ? mode : snapshot("doc_1", mode.revision, "本文"));
    await expect(client.insertNativeText("doc_1", "日本")).rejects.toBeInstanceOf(StaleResync);
    expect(mockedInvoke.mock.calls.some(([command]) => command === "nvim_input")).toBe(false);
  });
});

describe("paste and GUI rejection preserve exact native state", () => {
  it("inserts a captured paste at the cursor after queued Enter instead of its old GUI offset", async () => {
    const client = new RegistryClient(workspaceApi);
    client.noteSnapshot(snapshot("doc_1", 0, "ab"));
    let revision = 0;
    mockedInvoke.mockImplementation(async (command, args) => {
      if (command === "nvim_input_with_copy") { revision = 1; return { snapshot: snapshot("doc_1", 1, "a\nb"), copy: null, copyReady: false }; }
      if (command === "fetch_mode") return { mode: "insert", revision };
      if (command === "fetch_cursor") return { documentId: "doc_1", revision, anchor: 2, head: 2 };
      if (command === "apply_gui_edits") { expect(args).toEqual({ documentId: "doc_1", baseRevision: 1, edits: [{ range: { start: 2, end: 2 }, text: "XY" }] }); return snapshot("doc_1", ++revision, "a\nXYb"); }
      if (command === "report_cursor") return { documentId: "doc_1", revision, anchor: 4, head: 4 };
      throw new Error("Unexpected " + command);
    });
    const enter = client.vimInputWithCopy("doc_1", "<CR>", vi.fn());
    const paste = client.routeCapturedPaste("doc_1", null, "XY", { start: 1, end: 1 }, "ab", true);
    await enter;
    expect((await paste).snapshot.text).toBe("a\nXYb");
  });
  it("rejects an old paste range when full source differs and no native transition owns it", async () => {
    const client = new RegistryClient(workspaceApi);
    client.noteSnapshot(snapshot("doc_1", 1, "a\nb"));
    mockedInvoke.mockResolvedValue(snapshot("doc_1", 1, "a\nb"));
    await expect(client.routeCapturedPaste("doc_1", null, "XY", { start: 1, end: 1 }, "ab")).rejects.toBeInstanceOf(StaleResync);
    expect(mockedInvoke.mock.calls.map(([command]) => command)).toEqual(["fetch_snapshot"]);
  });
  it("preserves an actual range validation error instead of relabeling it stale", async () => {
    const client = new RegistryClient(workspaceApi);
    client.noteSnapshot(snapshot("doc_1", 0, "a😀b"));
    const invalid = { code: "contract", error: { code: "split_surrogate_pair", offset: 2 } };
    mockedInvoke.mockRejectedValue(invalid);
    await expect(client.applyGuiEdits({ documentId: "doc_1", baseRevision: 0 }, "a😀b", [{ range: { start: 2, end: 2 }, text: "X" }])).rejects.toThrow(/surrogate/i);
  });
  it("feeds committed Unicode after a buffered insert mapping prefix through Neovim", async () => {
    const client = new RegistryClient(workspaceApi);
    client.noteSnapshot(snapshot("doc_1", 0, "本文"));
    mockedInvoke.mockImplementation(async (command, args) => {
      if (command === "fetch_mode") return { mode: "insert", revision: 0 };
      if (command === "has_nvim_mapping") return true;
      if (command === "nvim_input") return snapshot("doc_1", (args as { keys: string }).keys === "j" ? 0 : 1, (args as { keys: string }).keys === "j" ? "本文" : "j日本本文");
      throw new Error("Unexpected " + command);
    });
    await client.routeCharKey("doc_1", "j", { start: 0, end: 0 }, undefined, "本文");
    expect((await client.applyGuiEdits({ documentId: "doc_1", baseRevision: 0 }, "j本文", [{ range: { start: 1, end: 1 }, text: "日本" }], { anchor: 3, head: 3 })).text).toBe("j日本本文");
    expect(mockedInvoke.mock.calls.filter(([command]) => command === "apply_gui_edits")).toHaveLength(0);
  });
});
