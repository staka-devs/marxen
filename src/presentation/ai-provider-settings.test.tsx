import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AiProviderSettings, { describeProviderSummary } from "./ai-provider-settings";
import { defaultProviderConfig } from "../domain/ai-config";

beforeEach(() => {
  vi.resetAllMocks();
  window.localStorage.clear();
});

describe("provider settings", () => {
  it("expands the collapsed settings when the open token increments", () => {
    const onProvider = vi.fn();
    const { rerender } = render(
      <AiProviderSettings provider={defaultProviderConfig("acp")} onProvider={onProvider} openToken={0} />,
    );
    const details = screen.getByTestId("ai-provider-settings");
    expect(details.hasAttribute("open")).toBe(false);
    rerender(
      <AiProviderSettings provider={defaultProviderConfig("acp")} onProvider={onProvider} openToken={1} />,
    );
    expect(screen.getByTestId("ai-provider-settings").hasAttribute("open")).toBe(true);
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
    const details = screen.getByTestId("ai-provider-settings");
    expect(details.hasAttribute("open")).toBe(false);
    expect(screen.getByText("接続設定")).toBeVisible();
  });
});
