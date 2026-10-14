import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useWorkspaceSearch } from "./useWorkspaceSearch";
import type { DocumentSession } from "./useDocumentSession";
import type { WorkspaceGateway } from "../../../application/ports";
import type { DocumentSnapshot, SearchMatch, SearchReplacePlan, SearchReplaceRequest, SearchResults, SaveRequest, TextEdit } from "../../../contracts/contracts";
import { applyTextEdits } from "../../../domain/coordinates/utf16";
import { StaleResync } from "../../../domain/document-errors";

/** Expose a controllable promise for lifecycle and mutation races. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** Exact native matches, including a supplementary scalar before the first range. */
function matches(): SearchMatch[] {
  return [
    { path: "a.md", documentId: "a", revision: 4, range: { start: 2, end: 5 }, line: 1, preview: "😀cat cat", previewRange: { start: 2, end: 5 }, contentToken: "a-searched" },
    { path: "a.md", documentId: "a", revision: 4, range: { start: 6, end: 9 }, line: 1, preview: "😀cat cat", previewRange: { start: 6, end: 9 }, contentToken: "a-searched" },
    { path: "notes.txt", documentId: null, revision: null, range: { start: 0, end: 3 }, line: 1, preview: "cat", previewRange: { start: 0, end: 3 }, contentToken: "b-searched" },
  ];
}

/** Native plan fixture; frontend deliberately does not match or expand a regex. */
function plan(request: SearchReplaceRequest): SearchReplacePlan {
  const isA = request.path === "a.md";
  return {
    document: { path: request.path, snapshot: { documentId: isA ? "a" : "b", revision: isA ? 4 : 8, text: isA ? "😀cat cat" : "cat", dirty: false } },
    edits: (request.range ? [request.range] : isA ? [{ start: 2, end: 5 }, { start: 6, end: 9 }] : [{ start: 0, end: 3 }]).map((range) => ({ range, text: request.replacement })),
  };
}

/** Minimal consumed session fake, correctly honoring all caller overrides. */
function makeSession(overrides: Partial<DocumentSession> = {}): DocumentSession {
  const source = new Map([["a", "😀cat cat"], ["b", "cat"]]);
  const registry = {
    noteSnapshot: vi.fn(),
    /** Apply the exact authoritative test plan when its lifecycle is current. */
    applyEdits: vi.fn(async (request: SaveRequest, edits: TextEdit[], current: () => boolean) => {
      if (!current()) throw new Error("cancelled");
      const text = applyTextEdits(source.get(request.documentId)!, edits);
      source.set(request.documentId, text);
      return { documentId: request.documentId, revision: request.baseRevision + 1, text, dirty: true };
    }),
  };
  return { registry, docs: {}, setDocs: vi.fn(), setTabs: vi.fn(), setActiveId: vi.fn(), mergeSnapshot: vi.fn(), jumpToOffset: vi.fn(), ...overrides } as unknown as DocumentSession;
}

/** Supply only the native search/planning operations consumed in these tests. */
function makeGateway(overrides: Partial<WorkspaceGateway> = {}): WorkspaceGateway {
  return { searchWorkspace: vi.fn().mockResolvedValue({ matches: matches(), limit: null }),
    /** Return a controlled authoritative plan, without frontend matching. */
    planSearchReplacement: vi.fn(async (request: SearchReplaceRequest) => plan(request)), ...overrides } as unknown as WorkspaceGateway;
}

