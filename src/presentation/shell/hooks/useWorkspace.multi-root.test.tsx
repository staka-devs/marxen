import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { RootScope, WorkspaceInfo, WorkspaceEntry, OpenDocument, CursorUpdate } from "../../../contracts/contracts";
import type { WorkspaceMetadata } from "../../../contracts/workspace-metadata";
import type { WorkspaceGateway, WorkspaceMetadataStore } from "../../../application/ports";
import { RegistryClient } from "../../../application/document/registry-client";
import { workspaceApi } from "../../../infrastructure/tauri/workspace-api";
import { useDocumentSession } from "./useDocumentSession";
import { useWorkspace } from "./useWorkspace";
import { imageTabId } from "../../../domain/workspace-roots";

const a: WorkspaceInfo = { root: "C:/alpha", scope: { rootId: "root-a", generation: "1" } };
const b: WorkspaceInfo = { root: "C:/beta", scope: { rootId: "root-b", generation: "1" } };

/** Simulate native owners while mounting the real session, lifecycle and registry queue. */
function fixture(metadataStore?: WorkspaceMetadataStore) {
  const documents = new Map<string, OpenDocument>();
  /** Return an explicitly owned native document with identical relative names. */
  const open = vi.fn(async (path: string, scope?: RootScope): Promise<OpenDocument> => {
    const id = `${scope!.rootId}:${path}`;
    const document = documents.get(id) ?? { path, snapshot: { documentId: id, location: { scope: scope!, path, position: 0 }, revision: 3, text: `${scope!.rootId} 日本😀`, dirty: false } };
    documents.set(id, document); return document;
  });
  const gateway: WorkspaceGateway = {
    ...workspaceApi,
    /** Return a canonical root and simulate an unavailable saved folder. */
    openWorkspace: vi.fn(async (path) => { if (path.includes("missing")) throw new Error("missing"); return path === a.root ? a : b; }),
    /** Add only the requested independent owner. */
    addWorkspace: vi.fn(async (path) => { if (path.includes("missing")) throw new Error("missing"); return path === a.root ? a : b; }),
    /** Begin with no already-live native roots in this fresh-process fixture. */
    listWorkspaces: vi.fn(async () => []),
    /** Acknowledge root removal without touching another owner. */
    removeWorkspace: vi.fn(async (scope) => scope.rootId === a.scope.rootId ? a : b),
    /** List matching files in each owner. */
    listWorkspace: vi.fn(async (): Promise<WorkspaceEntry[]> => [
      { path: "same.md", name: "same.md", directory: false, markdown: true, kind: "markdown" },
      { path: "same.png", name: "same.png", directory: false, markdown: false, kind: "image" },
    ]),
    /** List only the requested owner's live actors. */
    listDocuments: vi.fn(async (scope) => [...documents.values()].filter((doc) => doc.snapshot.location?.scope.rootId === scope?.rootId)),
    openMarkdown: open,
    openTextFile: open,
    /** Keep legacy recovery separate from layout restoration. */
    listRecovery: vi.fn(async (scope) => scope?.rootId === a.scope.rootId ? [{ location: { scope, path: null, position: 0 }, documentId: "legacy-unsaved", path: null, revision: 9, conflict: false }] : []),
    discardRecovery: vi.fn(),
    /** No external mutations during this deterministic fixture. */
    pollEvents: vi.fn(async () => []),
    /** Distinguish same-name image bytes by the supplied root. */
    loadWorkspaceImage: vi.fn(async (_path, scope) => ({ mime: "image/png", bytes: [scope?.rootId === a.scope.rootId ? 1 : 2], fingerprint: "a".repeat(64) })),
    /** Capture folder creation ownership without creating an actor. */
    createFolder: vi.fn(async (path) => ({ path, name: path, directory: true, markdown: false })),
  };
  const transport = {
    ...workspaceApi,
    /** Supply native mode independently of the active root. */
    fetchMode: vi.fn(async () => ({ documentId: "", revision: 3, mode: "insert" as const })),
    /** Supply a bounded Unicode cursor. */
    fetchCursor: vi.fn(async (documentId: string) => ({ documentId, revision: 3, anchor: 1, head: 1 })),
    /** Acknowledge the exact persisted selection. */
    reportCursor: vi.fn(async (cursor: CursorUpdate) => cursor),
    /** Supply native config without modifying document text. */
    fetchConfig: vi.fn(async () => ({ path: null, errors: [], copyKeys: {} })),
  };
  const registry = new RegistryClient(transport);
  const runtimeGateway = {
    /** Return a simulated status without claiming a real Neovim process. */
    readStatus: async () => ({ contractVersion: 1, connection: "disconnected" as const, detail: "fixture" }),
  };
  const eventSource = {
    /** Register a no-op event listener for deterministic state tests. */
    listen: async () => () => {},
  };
  const notify = vi.fn();
  const hook = renderHook(() => {
    const session = useDocumentSession({ desktop: true, documentGateway: registry, workspaceGateway: gateway, notify });
    const workspace = useWorkspace({ desktop: true, session, workspaceGateway: gateway, metadataStore, notify, runtimeGateway, eventSource, showRaw: false, settingsOpen: false, routeVimKeys: vi.fn() });
    return { session, workspace };
  });
  return { ...hook, gateway, transport, documents, notify };
}

