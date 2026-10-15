import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { DocumentSnapshot, ImageData, WorkspaceInfo } from "../../../contracts/contracts";
import type { DocumentSession } from "./useDocumentSession";
import type { VimEditing } from "./useVimEditing";
import type { WorkspaceGateway } from "../../../application/ports";
import { useImageAttachments } from "./useImageAttachments";

const a: WorkspaceInfo = { root: "\\\\?\\C:\\alpha", scope: { rootId: "root-a", generation: "1" } };
const b: WorkspaceInfo = { root: "\\\\?\\C:\\beta", scope: { rootId: "root-b", generation: "1" } };
const snapshot: DocumentSnapshot = { documentId: "doc-a", location: { scope: a.scope, path: "same.md", position: 0 }, revision: 4, text: "![](attachments/same.png)", dirty: true };

/** Mount attachment routing over an explicitly owned simulated destination. */
function fixture() {
  const registry = {
    insertWorkspaceImage: vi.fn().mockResolvedValue(snapshot),
    pasteImage: vi.fn().mockResolvedValue({ snapshot, assetPath: "attachments/same.png" }),
    importExternalImage: vi.fn(),
  };
  const session = {
    registry,
    activeRef: { current: "doc-a" },
    active: { ...snapshot, path: "same.md" },
    docsRef: { current: { "doc-a": { ...snapshot, path: "same.md", revision: 3, text: "" } } },
    selections: {}, setSelections: vi.fn(), echoCursor: vi.fn(),
    vimModeRef: { current: "insert" }, caretRef: { current: {} },
    /** Accept only the fixture's current selection ticket. */
    bumpSelectionGen: vi.fn(() => 1),
    /** Keep the fixture selection unchanged while its drop is pending. */
    isSelectionGenCurrent: vi.fn(() => true),
    mergeSnapshot: vi.fn(), sayStale: vi.fn(),
  } as unknown as DocumentSession;
  const gateway = { loadWorkspaceImage: vi.fn().mockResolvedValue({ mime: "image/png", bytes: [2, 3, 4], fingerprint: "a".repeat(64) }) } as unknown as WorkspaceGateway;
  const vim = { pendingPasteRef: { current: null } } as unknown as VimEditing;
  const loadEntries = vi.fn().mockResolvedValue([]);
  const hook = renderHook(({ roots }) => useImageAttachments({ desktop: true, roots, session, vim, workspaceGateway: gateway, notify: vi.fn(), loadEntries }), { initialProps: { roots: [a, b] } });
  return { ...hook, registry, session, gateway, loadEntries };
}

it("loads foreign same-name image bytes by native scope and pastes them into the destination owner", async () => {
  const f = fixture();
  act(() => f.result.current.handleImageDrop({ kind: "workspace", scope: b.scope, path: "same.png" }, { start: 0, end: 0 }));
  await waitFor(() => expect(f.registry.pasteImage).toHaveBeenCalledOnce());
  expect(f.gateway.loadWorkspaceImage).toHaveBeenCalledExactlyOnceWith("same.png", b.scope);
  expect(f.registry.pasteImage).toHaveBeenCalledWith({ request: { location: snapshot.location, documentId: "doc-a", baseRevision: 3 }, name: "same.png", bytes: new Uint8Array([2, 3, 4]), range: { start: 0, end: 0 } });
  expect(f.registry.insertWorkspaceImage).not.toHaveBeenCalled();
  expect(f.registry.importExternalImage).not.toHaveBeenCalled();
});

it("keeps a same-root image as a relative reference", async () => {
  const f = fixture();
  act(() => f.result.current.handleImageDrop({ kind: "workspace", scope: a.scope, path: "same.png" }, { start: 0, end: 0 }));
  await waitFor(() => expect(f.registry.insertWorkspaceImage).toHaveBeenCalledOnce());
  expect(f.registry.pasteImage).not.toHaveBeenCalled();
  expect(f.gateway.loadWorkspaceImage).not.toHaveBeenCalled();
});

it("discards delayed foreign image bytes when their source root has been removed", async () => {
  const f = fixture();
  let resolve!: (image: ImageData) => void;
  vi.mocked(f.gateway.loadWorkspaceImage).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  act(() => f.result.current.handleImageDrop({ kind: "workspace", scope: b.scope, path: "same.png" }, { start: 0, end: 0 }));
  f.rerender({ roots: [a] });
  await act(async () => { resolve({ mime: "image/png", bytes: [2], fingerprint: "a".repeat(64) }); });
  expect(f.registry.pasteImage).not.toHaveBeenCalled();
  expect(f.session.mergeSnapshot).not.toHaveBeenCalled();
});
