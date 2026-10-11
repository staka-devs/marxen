import { act, fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { AiModelControls } from "./ai-model-controls";
import { useAiModels } from "./shell/hooks/useAiModels";
import { defaultProviderConfig } from "../domain/ai-config";
import type { AiProviderConfig, AcpConfigOption } from "../contracts/ai-contracts";
import type { AiGateway } from "../application/ports";
afterEach(cleanup);
const options: AcpConfigOption[] = [
  { id: "model", name: "Model", category: "model", currentValue: "fixture-a", options: [{ value: "fixture-a", name: "Fixture A" }, { value: "fixture-b", name: "Fixture B" }] },
  { id: "reasoning", name: "Effort", category: "thought_level", currentValue: "high", options: [{ value: "high", name: "High" }, { value: "xhigh", name: "Xhigh" }] },
];
/** Render controlled chat choices against the real presentation boundary. */
function Harness({ gateway }: { gateway: AiGateway }) {
  const [provider, setProvider] = useState(defaultProviderConfig("acp"));
  const models = useAiModels(provider, gateway);
  return <><AiModelControls provider={provider} onProvider={setProvider} {...models} onRefresh={() => void models.refresh()} /><output data-testid="provider">{JSON.stringify(provider)}</output></>;
}
/** Read the last controlled provider to inspect actual wire selections. */
function currentProvider(): AiProviderConfig { return JSON.parse(screen.getByTestId("provider").textContent!); }
describe("chat model selection", () => {
  it("only discovers on request, stores advertised model/effort, and clears dependent effort", async () => {
    const testConnection = vi.fn().mockResolvedValue({ ok: true, detail: "fixture", configOptions: options });
    render(<Harness gateway={{ testConnection } as unknown as AiGateway} />);
    expect(testConnection).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "モデル候補を取得" }));
    await screen.findByRole("combobox", { name: "チャットのモデル" });
    expect(testConnection).toHaveBeenCalledWith(defaultProviderConfig("acp"), true);
    fireEvent.change(screen.getByRole("combobox", { name: "チャットの推論強度" }), { target: { value: "xhigh" } });
    fireEvent.change(screen.getByRole("combobox", { name: "チャットのモデル" }), { target: { value: "fixture-b" } });
    expect(currentProvider().acp?.selections).toEqual([{ id: "model", value: "fixture-b" }]);
    fireEvent.change(screen.getByRole("combobox", { name: "チャットの推論強度" }), { target: { value: "xhigh" } });
    expect(currentProvider().acp?.selections).toEqual([{ id: "model", value: "fixture-b" }, { id: "reasoning", value: "xhigh" }]);
    fireEvent.change(screen.getByRole("combobox", { name: "チャットの接続先" }), { target: { value: "copilot" } });
    expect(currentProvider().acp?.preset).toBe("copilot");
    expect(screen.queryByRole("combobox", { name: "チャットのモデル" })).toBeNull();
  });
  it("preserves a direct API endpoint when editing the model", () => {
    const onProvider = vi.fn();
    const provider = defaultProviderConfig("openai_compatible");
    provider.openai = { endpoint: "http://localhost:8080/v1", model: "local-a" };
    render(<AiModelControls provider={provider} onProvider={onProvider} options={[]} loading={false} discovered={false} error={null} onRefresh={vi.fn()} />);
    fireEvent.change(screen.getByRole("textbox", { name: "チャットのモデル" }), { target: { value: "local-b" } });
    expect(onProvider).toHaveBeenCalledWith({ ...provider, openai: { endpoint: "http://localhost:8080/v1", model: "local-b" } });
  });
  it("fences late discovery from a previous connection", async () => {
    let resolve!: (value: { ok: boolean; detail: string; configOptions: AcpConfigOption[] }) => void;
    const testConnection = vi.fn().mockImplementation(() => new Promise((done) => { resolve = done; }));
    /** Expose a forced provider change while an earlier probe is pending. */
    function SwitchingHarness() {
      const [provider, setProvider] = useState(defaultProviderConfig("acp"));
      const models = useAiModels(provider, { testConnection } as unknown as AiGateway);
      return <><HarnessStatus options={models.options} /><button onClick={() => void models.refresh()}>Probe</button><button onClick={() => setProvider({ ...provider, acp: { preset: "opencode", argv: null } })}>Switch</button></>;
    }
    /** Show only discovery state for the stale-result regression. */
    function HarnessStatus({ options: values }: { options: AcpConfigOption[] }) { return <output data-testid="models">{values.length}</output>; }
    render(<SwitchingHarness />);
    fireEvent.click(screen.getByText("Probe"));
    fireEvent.click(screen.getByText("Switch"));
    await act(async () => resolve({ ok: true, detail: "old", configOptions: options }));
    await waitFor(() => expect(screen.getByTestId("models").textContent).toBe("0"));
  });
});