it("adds roots without losing dirty documents, images, active tabs or selections", async () => {
  const f = fixture();
  await act(async () => f.result.current.workspace.openWorkspaceFolder(a.root));
  await act(async () => f.result.current.session.openFile("same.md", a.scope));
  act(() => {
    f.result.current.session.setDocs((docs) => ({ ...docs, "root-a:same.md": { ...docs["root-a:same.md"], dirty: true, text: "unsaved 日本😀" } }));
    f.result.current.session.setSelections({ "root-a:same.md": { anchor: 2, head: 5 } });
  });
  await act(async () => f.result.current.session.openFile("same.png", a.scope));
  const active = f.result.current.session.activeId;
  await act(async () => f.result.current.workspace.addWorkspaceFolder(b.root));
  expect(f.result.current.session.activeId).toBe(active);
  expect(f.result.current.session.docs["root-a:same.md"].text).toBe("unsaved 日本😀");
  expect(f.result.current.session.selections["root-a:same.md"]).toEqual({ anchor: 2, head: 5 });
  await act(async () => f.result.current.session.openFile("same.md", b.scope));
  await act(async () => f.result.current.session.openFile("same.png", b.scope));
  expect(f.result.current.session.tabs).toContain(imageTabId(a.scope.rootId, "same.png"));
  expect(f.result.current.session.tabs).toContain(imageTabId(b.scope.rootId, "same.png"));
  expect(f.result.current.session.docs["root-b:same.md"].location?.scope).toEqual(b.scope);
  act(() => f.result.current.workspace.beginCreate(f.result.current.workspace.targetFor("", true, undefined, b.scope), true));
  act(() => f.result.current.workspace.setNewFilePath("new"));
  await act(async () => f.result.current.workspace.createFile());
  expect(f.gateway.createFolder).toHaveBeenCalledWith("new", b.scope);
});

it("keeps both roots and all tabs on removal cancel/save failure, then removes only the acknowledged owner", async () => {
  const f = fixture();
  await act(async () => f.result.current.workspace.openWorkspaceFolder(a.root));
  await act(async () => f.result.current.workspace.addWorkspaceFolder(b.root));
  for (const owner of [a, b]) {
    await act(async () => f.result.current.session.openFile("same.md", owner.scope));
    await act(async () => f.result.current.session.openFile("same.png", owner.scope));
  }
  const tabs = f.result.current.session.tabs;
  act(() => f.result.current.workspace.beginRemoveRoot(a.scope));
  await act(async () => f.result.current.workspace.resolveRemoveRoot("cancel"));
  expect(f.gateway.removeWorkspace).not.toHaveBeenCalled();
  expect(f.result.current.session.tabs).toEqual(tabs);
  vi.mocked(f.gateway.removeWorkspace!).mockRejectedValueOnce({ code: "conflict", path: "same.md" });
  act(() => f.result.current.workspace.beginRemoveRoot(a.scope));
  await act(async () => f.result.current.workspace.resolveRemoveRoot("save"));
  expect(f.result.current.workspace.roots).toEqual([a, b]);
  expect(f.result.current.session.tabs).toEqual(tabs);
  await act(async () => f.result.current.workspace.resolveRemoveRoot("discard"));
  expect(f.result.current.workspace.roots).toEqual([b]);
  expect(f.result.current.session.tabs).toEqual(["root-b:same.md", imageTabId(b.scope.rootId, "same.png")]);
});

