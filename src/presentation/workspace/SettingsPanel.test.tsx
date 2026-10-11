import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
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
  it("opens on a single category instead of the long all-categories form", () => {
    renderPanel();
    expect(screen.getByLabelText("カラーテーマ")).toBeVisible();
    expect(screen.queryByLabelText("文字サイズ")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Neovim 設定ファイルのパス")).not.toBeInTheDocument();
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
