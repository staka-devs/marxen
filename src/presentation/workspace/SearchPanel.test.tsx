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

/** Open the explicit replacement disclosure for opt-in action assertions. */
function openReplacement() {
  fireEvent.click(screen.getByRole("button", { name: "置換を表示する" }));
}

it("groups file counts and highlights each native span rather than rerunning a preview regex", () => {
  const { container } = setup({ query: "^(a+)+$" });
  expect(screen.getByText("3 件・2 ファイル")).toBeVisible();
  expect(container.querySelectorAll("mark")).toHaveLength(3);
  const first = screen.getAllByRole("button", { name: "dir/a.md 1 行目の一致へ移動" });
  expect(first[0].querySelector("mark")?.previousSibling?.textContent).toBe("😀");
  expect(first[1].querySelector("mark")?.previousSibling?.textContent).toBe("😀cat ");
  expect(first[0].querySelector("mark")).toHaveTextContent("cat");
  for (const button of first) {
    const titled = button.querySelector("span[title]");
    expect(titled?.getAttribute("title")).toBe("😀cat cat");
    expect(button.querySelector("span.truncate")).not.toBeNull();
    expect(titled?.querySelector("mark")).not.toBeNull();
    expect(titled?.querySelector("mark")?.className).toContain("shrink-0");
  }
  const fileToggle = screen.getByRole("button", { name: "dir/a.md の一致を折りたたむ" });
  expect(fileToggle).toHaveAttribute("title", "dir/a.md");
});

it("keeps a long ASCII/Unicode/emoji prefix compact while the native mark stays identifiable", () => {
  const longPreview = "0123456789-ABCDEFGHIJ-あいうえおかきくけこさしすせそ-😀-0123456789ABCDEFGHIJ-検索-あいうえお-tail-0123456789";
  const longHit: SearchHitItem = { path: "notes/long-prefix.md", line: 3, col: 62, offset: 200, end: 202, preview: longPreview, previewRange: { start: 62, end: 64 } };
  setup({ hits: [longHit], query: "検索" });
  expect(screen.getByText("1 件・1 ファイル")).toBeVisible();
  const button = screen.getByRole("button", { name: "notes/long-prefix.md 3 行目の一致へ移動" });
  const titled = button.querySelector("span[title]");
  expect(titled?.getAttribute("title")).toBe(longPreview);
  const mark = button.querySelector("mark");
  expect(mark).toHaveTextContent("検索");
  expect(mark?.className).toContain("shrink-0");
  expect(mark?.previousSibling?.textContent).toBe(longPreview.slice(0, 62));
  expect(mark?.nextSibling?.textContent).toBe(longPreview.slice(64));
  expect(button.querySelectorAll("span.truncate")).toHaveLength(2);
  for (const part of button.querySelectorAll("span.truncate")) {
    expect(part.className).toContain("shrink");
    expect(part.className).not.toContain("flex-1");
  }
});

it("truncates a long basename on one line while keeping the full path title", () => {
  const longPath = "docs/0123456789-ABCDEFGHIJ-あいうえおかきくけこさしすせそ-😀-very-long-basename-for-truncation-test-0123456789.md";
  const longBaseHit: SearchHitItem = { path: longPath, line: 1, col: 0, offset: 300, end: 302, preview: "検索-test", previewRange: { start: 0, end: 2 } };
  const { container } = setup({ hits: [longBaseHit], query: "検索" });
  const toggle = screen.getByRole("button", { name: `${longPath} の一致を折りたたむ` });
  expect(toggle).toHaveAttribute("title", longPath);
  expect(toggle.querySelectorAll("span.truncate").length).toBeGreaterThanOrEqual(2);
  for (const part of toggle.querySelectorAll("span[title]")) {
    expect(part.getAttribute("title")).toBe(longPath);
  }
  for (const icon of toggle.querySelectorAll("svg")) {
    expect(icon.getAttribute("class")).toContain("shrink-0");
  }
  expect(container.querySelector('[aria-controls="search-replace-panel"]')?.querySelector("svg")?.getAttribute("class")).toContain("shrink-0");
});

it("hides replacement input, previews, and one/all actions until the explicit toggle is opened", () => {
  setup();
  const toggle = screen.getByRole("button", { name: "置換を表示する" });
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(toggle).toHaveAttribute("aria-controls", "search-replace-panel");
  expect(screen.queryByLabelText("置換後の文字列")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "すべて置換する" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "b.txtの一致を置換する" })).not.toBeInTheDocument();
  expect(screen.queryByText("削除")).not.toBeInTheDocument();
  expect(screen.queryByText("置換後:")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "b.txt 2 行目の一致へ移動" })).toBeEnabled();
});

