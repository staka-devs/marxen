import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AiProviderSettings from "./ai-provider-settings";
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
});
