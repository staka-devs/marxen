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
    openWorkspace: vi.fn(async (path: string) => ({ root: path })),
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
  expect(f.gateway.createMarkdown).toHaveBeenCalledExactlyOnceWith("notes/new.md", "");
  expect(f.result.current.session.docs.owned).toMatchObject({ path: "notes/new.md", revision: 17, dirty: true });
  expect(f.result.current.workspace.createdTarget).toMatchObject({ rootId: "C:/a", path: "notes/new.md", kind: "markdown" });
});

it("creates one captured child folder without document-open commands", async () => {
  const f = fixture();
  await act(async () => f.result.current.workspace.openWorkspaceFolder("C:/a"));
  act(() => f.result.current.workspace.beginCreate(f.result.current.workspace.targetFor("notes", true), true));
  act(() => f.result.current.workspace.setNewFilePath("notes/今日"));
  await act(async () => Promise.all([f.result.current.workspace.createFile(), f.result.current.workspace.createFile()]));
  expect(f.gateway.createFolder).toHaveBeenCalledExactlyOnceWith("notes/今日");
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
