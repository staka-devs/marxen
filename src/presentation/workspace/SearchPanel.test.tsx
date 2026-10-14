import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { SearchPanel } from "./SearchPanel";
import { DEFAULT_SEARCH_OPTIONS } from "../../domain/search";
import type { SearchHitItem } from "../../domain/search-hit";

const hits: SearchHitItem[] = [
  { path: "dir/a.md", line: 1, col: 2, offset: 2, end: 5, preview: "😀cat cat", previewRange: { start: 2, end: 5 } },
  { path: "dir/a.md", line: 1, col: 6, offset: 6, end: 9, preview: "😀cat cat", previewRange: { start: 6, end: 9 } },
  { path: "b.txt", line: 2, col: 0, offset: 10, end: 13, preview: "dog", previewRange: { start: 0, end: 3 } },
];

/** Render a controlled panel and expose callbacks for exact action assertions. */
function setup(overrides: Partial<React.ComponentProps<typeof SearchPanel>> = {}) {
  const props = { query: "cat", onQuery: vi.fn(), hits, searching: false, canReplace: true,
    replaceText: "", onReplaceText: vi.fn(), onJump: vi.fn(), onReplaceOne: vi.fn(), onReplaceAll: vi.fn(),
    searchOptions: DEFAULT_SEARCH_OPTIONS, onSearchOptions: vi.fn(), searchError: null,
    searchLimit: null, resultsReady: true, replacing: false, ...overrides };
  return { props, ...render(<SearchPanel {...props} />) };
}

it("groups file counts and highlights each native span rather than rerunning a preview regex", () => {
  const { container } = setup({ query: "^(a+)+$" });
  expect(screen.getByText("3 件・2 ファイル")).toBeVisible();
  expect(container.querySelectorAll("mark")).toHaveLength(3);
  const first = screen.getAllByRole("button", { name: "dir/a.md 1 行目の一致へ移動" });
  expect(first[0].querySelector("mark")?.previousSibling?.textContent).toBe("😀");
  expect(first[1].querySelector("mark")?.previousSibling?.textContent).toBe("😀cat ");
  expect(first[0].querySelector("mark")).toHaveTextContent("cat");
  expect(screen.getAllByText("削除")).toHaveLength(3);
});

it("navigates expanded rows and leaves collapse/replace Enter events scoped to their buttons", () => {
  const { props } = setup();
  fireEvent.click(screen.getByRole("button", { name: "dir/a.md の一致を折りたたむ" }));
  expect(screen.queryByRole("button", { name: "dir/a.md 1 行目の一致へ移動" })).not.toBeInTheDocument();
  const visible = screen.getByRole("button", { name: "b.txt 2 行目の一致へ移動" });
  visible.focus(); fireEvent.keyDown(visible, { key: "ArrowDown" });
  expect(visible).toHaveFocus();
  fireEvent.click(visible);
  expect(props.onJump).toHaveBeenCalledWith(hits[2]);
  vi.mocked(props.onJump).mockClear();
  const replace = screen.getByRole("button", { name: "b.txtの一致を置換する" });
  fireEvent.keyDown(replace, { key: "Enter" }); fireEvent.click(replace);
  expect(props.onJump).not.toHaveBeenCalled();
  expect(props.onReplaceOne).toHaveBeenCalledWith(hits[2]);
  fireEvent.click(screen.getByRole("button", { name: "dir/a.md の一致を折りたたむ" }));
  fireEvent.keyDown(visible, { key: "Home" });
  expect(screen.getAllByRole("button", { name: "dir/a.md 1 行目の一致へ移動" })[0]).toHaveFocus();
});

it.each([{ searching: true }, { replacing: true }, { resultsReady: false }, { searchError: "invalid" }])("disables stale or busy result actions for %o", (overrides) => {
  setup(overrides);
  expect(screen.getByRole("button", { name: "すべて置換する" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "b.txtの一致を置換する" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "b.txt 2 行目の一致へ移動" })).toBeDisabled();
});

it("displays truncation and forbids replace-all while allowing validated single actions", () => {
  setup({ searchLimit: "matches" });
  expect(screen.getByText(/表示件数は全件数ではありません/)).toBeVisible();
  expect(screen.getByText("表示 3 件・2 ファイル以上")).toBeVisible();
  expect(screen.getByRole("button", { name: "すべて置換する" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "b.txtの一致を置換する" })).toBeEnabled();
});

it("connects all native options and exposes empty-match highlighting", () => {
  const { props } = setup({ hits: [{ ...hits[0], previewRange: { start: 2, end: 2 } }] });
  for (const [name, flag] of [["大文字と小文字を区別", "caseSensitive"], ["単語単位で検索", "wholeWord"], ["正規表現で検索", "regex"]]) {
    fireEvent.click(screen.getByRole("button", { name }));
    expect(props.onSearchOptions).toHaveBeenCalledWith({ ...DEFAULT_SEARCH_OPTIONS, [flag]: true });
  }
  expect(within(screen.getByTestId("search-panel")).getByLabelText("空の一致")).toBeVisible();
});
