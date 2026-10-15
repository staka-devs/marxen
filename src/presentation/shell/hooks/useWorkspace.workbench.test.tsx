import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useWorkspace } from "./useWorkspace";
import { useDocumentSession } from "./useDocumentSession";
import { RegistryClient } from "../../../application/document/registry-client";
import { workspaceApi } from "../../../infrastructure/tauri/workspace-api";
import type { DocumentSnapshot, WorkspaceEntry } from "../../../contracts/contracts";

/** Mount real workspace/session owners over a bounded simulated transport. */
function fixture() {
  const snapshot: DocumentSnapshot = { documentId: "owned", revision: 17, text: "日本😀 dirty", dirty: true };
  const entries: WorkspaceEntry[] = [{ path: "notes", name: "notes", directory: true, markdown: false }];
  const gateway = {
    ...workspaceApi,
    /** Simulate one canonical native root. */
    openWorkspace: vi.fn(async (path: string) => ({ root: path, scope: { rootId: "fixture-root", generation: "1" } })),
    /** Supply direct tree children without opening any document. */
    listWorkspace: vi.fn(async (path = "") => path === "" ? entries : []),
    /** Seed no documents on root replacement. */
    listDocuments: vi.fn(async () => []),
    /** Seed no recovery entries. */
    listRecovery: vi.fn(async () => []),
    /** Supply no external changes during focused hook tests. */
    pollEvents: vi.fn(async () => []),
    /** Open the selected Markdown actor at its authoritative revision. */
    openMarkdown: vi.fn(async (path: string) => ({ path, snapshot })),
    /** Open a supported UTF-8 text actor without converting it to Markdown. */
    openTextFile: vi.fn(async (path: string) => ({ path, snapshot })),
    /** Return the native fingerprint of the captured image bytes. */
    loadWorkspaceImage: vi.fn(async () => ({ mime: "image/png", bytes: [137, 80, 78, 71], fingerprint: "a".repeat(64) })),
    /** Move the captured image without opening a text actor. */
    renameImage: vi.fn(async (_source: string, path: string, _fingerprint: string): Promise<WorkspaceEntry> => ({ path, name: path.split("/").at(-1)!, directory: false, markdown: false, kind: "image" })),
    /** Move a folder whose native guards have accepted the captured source. */
    renameFolder: vi.fn(async (_source: string, path: string): Promise<WorkspaceEntry> => ({ path, name: path.split("/").at(-1)!, directory: true, markdown: false })),
    /** Create a Markdown actor using the supplied relative path. */
    createMarkdown: vi.fn(async (path: string) => ({ path, snapshot })),
    /** Create a directory without registering an actor. */
    createFolder: vi.fn(async (path: string): Promise<WorkspaceEntry> => ({ path, name: path.split("/").at(-1)!, directory: true, markdown: false })),
    /** Rename only the supplied actor and acknowledged revision. */
    renameMarkdown: vi.fn(async (request: { documentId: string; baseRevision: number }, path: string) => ({ path, snapshot: { ...snapshot, documentId: request.documentId } })),
    /** Supply actual fixture mode for document activation. */
    fetchMode: vi.fn(async () => ({ documentId: "owned", revision: 17, mode: "insert" as const })),
    /** Supply the authoritative Unicode caret. */
    fetchCursor: vi.fn(async () => ({ documentId: "owned", revision: 17, anchor: 3, head: 3 })),
    /** Supply the configuration reader triggered by document activation. */
    fetchConfig: vi.fn(async () => ({ path: null, errors: [], copyKeys: { markdown: "<F6>", text: "<F7>", rich: "<F8>", html: "<F9>" } })),
  };
  const registry = new RegistryClient(gateway);
  const notify = vi.fn();
  const runtimeGateway = {
    /** Return a fixture status without launching Neovim. */
    readStatus: async () => ({ contractVersion: 1, connection: "disconnected" as const, detail: "fixture" }),
  };
  const eventSource = {
    /** Install a no-op fixture event subscription. */
    listen: async () => () => {},
  };
  const routeVimKeys = vi.fn();
  const hook = renderHook(() => {
    const session = useDocumentSession({ desktop: true, documentGateway: registry, workspaceGateway: gateway, notify });
    const workspace = useWorkspace({ desktop: true, session, workspaceGateway: gateway, notify, showRaw: false, settingsOpen: false,
      runtimeGateway, eventSource, routeVimKeys,
    });
    return { workspace, session };
  });
  return { ...hook, gateway, snapshot, registry, notify };
}