it("shows explicit empty deletion only after opt-in and preserves typed text across folds", () => {
  const { props, rerender } = setup();
  openReplacement();
  expect(screen.getByRole("button", { name: "置換を隠す" })).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByLabelText("置換後の文字列")).toHaveValue("");
  expect(screen.getAllByText("削除")).toHaveLength(3);
  const input = screen.getByLabelText("置換後の文字列");
  fireEvent.change(input, { target: { value: "置換済み" } });
  expect(props.onReplaceText).toHaveBeenCalledWith("置換済み");
  rerender(<SearchPanel {...props} replaceText="置換済み" />);
  expect(screen.queryByText("削除")).not.toBeInTheDocument();
  expect(screen.getAllByText("置換済み")).toHaveLength(3);
  fireEvent.click(screen.getByRole("button", { name: "置換を隠す" }));
  expect(screen.queryByLabelText("置換後の文字列")).not.toBeInTheDocument();
  expect(screen.queryByText("置換後:")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "b.txt 2 行目の一致へ移動" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "置換を表示する" }));
  expect(screen.getByLabelText("置換後の文字列")).toHaveValue("置換済み");
  expect(screen.getAllByText("置換済み")).toHaveLength(3);
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
  openReplacement();
  const replace = screen.getByRole("button", { name: "b.txtの一致を置換する" });
  expect(replace).toHaveAttribute("title", "b.txtの一致を置換する");
  fireEvent.keyDown(replace, { key: "Enter" }); fireEvent.click(replace);
  expect(props.onJump).not.toHaveBeenCalled();
  expect(props.onReplaceOne).toHaveBeenCalledWith(hits[2]);
  fireEvent.click(screen.getByRole("button", { name: "dir/a.md の一致を折りたたむ" }));
  fireEvent.keyDown(visible, { key: "Home" });
  expect(screen.getAllByRole("button", { name: "dir/a.md 1 行目の一致へ移動" })[0]).toHaveFocus();
});

it.each([{ searching: true }, { replacing: true }, { resultsReady: false }, { searchError: "invalid" }])("disables stale or busy result actions for %o", (overrides) => {
  setup(overrides);
  expect(screen.getByRole("button", { name: "b.txt 2 行目の一致へ移動" })).toBeDisabled();
  expect(screen.queryByRole("button", { name: "すべて置換する" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "b.txtの一致を置換する" })).not.toBeInTheDocument();
  openReplacement();
  expect(screen.getByRole("button", { name: "すべて置換する" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "b.txtの一致を置換する" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "b.txt 2 行目の一致へ移動" })).toBeDisabled();
});

it("displays truncation and forbids replace-all while allowing validated single actions", () => {
  setup({ searchLimit: "matches" });
  openReplacement();
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

it("keeps replacement folded while file collapse still navigates ordinary results", () => {
  setup({ replaceText: "kept" });
  fireEvent.click(screen.getByRole("button", { name: "dir/a.md の一致を折りたたむ" }));
  expect(screen.queryByRole("button", { name: "dir/a.md 1 行目の一致へ移動" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "b.txt 2 行目の一致へ移動" })).toBeEnabled();
  expect(screen.queryByLabelText("置換後の文字列")).not.toBeInTheDocument();
  openReplacement();
  expect(screen.getByLabelText("置換後の文字列")).toHaveValue("kept");
  expect(screen.getAllByText("kept")).toHaveLength(1);
});

it("groups equal relative paths by root and collapses only the chosen owner's matches", () => {
  const scoped = [
    { ...hits[0], root: "/alpha", path: "same.md", scope: { rootId: "root-a", generation: "1" } },
    { ...hits[0], root: "/beta", path: "same.md", scope: { rootId: "root-b", generation: "1" } },
  ];
  const { props } = setup({ hits: scoped });
  expect(screen.getByText("2 件・2 ファイル")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "alpha/same.md の一致を折りたたむ" }));
  expect(screen.queryByRole("button", { name: "alpha/same.md 1 行目の一致へ移動" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "beta/same.md 1 行目の一致へ移動" }));
  expect(props.onJump).toHaveBeenCalledExactlyOnceWith(scoped[1]);
});
