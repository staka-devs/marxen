import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { DocumentSnapshot, RootEvent, RootScope } from "../../contracts/contracts";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  /** Enable the native transport fixture. */
  isTauri: () => true,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
const a: RootScope = { rootId: "root-a", generation: "1" };
const b: RootScope = { rootId: "root-b", generation: "2" };

/** Build a native snapshot carrying an explicit owner and position. */
function snapshot(scope: RootScope, position = 0): DocumentSnapshot {
  return { documentId: `doc-${scope.rootId}`, location: { scope, path: "same.md", position }, revision: 0, text: "text", dirty: false };
}

beforeEach(() => { vi.resetAllMocks(); vi.resetModules(); vi.mocked(invoke).mockResolvedValue(undefined); });

it("keeps document requests bound to their native owner after the active root changes", async () => {
  const { workspaceApi } = await import("./workspace-api");
  vi.mocked(invoke).mockResolvedValueOnce({ root: "/a", scope: a });
  await workspaceApi.openWorkspace("/a");
  vi.mocked(invoke).mockResolvedValueOnce({ path: "same.md", snapshot: snapshot(a) });
  await workspaceApi.openMarkdown("same.md");
  vi.mocked(invoke).mockResolvedValueOnce({ root: "/b", scope: b });
  await workspaceApi.openWorkspace("/b");
  await workspaceApi.saveDocument({ documentId: snapshot(a).documentId, baseRevision: 0 });
  expect(invoke).toHaveBeenLastCalledWith("save_document", expect.objectContaining({ location: snapshot(a).location }));
  await workspaceApi.listWorkspace();
  expect(invoke).toHaveBeenLastCalledWith("list_workspace", { path: "", scope: b });
});

it("sends the searched incarnation after the same filesystem root has been reopened", async () => {
  const { workspaceApi } = await import("./workspace-api");
  vi.mocked(invoke).mockResolvedValueOnce({ root: "/a", scope: a });
  await workspaceApi.openWorkspace("/a");
  vi.mocked(invoke).mockResolvedValueOnce({ root: "/a", scope: { ...a, generation: "next" } });
  await workspaceApi.openWorkspace("/a");
  await workspaceApi.planSearchReplacement({ scope: a, root: "/a", path: "same.md", query: "text", options: { caseSensitive: false, wholeWord: false, regex: false }, replacement: "new", revision: 0, contentToken: "token", range: null });
  expect(invoke).toHaveBeenLastCalledWith("plan_search_replacement", expect.objectContaining({ scope: a }));
});

it("drops late events from removed root incarnations and retains current owner snapshots", async () => {
  const { workspaceApi, listenWorkspaceEvents } = await import("./workspace-api");
  vi.mocked(invoke).mockResolvedValueOnce({ root: "/a", scope: a });
  await workspaceApi.openWorkspace("/a");
  const callback = vi.fn();
  await listenWorkspaceEvents(callback);
  const receive = vi.mocked(listen).mock.calls[0][1] as (event: { payload: RootEvent[] }) => void;
  vi.mocked(invoke).mockResolvedValueOnce({ root: "/b", scope: b });
  await workspaceApi.openWorkspace("/b");
  receive({ payload: [{ scope: a, event: { type: "snapshot", payload: snapshot(a) } }, { scope: b, event: { type: "snapshot", payload: snapshot(b) } }] });
  expect(callback).toHaveBeenCalledExactlyOnceWith([{ type: "snapshot", payload: snapshot(b) }]);
  await workspaceApi.loadImage(snapshot(b).documentId, "same.png");
  expect(invoke).toHaveBeenLastCalledWith("load_relative_image", expect.objectContaining({ location: snapshot(b).location }));
});

it("never rewinds native rename positions when an earlier snapshot arrives late", async () => {
  const { workspaceApi } = await import("./workspace-api");
  workspaceApi.noteSnapshot(snapshot(a, 2));
  workspaceApi.noteSnapshot(snapshot(a, 1));
  await workspaceApi.fetchSnapshot(snapshot(a).documentId);
  expect(invoke).toHaveBeenLastCalledWith("fetch_snapshot", expect.objectContaining({ location: snapshot(a, 2).location }));
});

it("keeps pushed events for both additive roots and revokes only an acknowledged removed incarnation", async () => {
  const { workspaceApi, listenWorkspaceEvents } = await import("./workspace-api");
  vi.mocked(invoke).mockResolvedValueOnce({ root: "/a", scope: a });
  await workspaceApi.openWorkspace("/a");
  vi.mocked(invoke).mockResolvedValueOnce({ root: "/b", scope: b });
  await workspaceApi.addWorkspace("/b");
  const callback = vi.fn(); await listenWorkspaceEvents(callback);
  const receive = vi.mocked(listen).mock.calls[0][1] as (event: { payload: RootEvent[] }) => void;
  const events: RootEvent[] = [a, b].map((scope) => ({ scope, event: { type: "snapshot", payload: snapshot(scope) } }));
  receive({ payload: events });
  expect(callback).toHaveBeenLastCalledWith(events.map((entry) => entry.event));
  vi.mocked(invoke).mockResolvedValueOnce(null);
  await workspaceApi.removeWorkspace(a, "cancel");
  receive({ payload: events });
  expect(callback).toHaveBeenLastCalledWith(events.map((entry) => entry.event));
  vi.mocked(invoke).mockRejectedValueOnce({ code: "conflict" });
  await expect(workspaceApi.removeWorkspace(a, "save")).rejects.toEqual({ code: "conflict" });
  receive({ payload: events });
  expect(callback).toHaveBeenLastCalledWith(events.map((entry) => entry.event));
  vi.mocked(invoke).mockResolvedValueOnce({ root: "/a", scope: a });
  await workspaceApi.removeWorkspace(a, "discard");
  receive({ payload: events });
  expect(callback).toHaveBeenLastCalledWith([events[1].event]);
});

it("drops a polled event batch that completes after its root was removed", async () => {
  const { workspaceApi } = await import("./workspace-api");
  vi.mocked(invoke).mockResolvedValueOnce({ root: "/a", scope: a });
  await workspaceApi.openWorkspace("/a");
  vi.mocked(invoke).mockResolvedValueOnce({ root: "/b", scope: b });
  await workspaceApi.addWorkspace("/b");
  let finish!: (events: RootEvent[]) => void;
  vi.mocked(invoke).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const pending = workspaceApi.pollEvents(a);
  vi.mocked(invoke).mockResolvedValueOnce({ root: "/a", scope: a });
  await workspaceApi.removeWorkspace(a, "discard");
  finish([{ scope: a, event: { type: "snapshot", payload: snapshot(a) } }]);
  expect(await pending).toEqual([]);
  await workspaceApi.listWorkspace();
  expect(invoke).toHaveBeenLastCalledWith("list_workspace", { path: "", scope: b });
});

it("reconciles the default owner with native roots when restoring the session", async () => {
  const { workspaceApi } = await import("./workspace-api");
  vi.mocked(invoke).mockResolvedValueOnce({ root: "/a", scope: a });
  await workspaceApi.openWorkspace("/a");
  vi.mocked(invoke).mockResolvedValueOnce([{ root: "/b", scope: b }]);
  await workspaceApi.listWorkspaces();
  await workspaceApi.listWorkspace();
  expect(invoke).toHaveBeenLastCalledWith("list_workspace", { path: "", scope: b });
});