it("captures a file's parent for creation and registers the returned snapshot", async () => {
  const f = fixture();
  await act(async () => f.result.current.workspace.openWorkspaceFolder("C:/a"));
  act(() => f.result.current.workspace.beginCreate(f.result.current.workspace.targetFor("notes/a.md", false, "markdown")));
  expect(f.result.current.workspace.newFilePath).toBe("notes/");
  act(() => f.result.current.workspace.setNewFilePath("notes/new.md"));
  await act(async () => f.result.current.workspace.createFile());
  expect(f.gateway.createMarkdown).toHaveBeenCalledExactlyOnceWith("notes/new.md", "", { rootId: "fixture-root", generation: "1" });
  expect(f.result.current.session.docs.owned).toMatchObject({ path: "notes/new.md", revision: 17, dirty: true });
  expect(f.result.current.workspace.createdTarget).toMatchObject({ rootId: "fixture-root", path: "notes/new.md", kind: "markdown" });
});

it("registers a restored native owner before the first GUI edit of its recovered ID", async () => {
  const f = fixture();
  await act(async () => f.result.current.workspace.openWorkspaceFolder("C:/a"));
  const restored = { ...f.snapshot, documentId: "recovered-native-id", location: { scope: { rootId: "fixture-root", generation: "1" }, path: "recovered.md", position: 0 } };
  f.gateway.restoreRecovery = vi.fn(async () => ({ path: "recovered.md", snapshot: restored }));
  f.gateway.applyEdits = vi.fn(async () => ({ ...restored, revision: 18, text: `!${restored.text}` }));
  await act(async () => f.result.current.workspace.restoreEntry("legacy-id", false));
  await f.registry.applyGuiEdits({ documentId: restored.documentId, baseRevision: restored.revision, location: restored.location }, restored.text, [{ range: { start: 0, end: 0 }, text: "!" }]);
  expect(f.gateway.applyEdits).toHaveBeenCalledExactlyOnceWith({ documentId: restored.documentId, baseRevision: restored.revision, location: restored.location }, [{ range: { start: 0, end: 0 }, text: "!" }]);
});

it("creates one captured child folder without document-open commands", async () => {
  const f = fixture();
  await act(async () => f.result.current.workspace.openWorkspaceFolder("C:/a"));
  act(() => f.result.current.workspace.beginCreate(f.result.current.workspace.targetFor("notes", true), true));
  act(() => f.result.current.workspace.setNewFilePath("notes/今日"));
  await act(async () => Promise.all([f.result.current.workspace.createFile(), f.result.current.workspace.createFile()]));
  expect(f.gateway.createFolder).toHaveBeenCalledExactlyOnceWith("notes/今日", { rootId: "fixture-root", generation: "1" });
  expect(f.gateway.openMarkdown).not.toHaveBeenCalled();
  expect(f.gateway.createMarkdown).not.toHaveBeenCalled();
  expect(f.result.current.session.tabs).toEqual([]);
});

