import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AiProviderSettings, { describeProviderSummary } from "./ai-provider-settings";
import { defaultProviderConfig } from "../domain/ai-config";

beforeEach(() => {
  vi.resetAllMocks();
  window.localStorage.clear();
});

describe("provider settings", () => {
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
    expect(describeProviderSummary(openai)).toBe("OpenAI互換 • local-model");
    const onProvider = vi.fn();
    render(<AiProviderSettings provider={openai} onProvider={onProvider} openToken={1} />);
    expect(screen.getByTestId("ai-provider-settings")).toHaveTextContent("OpenAI互換 • local-model");
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
});
