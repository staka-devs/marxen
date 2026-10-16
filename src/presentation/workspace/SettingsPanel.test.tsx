import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsPanel } from "./SettingsPanel";
import { DEFAULT_EDITOR_PREFERENCES } from "../../domain/editor-preferences";

/**
 * Render the settings dialog with minimal required props for assertions.
 */
function renderPanel() {
  return render(
    <SettingsPanel
      theme="dark"
      onTheme={() => undefined}
      preferences={DEFAULT_EDITOR_PREFERENCES}
      onPreferences={() => undefined}
      configPath=""
      configError={null}
      onConfigPath={() => undefined}
      onApplyConfig={() => undefined}
      applyingConfig={false}
      currentConfig={null}
      copyKeys={{}}
      aiSettings={<div>AI設定</div>}
      onClose={() => undefined}
    />,
  );
}

beforeEach(() => window.localStorage.clear());

describe("settings panel categories", () => {
  it("opens with useful settings across categories and keeps category navigation", () => {
    renderPanel();
    expect(screen.getByLabelText("カラーテーマ")).toBeVisible();
    expect(screen.getByLabelText("文字サイズ")).toBeVisible();
    expect(screen.getByLabelText("Neovim 設定ファイルのパス")).toBeVisible();
    expect(screen.getByLabelText("通知の表示位置")).toHaveValue("bottom-right");
    expect(screen.getByRole("button", { name: "すべて" })).toHaveAttribute("aria-current", "page");
  });

  it("updates every notification anchor without discarding other preferences", () => {
    const change = vi.fn();
    render(<SettingsPanel theme="dark" onTheme={() => {}} preferences={{ ...DEFAULT_EDITOR_PREFERENCES, fontSize: 21 }} onPreferences={change} configPath="" configError={null} onConfigPath={() => {}} onApplyConfig={() => {}} applyingConfig={false} currentConfig={null} onClose={() => {}} />);
    const select = screen.getByLabelText("通知の表示位置");
    expect(select.querySelectorAll("option")).toHaveLength(6);
    for (const position of ["top-left", "top-center", "top-right", "bottom-left", "bottom-center", "bottom-right"]) {
      fireEvent.change(select, { target: { value: position } });
      expect(change).toHaveBeenLastCalledWith({ ...DEFAULT_EDITOR_PREFERENCES, fontSize: 21, notificationPosition: position });
    }
    fireEvent.change(screen.getByLabelText("設定を検索"), { target: { value: "通知" } });
    expect(select).toBeVisible();
    expect(screen.queryByLabelText("文字サイズ")).not.toBeInTheDocument();
  });

  it("renders injected AI visibility controls and preserves notification position on editor reset", () => {
    const change = vi.fn();
    render(<SettingsPanel theme="light" onTheme={() => {}} preferences={{ ...DEFAULT_EDITOR_PREFERENCES, notificationPosition: "top-center" }} onPreferences={change} configPath="" configError={null} onConfigPath={() => {}} onApplyConfig={() => {}} applyingConfig={false} currentConfig={null} aiVisibilitySettings={<div>AI visibility controls</div>} onClose={() => {}} />);
    expect(screen.getByText("AI visibility controls")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "エディター設定をリセット" }));
    expect(change).toHaveBeenLastCalledWith({ ...DEFAULT_EDITOR_PREFERENCES, theme: "light", notificationPosition: "top-center" });
  });

  it("keeps search focused, traps Tab and restores the previous editor focus", () => {
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue({ length: 1 } as DOMRectList);
    const editor = document.createElement("textarea");
    document.body.append(editor); editor.focus();
    const view = renderPanel();
    expect(document.activeElement).toBe(screen.getByLabelText("設定を検索"));
    const first = screen.getByRole("button", { name: "設定を閉じる" });
    const last = screen.getByRole("button", { name: "設定を適用して再起動する" });
    last.focus(); fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
    view.unmount(); expect(document.activeElement).toBe(editor);
    editor.remove(); vi.restoreAllMocks();
  });

  it("removes the decorative preview", () => {
    renderPanel();
    expect(screen.queryByText("日本語のメモと Markdown")).not.toBeInTheDocument();
  });

  it("searches across categories and switches to matching rows", () => {
    renderPanel();
    fireEvent.change(screen.getByLabelText("設定を検索"), { target: { value: "文字サイズ" } });
    expect(screen.getByLabelText("文字サイズ")).toBeVisible();
    expect(screen.queryByLabelText("カラーテーマ")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Vim" }));
    fireEvent.change(screen.getByLabelText("設定を検索"), { target: { value: "Neovim" } });
    expect(screen.getByLabelText("Neovim 設定ファイルのパス")).toBeVisible();
  });
});