it("renames the captured actor through its queue with its exact revision and preserves dirty text", async () => {
  const f = fixture();
  await act(async () => f.result.current.workspace.openWorkspaceFolder("C:/a"));
  await act(async () => f.result.current.workspace.beginRename(f.result.current.workspace.targetFor("notes/a.md", false, "markdown")));
  act(() => f.result.current.workspace.setRenamePath("notes/b.md"));
  const rename = vi.spyOn(f.registry, "rename");
  await act(async () => f.result.current.workspace.renameFile());
  expect(rename).toHaveBeenCalledExactlyOnceWith({ documentId: "owned", baseRevision: 17 }, "notes/b.md");
  expect(f.gateway.renameMarkdown).toHaveBeenCalledExactlyOnceWith({ documentId: "owned", baseRevision: 17 }, "notes/b.md");
  expect(f.result.current.session.docs.owned).toMatchObject({ documentId: "owned", path: "notes/b.md", text: f.snapshot.text, dirty: true });
});

it("refreshes entries without replacing dirty buffers and rejects late old-root results", async () => {
  const f = fixture();
  await act(async () => f.result.current.workspace.openWorkspaceFolder("C:/a"));
  await act(async () => f.result.current.session.openFile("a.md"));
  await act(async () => f.result.current.workspace.refreshEntries());
  expect(f.result.current.session.docs.owned).toMatchObject({ text: f.snapshot.text, revision: 17, dirty: true });
  let resolve!: (entries: WorkspaceEntry[]) => void;
  f.gateway.listWorkspace.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  let refresh!: Promise<void>;
  act(() => { refresh = f.result.current.workspace.refreshEntries(); });
  await act(async () => f.result.current.workspace.openWorkspaceFolder("C:/b"));
  await act(async () => { resolve([{ path: "old.md", name: "old.md", directory: false, markdown: true }]); await refresh; });
  expect(f.result.current.workspace.wsRoot).toBe("C:/b");
  expect(f.result.current.workspace.entries.map((item) => item.path)).not.toContain("old.md");
});

it("rejects stale tree targets and preserves the old workspace when native replacement fails", async () => {
  const f = fixture();
  await act(async () => f.result.current.workspace.openWorkspaceFolder("C:/a"));
  const old = f.result.current.workspace.targetFor("notes", true);
  f.gateway.openWorkspace.mockRejectedValueOnce({ code: "unsaved_changes", snapshot: f.snapshot });
  await act(async () => f.result.current.workspace.openWorkspaceFolder("C:/b"));
  expect(f.result.current.workspace.wsRoot).toBe("C:/a");
  expect(f.result.current.workspace.entries[0].path).toBe("notes");
  act(() => f.result.current.workspace.beginCreate(old, true));
  expect(f.result.current.workspace.newFileOpen).toBe(false);
  expect(f.notify).toHaveBeenCalled();
});

it("renames UTF-8 text through the existing actor with its captured revision", async () => {
  const f = fixture();
  await act(async () => f.result.current.workspace.openWorkspaceFolder("C:/a"));
  await act(async () => f.result.current.workspace.beginRename(f.result.current.workspace.targetFor("notes/code.ts", false, "text")));
  act(() => f.result.current.workspace.setRenamePath("notes/renamed.ts"));
  await act(async () => f.result.current.workspace.renameFile());
  expect(f.gateway.openTextFile).toHaveBeenCalledExactlyOnceWith("notes/code.ts", { rootId: "fixture-root", generation: "1" });
  expect(f.gateway.openMarkdown).not.toHaveBeenCalled();
  expect(f.gateway.renameMarkdown).toHaveBeenCalledExactlyOnceWith({ documentId: "owned", baseRevision: 17 }, "notes/renamed.ts");
  expect(f.result.current.session.docs.owned).toMatchObject({ text: f.snapshot.text, dirty: true });
});

