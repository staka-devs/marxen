import { act, fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { AiModelControls } from "./ai-model-controls";
import { useAiModels } from "./shell/hooks/useAiModels";
import { defaultProviderConfig } from "../domain/ai-config";
import type { AiProviderConfig, AcpConfigOption } from "../contracts/ai-contracts";
import type { AiGateway } from "../application/ports";
import { defaultAiViewPreferences } from "../domain/ai-view-preferences";
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
/** Select a visible choice through the same popup interaction used by the product. */
function choose(label: string, name: string) {
  fireEvent.click(screen.getByRole("combobox", { name: label }));
  fireEvent.click(screen.getByRole("option", { name }));
}
describe("chat model selection", () => {
  it("preserves model and reasoning overrides when the same provider or model is chosen again", () => {
    const provider = defaultProviderConfig("acp");
    provider.acp!.selections = [{ id: "model", value: "fixture-a" }, { id: "reasoning", value: "xhigh" }];
    const onProvider = vi.fn();
    const onRefresh = vi.fn();
    render(<AiModelControls provider={provider} onProvider={onProvider} options={options} loading={false} discovered error={null} onRefresh={onRefresh} />);
    choose("チャットの接続先", "Codex");
    choose("チャットのモデル", "Fixture A");
    expect(onProvider).not.toHaveBeenCalled(); expect(onRefresh).not.toHaveBeenCalled();
    expect(provider.acp!.selections).toHaveLength(2);
  });
  it("only discovers on request, stores advertised model/effort, and clears dependent effort", async () => {
    const testConnection = vi.fn().mockResolvedValue({ ok: true, detail: "fixture", configOptions: options });
    render(<Harness gateway={{ testConnection } as unknown as AiGateway} />);
    expect(testConnection).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "接続して候補を確認" }));
    await screen.findByRole("combobox", { name: "チャットのモデル" });
    expect(testConnection).toHaveBeenCalledWith(defaultProviderConfig("acp"), true);
    choose("チャットの推論強度", "Xhigh");
    choose("チャットのモデル", "Fixture B");
    expect(testConnection).toHaveBeenCalledTimes(1);
    expect(currentProvider().acp?.selections).toEqual([{ id: "model", value: "fixture-b" }]);
    choose("チャットの推論強度", "Xhigh");
    expect(currentProvider().acp?.selections).toEqual([{ id: "model", value: "fixture-b" }, { id: "reasoning", value: "xhigh" }]);
    choose("チャットの接続先", "GitHub Copilot");
    expect(currentProvider().acp?.preset).toBe("copilot");
    expect(screen.queryByRole("combobox", { name: "チャットのモデル" })).toBeNull();
  });
  it("keeps hidden current values readable without changing connection or model", () => {
    const provider = defaultProviderConfig("acp");
    provider.acp!.selections = [{ id: "model", value: "fixture-a" }];
    const onProvider = vi.fn();
    const onRefresh = vi.fn();
    const onManageVisibility = vi.fn();
    const preferences = { ...defaultAiViewPreferences(), hiddenProviders: ["codex" as const], hiddenModels: [{ provider: "codex" as const, optionId: "model", value: "fixture-a" }] };
    render(<AiModelControls provider={provider} onProvider={onProvider} options={options} loading={false} discovered error={null} onRefresh={onRefresh} preferences={preferences} onManageVisibility={onManageVisibility} />);
    expect(screen.getByRole("combobox", { name: "チャットの接続先" })).toHaveTextContent("Codex");
    expect(screen.getByRole("combobox", { name: "チャットのモデル" })).toHaveTextContent("Fixture A");
    fireEvent.click(screen.getByRole("combobox", { name: "チャットのモデル" }));
    expect(screen.queryByRole("option", { name: /Fixture A/ })).toBeNull();
    expect(screen.getByRole("option", { name: /Fixture B/ })).toBeVisible();
    fireEvent.keyDown(screen.getByRole("combobox", { name: "モデルを検索" }), { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "AI の表示設定" }));
    expect(onManageVisibility).toHaveBeenCalledOnce();
    expect(onProvider).not.toHaveBeenCalled(); expect(onRefresh).not.toHaveBeenCalled();
  });
  it("hides selector controls independently and keeps explicit connect and management available", () => {
    const props = { provider: defaultProviderConfig("acp"), onProvider: vi.fn(), options, loading: false, discovered: true, error: null, onRefresh: vi.fn(), onManageVisibility: vi.fn() };
    const preferences = { ...defaultAiViewPreferences(), showProviderSelector: false, showModelSelector: false };
    const { rerender } = render(<AiModelControls {...props} preferences={preferences} />);
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByRole("button", { name: "接続して候補を確認" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "AI の表示設定" })).toBeEnabled();
    rerender(<AiModelControls {...props} provider={defaultProviderConfig("openai_compatible")} preferences={preferences} />);
    expect(screen.queryByRole("textbox", { name: "チャットのモデル" })).toBeNull();
    expect(props.onProvider).not.toHaveBeenCalled();
  });
  it("does not invent choices or replace a configured value when discovery is empty", () => {
    const provider = defaultProviderConfig("acp");
    provider.acp!.selections = [{ id: "opaque.option", value: "retained-value" }];
    const onProvider = vi.fn();
    render(<AiModelControls provider={provider} onProvider={onProvider} options={[]} loading={false} discovered error={null} onRefresh={vi.fn()} />);
    expect(screen.queryByRole("combobox", { name: "チャットのモデル" })).toBeNull();
    expect(screen.getByText("この接続先はモデル候補を公開していません。CLI の設定を使用します。")).toBeVisible();
    expect(onProvider).not.toHaveBeenCalled();
    expect(provider.acp!.selections).toEqual([{ id: "opaque.option", value: "retained-value" }]);
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
  it("isolates discovery by stable connection scope and drops late foreign results", async () => {
    let resolve!: (value: { ok: boolean; detail: string; configOptions: AcpConfigOption[] }) => void;
    const testConnection = vi.fn().mockImplementation(() => new Promise((done) => { resolve = done; }));
    /** Flip connection scopes while probing to prove per-connection result isolation. */
    function ScopedHarness() {
      const [scope, setScope] = useState<string | null>("api-1");
      const models = useAiModels(defaultProviderConfig("acp"), { testConnection } as unknown as AiGateway, scope);
      return <><ScopedStatus discovered={models.discovered} options={models.options} /><button onClick={() => void models.refresh()}>Probe</button><button onClick={() => setScope("api-2")}>Scope</button></>;
    }
    /** Show discovery presence and size for the scope-isolation regression. */
    function ScopedStatus({ discovered, options: values }: { discovered: boolean; options: AcpConfigOption[] }) { return <output data-testid="scoped">{`${discovered}:${values.length}`}</output>; }
    render(<ScopedHarness />);
    fireEvent.click(screen.getByText("Probe"));
    fireEvent.click(screen.getByText("Scope"));
    await act(async () => resolve({ ok: true, detail: "old-scope", configOptions: options }));
    await waitFor(() => expect(screen.getByTestId("scoped").textContent).toBe("false:0"));
    fireEvent.click(screen.getByText("Probe"));
    await act(async () => resolve({ ok: true, detail: "new-scope", configOptions: [] }));
    await waitFor(() => expect(screen.getByTestId("scoped").textContent).toBe("true:0"));
  });
});