it("rejects a late file-open completion after its captured root is removed", async () => {
  const f = fixture();
  await act(async () => f.result.current.workspace.openWorkspaceFolder(a.root));
  let finish!: (doc: OpenDocument) => void;
  vi.mocked(f.gateway.openMarkdown).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  let opening!: Promise<void>;
  act(() => { opening = f.result.current.session.openFile("same.md", a.scope); });
  act(() => f.result.current.workspace.beginRemoveRoot(a.scope));
  await act(async () => f.result.current.workspace.resolveRemoveRoot("discard"));
  await act(async () => { finish({ path: "same.md", snapshot: { documentId: "late", revision: 0, text: "late", dirty: false, location: { scope: a.scope, path: "same.md", position: 0 } } }); await opening; });
  expect(f.result.current.session.tabs).toEqual([]);
  expect(f.result.current.session.docs).toEqual({});
});

it("restores both owners, text/image tabs and selection while retaining missing roots and legacy recovery", async () => {
  let stored: WorkspaceMetadata = { version: 1, roots: [{ root: a.root }, { root: b.root }, { root: "C:/missing" }], tabs: [
    { root: a.root, path: "same.md", image: false, selection: { anchor: 2, head: 5 } },
    { root: b.root, path: "same.png", image: true },
    { root: "C:/missing", path: "same.md", image: false },
  ], active: { root: b.root, path: "same.png", image: true } };
  const store: WorkspaceMetadataStore = {
    /** Return a durable copy as if a previous application process wrote it. */
    load: () => structuredClone(stored),
    /** Retain the last serialized layout across the simulated restart. */
    save: (value) => { stored = structuredClone(value); return true; },
  };
  const f = fixture(store);
  await waitFor(() => expect(f.result.current.workspace.busy).toBe(false));
  expect(f.result.current.workspace.roots).toEqual([a, b]);
  expect(f.result.current.workspace.missingRoots).toEqual(["C:/missing"]);
  expect(f.result.current.session.activeId).toBe(imageTabId(b.scope.rootId, "same.png"));
  expect(f.result.current.session.selections["root-a:same.md"]).toEqual({ anchor: 2, head: 5 });
  expect(f.result.current.workspace.recovery[0].documentId).toBe("legacy-unsaved");
  expect(f.gateway.discardRecovery).not.toHaveBeenCalled();
  expect(stored.roots).toContainEqual({ root: "C:/missing" });
  expect(stored.tabs).toContainEqual({ root: "C:/missing", path: "same.md", image: false });
  f.unmount();
  const restarted = fixture(store);
  await waitFor(() => expect(restarted.result.current.workspace.busy).toBe(false));
  expect(restarted.result.current.session.tabs).toEqual(["root-a:same.md", imageTabId(b.scope.rootId, "same.png")]);
  expect(restarted.result.current.workspace.missingRoots).toEqual(["C:/missing"]);
});

it("does not overwrite unreadable or newer metadata with the initial empty workspace", async () => {
  const store = {
    /** Report unsupported bytes without replacing them with empty metadata. */
    load: vi.fn(() => null),
    /** Observe whether the shell attempts to overwrite the unreadable layout. */
    save: vi.fn(() => true),
  };
  const f = fixture(store);
  await waitFor(() => expect(f.result.current.workspace.busy).toBe(false));
  await act(async () => f.result.current.workspace.openWorkspaceFolder(a.root));
  expect(store.save).not.toHaveBeenCalled();
});