/** Start a valid debounced query and drain its native response. */
async function search(result: { current: ReturnType<typeof useWorkspaceSearch> }) {
  act(() => result.current.setSearchQuery("cat"));
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

it("sends real options/root and applies exactly the selected successful native edit without saving", async () => {
  const gateway = makeGateway(); const session = makeSession(); const notify = vi.fn();
  const { result } = renderHook(() => useWorkspaceSearch({ desktop: true, root: "root", gateway, session, notify }));
  await search(result);
  act(() => result.current.setReplaceText("$1"));
  await act(async () => result.current.replaceOne(result.current.registryHits[1]));
  expect(gateway.searchWorkspace).toHaveBeenCalledWith("cat", { caseSensitive: false, wholeWord: false, regex: false }, "root");
  expect(gateway.planSearchReplacement).toHaveBeenCalledWith(expect.objectContaining({ range: { start: 6, end: 9 }, contentToken: "a-searched", revision: 4 }));
  expect(session.registry!.applyEdits).toHaveBeenCalledWith({ documentId: "a", baseRevision: 4 }, [{ range: { start: 6, end: 9 }, text: "$1" }], expect.any(Function));
  expect(session.mergeSnapshot).toHaveBeenCalledWith(expect.objectContaining({ text: "😀cat $1", revision: 5, dirty: true }));
});

it("replaces all native spans across Markdown/text files once and reports exact acknowledgements", async () => {
  const gateway = makeGateway(); const session = makeSession(); const notify = vi.fn();
  const { result } = renderHook(() => useWorkspaceSearch({ desktop: true, root: "root", gateway, session, notify }));
  await search(result);
  await act(async () => result.current.replaceAllMatches());
  expect(gateway.planSearchReplacement).toHaveBeenCalledTimes(2);
  expect(session.mergeSnapshot).toHaveBeenCalledWith(expect.objectContaining({ text: "😀 ", dirty: true }));
  expect(session.mergeSnapshot).toHaveBeenCalledWith(expect.objectContaining({ documentId: "b", text: "", dirty: true }));
  expect(notify).toHaveBeenCalledWith(expect.objectContaining({ key: "{{count}} 件を置換しました。", parameters: { count: 3 } }));
});

it.each(["query", "options", "root", "unmount"])("fences a pending replacement plan across %s changes", async (kind) => {
  const pending = deferred<SearchReplacePlan>();
  const gateway = makeGateway({
    /** Hold native preparation until the context changes. */
    planSearchReplacement: vi.fn(() => pending.promise) }); const session = makeSession();
  const { result, rerender, unmount } = renderHook(({ root }) => useWorkspaceSearch({ desktop: true, root, gateway, session, notify: vi.fn() }), { initialProps: { root: "root" } });
  await search(result);
  let running!: Promise<void>;
  act(() => { running = result.current.replaceAllMatches(); });
  if (kind === "query") act(() => result.current.setSearchQuery("other"));
  if (kind === "options") act(() => result.current.setSearchOptions({ caseSensitive: true, wholeWord: false, regex: false }));
  if (kind === "root") rerender({ root: "other" });
  if (kind === "unmount") unmount();
  await act(async () => { pending.resolve(plan({ path: "a.md", replacement: "", range: null } as SearchReplaceRequest)); await running; });
  expect(session.registry!.applyEdits).not.toHaveBeenCalled();
  expect(session.setDocs).not.toHaveBeenCalled();
});

it("rejects stale hit actions and a second mutation while a plan is pending", async () => {
  const pending = deferred<SearchReplacePlan>(); const gateway = makeGateway({
    /** Hold a mutation plan to verify simultaneous action rejection. */
    planSearchReplacement: vi.fn(() => pending.promise) }); const session = makeSession();
  const { result } = renderHook(() => useWorkspaceSearch({ desktop: true, root: "root", gateway, session, notify: vi.fn() }));
  await search(result);
  const hit = result.current.registryHits[0]; let running!: Promise<void>;
  act(() => { running = result.current.replaceOne(hit); });
  await act(async () => { await result.current.replaceOne(hit); await result.current.replaceAllMatches(); await result.current.jumpToHit(hit); });
  expect(gateway.planSearchReplacement).toHaveBeenCalledTimes(1);
  act(() => result.current.setSearchQuery("new"));
  await act(async () => { pending.resolve(plan({ path: "a.md", replacement: "", range: hit.previewRange } as SearchReplaceRequest)); await running; await result.current.replaceOne(hit); });
  expect(session.registry!.applyEdits).not.toHaveBeenCalled();
});

it("does not claim replace-all over an explicitly truncated result set", async () => {
  const gateway = makeGateway({ searchWorkspace: vi.fn().mockResolvedValue({ matches: matches(), limit: "matches" }) });
  const { result } = renderHook(() => useWorkspaceSearch({ desktop: true, root: "root", gateway, session: makeSession(), notify: vi.fn() }));
  await search(result); await act(async () => result.current.replaceAllMatches());
  expect(result.current.searchLimit).toBe("matches");
  expect(gateway.planSearchReplacement).not.toHaveBeenCalled();
});

it("reports partial stale outcomes and refreshes after an acknowledged earlier file", async () => {
  const session = makeSession(); const notify = vi.fn(); const gateway = makeGateway();
  vi.mocked(session.registry!.applyEdits).mockImplementationOnce(async () => ({ documentId: "a", revision: 5, text: "😀 ", dirty: true })).mockRejectedValueOnce(new StaleResync({ documentId: "b", revision: 9, text: "changed", dirty: true }));
  const { result } = renderHook(() => useWorkspaceSearch({ desktop: true, root: "root", gateway, session, notify }));
  await search(result); await act(async () => result.current.replaceAllMatches());
  expect(notify).toHaveBeenCalledWith(expect.objectContaining({ parameters: expect.objectContaining({ count: 2, files: 1 }) }));
  expect(session.mergeSnapshot).toHaveBeenCalledWith(expect.objectContaining({ documentId: "b", text: "changed" }));
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  expect(gateway.searchWorkspace).toHaveBeenCalledTimes(2);
});

it.each(["resolve", "reject"])("ignores obsolete search %s and finally callbacks after new query/root/unmount", async (settlement) => {
  const pending = deferred<SearchResults>(); const gateway = makeGateway({ searchWorkspace: vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue({ matches: [], limit: null }) });
  const notify = vi.fn(); const { result, rerender, unmount } = renderHook(({ root }) => useWorkspaceSearch({ desktop: true, root, gateway, session: makeSession(), notify }), { initialProps: { root: "root" } });
  await search(result);
  act(() => result.current.setSearchQuery("new")); rerender({ root: "new-root" });
  await act(async () => { settlement === "resolve" ? pending.resolve({ matches: matches(), limit: null }) : pending.reject({ code: "search_pattern" }); });
  expect(result.current.registryHits).toEqual([]);
  expect(result.current.searching).toBe(true);
  expect(result.current.searchError).toBeNull();
  unmount(); await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  expect(notify).not.toHaveBeenCalled();
});

it("opens validated text-file results and navigates their exact native UTF-16 range", async () => {
  const gateway = makeGateway(); const session = makeSession();
  const { result } = renderHook(() => useWorkspaceSearch({ desktop: true, root: "root", gateway, session, notify: vi.fn() }));
  await search(result); await act(async () => result.current.jumpToHit(result.current.registryHits[2]));
  expect(session.jumpToOffset).toHaveBeenCalledWith("b", 0, 3);
  expect(session.registry!.applyEdits).not.toHaveBeenCalled();
});

it("invalidates result actions when an authoritative open-document revision changes", async () => {
  const gateway = makeGateway(); const session = makeSession();
  const { result, rerender } = renderHook(({ docs }) => useWorkspaceSearch({ desktop: true, root: "root", gateway, session: { ...session, docs }, notify: vi.fn() }), { initialProps: { docs: {} as DocumentSession["docs"] } });
  await search(result); const old = result.current.registryHits[0];
  rerender({ docs: { a: { documentId: "a", path: "a.md", revision: 5, text: "changed", dirty: true } } });
  expect(result.current.resultsReady).toBe(false);
  await act(async () => { await result.current.replaceOne(old); await result.current.jumpToHit(old); });
  expect(gateway.planSearchReplacement).not.toHaveBeenCalled();
});

it("reports a native closed-content rejection without sending an edit and then refreshes", async () => {
  const gateway = makeGateway({ planSearchReplacement: vi.fn().mockRejectedValue({ code: "stale_search" }) });
  const session = makeSession(); const notify = vi.fn();
  const { result } = renderHook(() => useWorkspaceSearch({ desktop: true, root: "root", gateway, session, notify }));
  await search(result); await act(async () => result.current.replaceOne(result.current.registryHits[2]));
  expect(session.registry!.applyEdits).not.toHaveBeenCalled();
  expect(notify).toHaveBeenCalledWith(expect.objectContaining({ parameters: expect.objectContaining({ count: 0, files: 0 }) }));
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  expect(gateway.searchWorkspace).toHaveBeenCalledTimes(2);
});

it("does not admit an old search response after a mutation's newer refresh", async () => {
  const pending = deferred<SearchResults>(); const gateway = makeGateway(); const session = makeSession();
  const { result } = renderHook(() => useWorkspaceSearch({ desktop: true, root: "root", gateway, session, notify: vi.fn() }));
  await search(result);
  // A mutation revokes all previous result actions synchronously.
  vi.mocked(gateway.searchWorkspace).mockReturnValueOnce(pending.promise);
  await act(async () => result.current.replaceOne(result.current.registryHits[0]));
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  act(() => result.current.setSearchQuery("new"));
  await act(async () => { pending.resolve({ matches: matches(), limit: null }); });
  expect(result.current.registryHits).toEqual([]);
  expect(result.current.searching).toBe(true);
});

it("normalizes sample lines and UTF-16 spans, excludes images and signals a sample limit", () => {
  const session = makeSession({ docs: {
    "a.md": { documentId: "a.md", path: "a.md", revision: 0, text: "😀cat\n" + "cat ".repeat(51), dirty: false },
    "image.png": { documentId: "image.png", path: "image.png", revision: 0, text: "cat", dirty: false },
  } });
  const { result } = renderHook(() => useWorkspaceSearch({ desktop: false, root: null, session, notify: vi.fn() }));
  act(() => result.current.setSearchQuery("cat"));
  expect(result.current.localHits).toHaveLength(50);
  expect(result.current.localHits[0]).toMatchObject({ line: 1, offset: 2, end: 5, previewRange: { start: 2, end: 5 } });
  expect(result.current.searchLimit).toBe("matches");
  expect(result.current.localHits.every((hit) => hit.path !== "image.png")).toBe(true);
});

it("keeps search actions suspended until every pending root-open operation settles", async () => {
  const gateway = makeGateway(); const session = makeSession();
  const { result } = renderHook(() => useWorkspaceSearch({ desktop: true, root: "root", gateway, session, notify: vi.fn() }));
  await search(result); const old = result.current.registryHits[0];
  act(() => { result.current.suspend(); result.current.suspend(); result.current.setSearchQuery("new"); result.current.resume(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(300); await result.current.replaceOne(old); });
  expect(gateway.searchWorkspace).toHaveBeenCalledTimes(1);
  expect(gateway.planSearchReplacement).not.toHaveBeenCalled();
  act(() => result.current.resume());
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  expect(gateway.searchWorkspace).toHaveBeenCalledTimes(2);
});

it("reports an already-accepted native edit after query cancellation and stops later files", async () => {
  const pending = deferred<DocumentSnapshot>(); const gateway = makeGateway(); const session = makeSession(); const notify = vi.fn();
  vi.mocked(session.registry!.applyEdits).mockReturnValueOnce(pending.promise);
  const { result } = renderHook(() => useWorkspaceSearch({ desktop: true, root: "root", gateway, session, notify }));
  await search(result); let running!: Promise<void>;
  await act(async () => { running = result.current.replaceAllMatches(); await Promise.resolve(); });
  expect(session.registry!.applyEdits).toHaveBeenCalledTimes(1);
  act(() => result.current.setSearchQuery("new"));
  await act(async () => { pending.resolve({ documentId: "a", revision: 5, text: "😀 ", dirty: true }); await running; });
  expect(gateway.planSearchReplacement).toHaveBeenCalledTimes(1);
  expect(session.mergeSnapshot).toHaveBeenCalledWith(expect.objectContaining({ text: "😀 ", dirty: true }));
  expect(notify).toHaveBeenCalledWith(expect.objectContaining({ parameters: expect.objectContaining({ count: 2, files: 1 }) }));
});
