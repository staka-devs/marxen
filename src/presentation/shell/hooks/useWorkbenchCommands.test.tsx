import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { EditorContext } from "../../../contracts/contracts";
import type { ExplorerTarget } from "../../../contracts/workbench";
import type { DocumentSession } from "./useDocumentSession";
import type { WorkspaceHandle } from "./useWorkspace";
import { useWorkbenchCommands } from "./useWorkbenchCommands";

/** Mount the consumed dispatcher with explicit native context and lifecycle owners. */
function fixture(desktop = true) {
  const context: EditorContext = { cursor: { documentId: "doc", revision: 4, anchor: 0, head: 3 }, mode: "insert", presentation: { editable: true, selectionToolbar: false, mappings: [] } };
  const doc = { documentId: "doc", path: "a.md", revision: 4, text: "日😀", dirty: false };
  const registry = {
    /** Return the captured native fixture selection. */
    fetchEditorContext: vi.fn(async () => context),
    /** Record guarded native clipboard/history requests. */
    editorAction: vi.fn(async () => doc),
    /** Record whole-buffer native selection requests. */
    selectAll: vi.fn(async () => context.cursor),
  };
  const session = { registry, activeRef: { current: "doc" }, docsRef: { current: { doc } }, vimModeRef: { current: "insert" },
    /** Issue a fixture selection generation for native action assertions. */
    bumpSelectionGen: vi.fn(() => 1),
    mergeSnapshot: vi.fn(),
    /** Observe the post-action native mode/cursor refresh. */
    refreshModeCursor: vi.fn(async () => {}),
    sayStale: vi.fn(), echoCursor: vi.fn(), setSelections: vi.fn(),
    /** Observe queued document save dispatch. */
    handleSave: vi.fn(async () => {}),
    /** Observe native document reload dispatch. */
    handleReload: vi.fn(async () => {}),
    /** Observe explicit tab close dispatch. */
    closeTab: vi.fn(async () => {}),
  } as unknown as DocumentSession;
  let generation = 1;
  const target: ExplorerTarget = { rootId: "root", generation, path: "notes", directory: true };
  const workspace = { busy: false,
    /** Return the current single-root session target. */
    targetFor: () => ({ ...target, generation }),
    /** Compare captured root generation at invocation time. */
    isTargetCurrent: (value: ExplorerTarget) => value.generation === generation,
    /** Report that this fixture's native lifecycle is available. */
    canOperate: () => true,
    beginCreate: vi.fn(), beginRename: vi.fn(), refreshEntries: vi.fn(), pickFolderAndOpen: vi.fn(), pickFolderAndAdd: vi.fn(),
  } as unknown as WorkspaceHandle;
  const ui = vi.fn();
  const origin = document.createElement("div"); origin.className = "cm-editor"; origin.tabIndex = 0; document.body.append(origin);
  const hook = renderHook(() => useWorkbenchCommands({ desktop, session, workspace, target, notify: vi.fn(), openFile: vi.fn(),
    uiActions: { "folder-add": ui, "palette-settings": ui, "palette-raw": ui }, checked: vi.fn(),
  }));
  return { ...hook, context, doc, registry, session, workspace, target, origin, ui,
    /** Replace the session generation without changing a previously captured tree target. */
    replaceRoot: () => { generation += 1; },
  };
}

it("enables additive folder dispatch and rechecks stale targets on invocation", async () => {
  const f = fixture();
  expect(f.result.current.command("folder-add")).toMatchObject({ enabled: true });
  await act(async () => f.result.current.run("folder-add"));
  expect(f.workspace.pickFolderAndAdd).toHaveBeenCalledOnce();
  expect(f.ui).not.toHaveBeenCalled();
  expect(f.result.current.command("folder-new")?.enabled).toBe(true);
  f.replaceRoot();
  await act(async () => f.result.current.run("folder-new", f.target));
  expect(f.workspace.beginCreate).not.toHaveBeenCalled();
  f.origin.remove();
});

it("allows a browser document screen preview while rejecting native refresh and save", async () => {
  const f = fixture(false);
  expect(f.result.current.command("palette-raw")?.enabled).toBe(true);
  expect(f.result.current.command("palette-raw-refresh")?.enabled).toBe(false);
  expect(f.result.current.command("file-save")?.enabled).toBe(false);
  await act(async () => f.result.current.run("palette-raw"));
  expect(f.ui).toHaveBeenCalledOnce();
  await act(async () => f.result.current.run("file-save"));
  expect(f.session.handleSave).not.toHaveBeenCalled();
  expect(f.registry.fetchEditorContext).not.toHaveBeenCalled();
  f.origin.remove();
});

it("routes captured editor actions to native operations and rejects a moved revision or mode", async () => {
  const f = fixture();
  await act(async () => f.result.current.prepareEditor(f.origin));
  expect(f.result.current.command("edit-copy")?.enabled).toBe(true);
  await act(async () => f.result.current.run("edit-copy"));
  expect(f.registry.editorAction).toHaveBeenCalledExactlyOnceWith(f.context.cursor, "copy");
  await act(async () => f.result.current.prepareEditor(f.origin));
  f.doc.revision += 1;
  await act(async () => f.result.current.run("edit-cut"));
  expect(f.registry.editorAction).toHaveBeenCalledTimes(1);
  f.doc.revision = 4;
  f.session.vimModeRef.current = "command_line";
  await act(async () => f.result.current.run("selection-all"));
  expect(f.registry.selectAll).not.toHaveBeenCalled();
  f.origin.remove();
});

it("disables captured edits for read-only buffers and form-input origins", async () => {
  const f = fixture(); f.context.presentation.editable = false;
  await act(async () => f.result.current.prepareEditor(f.origin));
  expect(f.result.current.command("edit-copy")?.enabled).toBe(true);
  expect(f.result.current.command("edit-paste")?.enabled).toBe(false);
  const input = document.createElement("input"); document.body.append(input);
  await act(async () => f.result.current.prepareEditor(input));
  await act(async () => f.result.current.run("edit-copy"));
  expect(f.registry.editorAction).not.toHaveBeenCalled();
  input.remove(); f.origin.remove();
});