it("renames same-name images only in their owning root", async () => {
  const f = fixture();
  await act(async () => f.result.current.workspace.openWorkspaceFolder(a.root));
  await act(async () => f.result.current.workspace.addWorkspaceFolder(b.root));
  await act(async () => f.result.current.session.openFile("same.png", a.scope));
  await act(async () => f.result.current.session.openFile("same.png", b.scope));
  const ownerA = imageTabId(a.scope.rootId, "same.png");
  const ownerB = imageTabId(b.scope.rootId, "same.png");
  expect(f.result.current.session.tabs).toContain(ownerA);
  expect(f.result.current.session.tabs).toContain(ownerB);
  const fingerprint = "b".repeat(64);
  vi.mocked(f.gateway.loadWorkspaceImage).mockResolvedValue({ mime: "image/png", bytes: [1], fingerprint });
  const gateway = f.gateway as unknown as Record<string, ReturnType<typeof vi.fn>>;
  gateway.renameImage = vi.fn(async (_source: string, dest: string) => ({ path: dest, name: dest.split("/").at(-1)!, directory: false, markdown: false, kind: "image" as const }));
  await act(async () => f.result.current.workspace.beginRename(f.result.current.workspace.targetFor("same.png", false, "image", a.scope)));
  act(() => f.result.current.workspace.setRenamePath("renamed.png"));
  await act(async () => f.result.current.workspace.renameFile());
  expect(gateway.renameImage).toHaveBeenCalledExactlyOnceWith("same.png", "renamed.png", fingerprint, a.scope);
  const renamedA = imageTabId(a.scope.rootId, "renamed.png");
  expect(f.result.current.session.tabs).toContain(renamedA);
  expect(f.result.current.session.tabs).toContain(ownerB);
  expect(f.result.current.session.tabs).not.toContain(ownerA);
  expect(f.result.current.session.imageTabs[ownerB]).toBe("same.png");
});

it("hides recovery entries for already-open documents instead of offering restore again", async () => {
  const f = fixture();
  await act(async () => f.result.current.workspace.openWorkspaceFolder(a.root));
  await act(async () => f.result.current.session.openFile("same.md", a.scope));
  f.gateway.listRecovery = vi.fn(async () => [
    { location: { scope: a.scope, path: "same.md", position: 0 }, documentId: "root-a:same.md", path: "same.md", revision: 3, conflict: false },
    { location: { scope: a.scope, path: "other.md", position: 0 }, documentId: "other-unsaved", path: "other.md", revision: 3, conflict: false },
  ]);
  await act(async () => f.result.current.workspace.refreshRecovery());
  expect(f.result.current.workspace.recovery.map((entry) => entry.documentId)).toEqual(["other-unsaved"]);
});

it("drops a restored entry from the recovery list without requiring a second refresh", async () => {
  const f = fixture();
  await act(async () => f.result.current.workspace.openWorkspaceFolder(a.root));
  const doc: OpenDocument = { path: "other.md", snapshot: { documentId: "other-unsaved", location: { scope: a.scope, path: "other.md", position: 0 }, revision: 3, text: "unsaved", dirty: true } };
  f.gateway.restoreRecovery = vi.fn(async () => doc);
  f.gateway.listRecovery = vi.fn(async () => []);
  await act(async () => f.result.current.workspace.restoreEntry("other-unsaved", false));
  expect(f.result.current.session.docs["other-unsaved"].text).toBe("unsaved");
  expect(f.result.current.workspace.recovery).toEqual([]);
});
it("automatically restores named and untitled working copies when reopening a folder", async () => {
  const f = fixture();
  const saved = ["same.md", null].map((path, index): OpenDocument => ({ path, snapshot: { documentId: `recovered-${index}`, location: { scope: a.scope, path, position: 0 }, revision: 9, text: `unsaved 日本😀 ${index}`, dirty: true } }));
  f.gateway.listRecovery = vi.fn(async () => saved.filter((doc) => !f.documents.has(doc.snapshot.documentId)).map((doc) => ({ documentId: doc.snapshot.documentId, location: doc.snapshot.location!, path: doc.path, revision: doc.snapshot.revision, conflict: false })));
  f.gateway.restoreRecovery = vi.fn(async (id) => { const doc = saved.find((entry) => entry.snapshot.documentId === id)!; f.documents.set(id, doc); return doc; });
  await act(async () => { await f.result.current.workspace.openWorkspaceFolder(a.root); });
  expect(f.result.current.session.tabs).toEqual(saved.map((doc) => doc.snapshot.documentId));
  expect(f.result.current.session.docs["recovered-1"].text).toBe("unsaved 日本😀 1");
  expect(f.result.current.session.docs["recovered-1"].dirty).toBe(true);
  expect(f.result.current.workspace.recovery).toEqual([]);
});
