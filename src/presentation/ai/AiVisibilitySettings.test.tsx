import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdvertisedAiProvider, AiViewPreferences } from "../../contracts/ai-view-preferences";
import { defaultAiViewPreferences } from "../../domain/ai-view-preferences";
import { AiVisibilityDialog, AiVisibilitySettings } from "./AiVisibilitySettings";
import { useAiViewPreferences } from "./useAiViewPreferences";

afterEach(cleanup);
const advertisedProviders: AdvertisedAiProvider[] = [{ provider: "codex", discovered: true, options: [{ id: "actual.model.option", name: "Models", category: "model", currentValue: "reported/v1", options: [{ value: "reported/v1", name: "Reported One" }, { value: "reported/v2", name: "Reported Two" }] }] }, { provider: "opencode", discovered: true, options: [] }];

/** Exercise shared state and persistence with real management controls. */
function Harness({ save = () => true }: {
  /** Record each view-only persistence request. */
  save?: (preferences: AiViewPreferences) => boolean;
}) {
  const view = useAiViewPreferences({ load: defaultAiViewPreferences, save });
  return <><AiVisibilitySettings preferences={view.preferences} onPreferences={view.updatePreferences} advertisedProviders={advertisedProviders} saveFailed={view.saveFailed} /><output data-testid="prefs">{JSON.stringify(view.preferences)}</output></>;
}

describe("AI visibility management", () => {
  it("keeps the section heading and labels saved width as a preference", () => {
    render(<AiVisibilitySettings preferences={{ ...defaultAiViewPreferences(), chatPaneWidth: 480 }} onPreferences={vi.fn()} advertisedProviders={[]} />);
    expect(screen.getByRole("heading", { name: "AI の表示設定" })).toBeVisible();
    expect(screen.getByText("希望するチャット幅: 480px")).toBeVisible();
  });
  it("searches actual IDs and independently persists model, provider and selector switches", () => {
    const save = vi.fn().mockReturnValue(true);
    render(<Harness save={save} />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "reported/v2" } });
    expect(screen.getByRole("checkbox", { name: "Reported Two を表示" })).toBeChecked();
    expect(screen.queryByRole("checkbox", { name: "Reported One を表示" })).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "Reported Two を表示" }));
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ hiddenModels: [{ provider: "codex", optionId: "actual.model.option", value: "reported/v2" }] }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Codex の候補を表示" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "チャットにモデルの選択欄を表示" }));
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ hiddenProviders: ["codex"], showModelSelector: false }));
  });
  it("distinguishes empty and unknown catalogs, reports no matches and persistence failure", () => {
    render(<Harness save={() => false} />);
    expect(screen.getByText("この接続先はモデル候補を公開していません。CLI の設定を使用します。")).toBeVisible();
    expect(screen.getAllByText("この接続先のモデル候補は未取得です。チャットで接続を確認してください。")).toHaveLength(2);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "no-such-advertised-id" } });
    expect(screen.getByText("一致する接続先やモデルがありません。")).toHaveAttribute("role", "status");
    fireEvent.click(screen.getByRole("checkbox", { name: "チャットに接続先の選択欄を表示" }));
    expect(screen.getByRole("alert")).toHaveTextContent("設定を保存できませんでした");
  });
  it("inherits theme, traps focus and returns to its opener after Escape", () => {
    const onClose = vi.fn();
    const { rerender } = render(<div data-theme="contrast"><button>Manage</button></div>);
    const opener = screen.getByRole("button"); opener.focus();
    rerender(<div data-theme="contrast"><button>Manage</button><AiVisibilityDialog preferences={defaultAiViewPreferences()} onPreferences={vi.fn()} advertisedProviders={[]} onClose={onClose} /></div>);
    expect(screen.getByRole("dialog").closest("[data-theme]")).toHaveAttribute("data-theme", "contrast");
    expect(within(screen.getByRole("dialog")).getAllByText("AI の表示設定")).toHaveLength(1);
    expect(screen.getByRole("searchbox")).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
    rerender(<div data-theme="contrast"><button>Manage</button></div>);
    expect(opener).toHaveFocus();
  });
});
