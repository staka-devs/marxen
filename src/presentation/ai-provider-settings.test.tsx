import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AiProviderSettings, { describeProviderSummary } from "./ai-provider-settings";
import { defaultProviderConfig } from "../domain/ai-config";
import { I18nProvider } from "./i18n/I18nProvider";
import { createTranslator } from "../infrastructure/localization/i18next-translator";

beforeEach(() => {
  vi.resetAllMocks();
  window.localStorage.clear();
});

describe("provider settings", () => {
  it.each([
    ["ja-JP", "codex", "codex-acp のインストールが必要です。"],
    ["en-US", "codex", "Install codex-acp to connect."],
  ] as const)("shows the %s installation requirement for %s", (language, preset, description) => {
    const provider = defaultProviderConfig("acp");
    provider.acp!.preset = preset;
    render(<I18nProvider language={language} createTranslator={createTranslator}><AiProviderSettings embedded provider={provider} onProvider={vi.fn()} /></I18nProvider>);
    expect(screen.getByText(description)).toBeVisible();
  });

  it("mounts the dialog inside the live theme scope above its panel", () => {
    render(<div data-theme="dark" data-testid="theme-scope"><aside><AiProviderSettings provider={defaultProviderConfig("acp")} onProvider={vi.fn()} /></aside></div>);
    fireEvent.click(screen.getByRole("button", { name: /接続設定/ }));
    const dialog = screen.getByRole("dialog", { name: "接続設定" });
    expect(dialog.closest("[data-theme]")).toBe(screen.getByTestId("theme-scope"));
    expect(dialog.closest("aside")).toBeNull();
    screen.getByTestId("theme-scope").setAttribute("data-theme", "light");
    expect(dialog.closest("[data-theme]")).toHaveAttribute("data-theme", "light");
  });

  it("opens the dialog when the open token increments", () => {
    const onProvider = vi.fn();
    const { rerender } = render(
      <AiProviderSettings provider={defaultProviderConfig("acp")} onProvider={onProvider} openToken={0} />,
    );
    expect(screen.queryByRole("dialog", { name: "接続設定" })).not.toBeInTheDocument();
    rerender(
      <AiProviderSettings provider={defaultProviderConfig("acp")} onProvider={onProvider} openToken={1} />,
    );
    expect(screen.getByRole("dialog", { name: "接続設定" })).toBeVisible();
    expect(screen.getByRole("dialog", { name: "接続設定" })).toHaveAttribute("aria-modal", "true");
  });

  it("summarizes the connection name without claiming success", () => {
    expect(describeProviderSummary(defaultProviderConfig("acp"))).toBe("Codex");
    const openai = defaultProviderConfig("openai_compatible");
    openai.openai!.model = "local-model";
    expect(describeProviderSummary(openai)).toBe("OpenAI Chat Completions • local-model");
    const onProvider = vi.fn();
    render(<AiProviderSettings provider={openai} onProvider={onProvider} openToken={1} />);
    expect(screen.getByTestId("ai-provider-settings")).toHaveTextContent("OpenAI Chat Completions • local-model");
    expect(screen.queryByText(/接続済み|接続成功/)).not.toBeInTheDocument();
  });

  it("keeps the long form collapsed so the composer stays visible", () => {
    const onProvider = vi.fn();
    render(<AiProviderSettings provider={defaultProviderConfig("acp")} onProvider={onProvider} openToken={0} />);
    expect(screen.queryByRole("dialog", { name: "接続設定" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /接続設定/ })).toBeVisible();
  });

  it("opens with the trigger and keeps direct model input usable", () => {
    const onProvider = vi.fn();
    const openai = defaultProviderConfig("openai_compatible");
    openai.openai!.model = "local-model";
    render(<AiProviderSettings provider={openai} onProvider={onProvider} openToken={0} />);
    fireEvent.click(screen.getByRole("button", { name: /接続設定/ }));
    expect(screen.getByRole("dialog", { name: "接続設定" })).toBeVisible();
    expect(screen.getByLabelText("モデル")).toHaveValue("local-model");
    fireEvent.change(screen.getByLabelText("モデル"), { target: { value: "typed-model" } });
    expect(screen.getByLabelText("モデル")).toHaveValue("typed-model");
  });

  it("closes with Escape and restores focus to the trigger", () => {
    const onProvider = vi.fn();
    render(<AiProviderSettings provider={defaultProviderConfig("acp")} onProvider={onProvider} openToken={0} />);
    const trigger = screen.getByRole("button", { name: /接続設定/ });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "接続設定" });
    expect(dialog).toBeVisible();
    expect(dialog).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "接続設定" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("closes with the close button and restores focus to the trigger", () => {
    const onProvider = vi.fn();
    render(<AiProviderSettings provider={defaultProviderConfig("acp")} onProvider={onProvider} openToken={0} />);
    const trigger = screen.getByRole("button", { name: /接続設定/ });
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "接続設定" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "接続設定を閉じる" }));
    expect(screen.queryByRole("dialog", { name: "接続設定" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("reverts visible preset selection when the owner rejects persistence", () => {
    /** Reject persistence in the fixture to exercise the revert path. */
    const onProvider = vi.fn(() => false);
    render(<AiProviderSettings embedded provider={defaultProviderConfig("acp")} onProvider={onProvider} />);
    fireEvent.click(screen.getByRole("combobox", { name: "ACP プリセット" }));
    fireEvent.click(screen.getByRole("option", { name: "OpenCode" }));
    expect(onProvider).toHaveBeenCalled();
    expect(screen.getByRole("combobox", { name: "ACP プリセット" })).toHaveTextContent("Codex");
  });

  it("does not strip connection IDs through legacy persistence for named selections", () => {
    const first = { id: "api-1", name: "API-A", protocol: "openai_compatible" as const, endpoint: "https://a.example.com/v1", model: "model-a" };
    const second = { id: "api-2", name: "API-B", protocol: "openai_compatible" as const, endpoint: "https://b.example.com/v1", model: "model-b" };
    const list = { version: 1 as const, activeId: "api-1", initialized: true, connections: [first, second] };
    const controls = {
      list,
      activeId: "api-1",
      /** Accept selection in the fixture without side effects. */
      onSelect: vi.fn(() => true),
      /** Accept registration in the fixture without side effects. */
      onAdd: vi.fn(() => true),
      /** Accept edits in the fixture without side effects. */
      onUpdate: vi.fn(() => true),
      /** Accept deletion in the fixture without side effects. */
      onDelete: vi.fn(() => true),
      /** Mint a fixed fixture ID. */
      onMintId: vi.fn(() => "api-fresh" as const),
    };
    const profileSave = vi.fn();
    const onProvider = vi.fn();
    /** Load a fixture ACP profile without touching storage. */
    const loadFixtureProfile = () => ({ kind: "acp" }) as never;
    const { rerender } = render(
      <AiProviderSettings embedded provider={{ kind: "openai_compatible", acp: null, openai: { endpoint: first.endpoint, model: first.model }, anthropic: null, connectionId: "api-1" }} onProvider={onProvider} profileStore={{ load: loadFixtureProfile, save: profileSave }} connectionControls={controls as never} />,
    );
    rerender(
      <AiProviderSettings embedded provider={{ kind: "openai_compatible", acp: null, openai: { endpoint: second.endpoint, model: second.model }, anthropic: null, connectionId: "api-2" }} onProvider={onProvider} profileStore={{ load: loadFixtureProfile, save: profileSave }} connectionControls={{ ...controls, list: { ...list, activeId: "api-2" }, activeId: "api-2" } as never} />,
    );
    expect(profileSave).not.toHaveBeenCalled();
    for (const call of onProvider.mock.calls) {
      expect((call[0] as { connectionId?: string }).connectionId).toBeDefined();
    }
  });
});
