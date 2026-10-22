import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { FindBar } from "./FindBar";
import { useWorkspaceSearch } from "../shell/hooks/useWorkspaceSearch";
import type { SearchHitItem } from "../../domain/search-hit";
import type { WorkspaceGateway } from "../../application/ports";
import type { DocumentSession } from "../shell/hooks/useDocumentSession";

afterEach(() => { cleanup(); vi.useRealTimers(); });

const hits = [{ path: "a.md", offset: 0, end: 3 }, { path: "a.md", offset: 10, end: 13 }] as SearchHitItem[];

/** Render the bar with spies for every callback. */
function renderBar(props: Partial<Parameters<typeof FindBar>[0]> = {}) {
  const spies = { onQuery: vi.fn(), onOptions: vi.fn(), onReplaceText: vi.fn(), onJump: vi.fn(), onReplaceOne: vi.fn(), onReplaceAll: vi.fn(), onClose: vi.fn() };
  render(<FindBar query="foo" options={{ caseSensitive: false, wholeWord: false, regex: false }} hits={hits} searching={false} ready error={null} replaceText="" {...spies} {...props} />);
  return spies;
}

it("counts matches, steps with Enter / Shift+Enter, toggles options and closes on Escape", () => {
  const spies = renderBar();
  const input = screen.getByRole("textbox", { name: "検索" });
  expect(input).toHaveFocus();
  expect(screen.getByRole("status")).toHaveTextContent("1 / 2");
  fireEvent.keyDown(input, { key: "Enter" });
  expect(spies.onJump).toHaveBeenLastCalledWith(hits[1]);
  expect(screen.getByRole("status")).toHaveTextContent("2 / 2");
  fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
  expect(spies.onJump).toHaveBeenLastCalledWith(hits[0]);
  fireEvent.click(screen.getByRole("button", { name: "正規表現" }));
  expect(spies.onOptions).toHaveBeenCalledWith({ caseSensitive: false, wholeWord: false, regex: true });
  fireEvent.keyDown(input, { key: "Escape" });
  expect(spies.onClose).toHaveBeenCalledOnce();
});

it("replaces the current match or all matches from the replace row", () => {
  const spies = renderBar();
  fireEvent.click(screen.getByRole("button", { name: "置換の切り替え" }));
  fireEvent.click(screen.getByRole("button", { name: "置換" }));
  expect(spies.onReplaceOne).toHaveBeenCalledWith(hits[0]);
  fireEvent.click(screen.getByRole("button", { name: "すべて置換" }));
  expect(spies.onReplaceAll).toHaveBeenCalledOnce();
});

it("keeps only the scoped file's matches and stays idle without a file", async () => {
  vi.useFakeTimers();
  const scope = { rootId: "r", generation: "1" };
  /** One native match in the given file. */
  const match = (path: string) => ({ path, scope, range: { start: 0, end: 1 }, line: 0, preview: "x", contentToken: "t", revision: null });
  /** Native search returning hits in two files. */
  const searchWorkspace = vi.fn(async () => ({ matches: [match("a.md"), match("b.md")], limit: null }));
  const gateway = { searchWorkspace } as unknown as WorkspaceGateway;
  const session = { docs: {} } as unknown as DocumentSession;
  const roots = [{ root: "C:/w", scope }] as never;
  const { result, rerender } = renderHook(({ path }) => useWorkspaceSearch({ desktop: true, root: "C:/w", roots, gateway, session, notify: vi.fn(), only: { path, scope } }), { initialProps: { path: "" } });
  act(() => result.current.setSearchQuery("x"));
  await act(async () => { await vi.advanceTimersByTimeAsync(400); });
  expect(searchWorkspace).not.toHaveBeenCalled();
  rerender({ path: "a.md" });
  await act(async () => { await vi.advanceTimersByTimeAsync(400); });
  expect(result.current.registryHits.map((hit) => hit.path)).toEqual(["a.md"]);
});