it("uses the captured native image fingerprint and maps its active tab without opening an actor", async () => {
  const f = fixture();
  await act(async () => f.result.current.workspace.openWorkspaceFolder("C:/a"));
  await act(async () => f.result.current.session.openFile("notes/a.png"));
  await act(async () => f.result.current.workspace.beginRename(f.result.current.workspace.targetFor("notes/a.png", false, "image")));
  act(() => f.result.current.workspace.setRenamePath("notes/b.png"));
  await act(async () => f.result.current.workspace.renameFile());
  expect(f.gateway.renameImage).toHaveBeenCalledExactlyOnceWith("notes/a.png", "notes/b.png", "a".repeat(64), { rootId: "fixture-root", generation: "1" });
  expect(f.result.current.session.imageTabs).toEqual({ "image:notes/b.png": "notes/b.png" });
  expect(f.result.current.session.tabs).toEqual(["image:notes/b.png"]);
  expect(f.result.current.session.activeId).toBe("image:notes/b.png");
  expect(f.result.current.workspace.createdTarget).toMatchObject({ path: "notes/b.png", kind: "image" });
  expect(f.gateway.openMarkdown).not.toHaveBeenCalled();
  expect(f.gateway.openTextFile).not.toHaveBeenCalled();
});

it("fails closed without a native fingerprint and performs no rename after cancellation", async () => {
  const f = fixture();
  await act(async () => f.result.current.workspace.openWorkspaceFolder("C:/a"));
  f.gateway.loadWorkspaceImage.mockResolvedValueOnce({ mime: "image/png", bytes: [], fingerprint: "" });
  await act(async () => f.result.current.workspace.beginRename(f.result.current.workspace.targetFor("a.png", false, "image")));
  expect(f.result.current.workspace.renameDoc).toBeNull();
  expect(f.notify).toHaveBeenCalled();
  await act(async () => f.result.current.workspace.beginRename(f.result.current.workspace.targetFor("a.png", false, "image")));
  act(() => f.result.current.workspace.setRenameDoc(null));
  await act(async () => f.result.current.workspace.renameFile());
  expect(f.gateway.renameImage).not.toHaveBeenCalled();
});

it("maps nested image tabs on folder rename while preserving unrelated paths", async () => {
  const f = fixture();
  await act(async () => f.result.current.workspace.openWorkspaceFolder("C:/a"));
  await act(async () => f.result.current.session.openFile("notes/child/a.png"));
  await act(async () => f.result.current.session.openFile("notes-other/a.png"));
  act(() => f.result.current.session.setActiveId("image:notes/child/a.png"));
  await act(async () => f.result.current.workspace.beginRename(f.result.current.workspace.targetFor("notes", true)));
  act(() => f.result.current.workspace.setRenamePath("renamed"));
  await act(async () => f.result.current.workspace.renameFile());
  expect(f.gateway.renameFolder).toHaveBeenCalledExactlyOnceWith("notes", "renamed", { rootId: "fixture-root", generation: "1" });
  expect(f.result.current.session.imageTabs).toEqual({ "image:renamed/child/a.png": "renamed/child/a.png", "image:notes-other/a.png": "notes-other/a.png" });
  expect(f.result.current.session.tabs).toEqual(["image:renamed/child/a.png", "image:notes-other/a.png"]);
  expect(f.result.current.session.activeId).toBe("image:renamed/child/a.png");
});

it("refuses roots and folders with open dirty text descendants without closing documents", async () => {
  const f = fixture();
  await act(async () => f.result.current.workspace.openWorkspaceFolder("C:/a"));
  await act(async () => f.result.current.session.openFile("notes/a.ts"));
  await act(async () => f.result.current.workspace.beginRename(f.result.current.workspace.targetFor("notes", true)));
  expect(f.result.current.workspace.renameDoc).toBeNull();
  expect(f.result.current.session.docs.owned).toMatchObject({ text: f.snapshot.text, dirty: true });
  await act(async () => f.result.current.workspace.beginRename(f.result.current.workspace.targetFor()));
  expect(f.result.current.workspace.renameDoc).toBeNull();
  expect(f.gateway.renameFolder).not.toHaveBeenCalled();
});
