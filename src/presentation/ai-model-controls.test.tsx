import { act, fireEvent, render, screen, waitFor, within, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { AiModelControls } from "./ai-model-controls";
import { useAiModels } from "./shell/hooks/useAiModels";
import { defaultProviderConfig } from "../domain/ai-config";
import type { AiProviderConfig, AcpConfigOption } from "../contracts/ai-contracts";
import type { AiGateway } from "../application/ports";
import { defaultAiViewPreferences } from "../domain/ai-view-preferences";
import { buildProviderConfigFromConnection } from "../domain/ai-connections";
import { chooseEffort, chooseModel, chooseProvider, openPicker, pickerTrigger } from "./ai/picker-test-helpers";
import { modelVendor, shortModelName } from "./ai-model-controls";
import type { ApiConnection } from "../contracts/ai-contracts";
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
  it("hides only the named connection ID while retaining the active connection and model", () => {
    const first: ApiConnection = { id: "api-a", name: "Twin", protocol: "openai_chat_completions", endpoint: "https://a.example/v1", model: "model-a" };
    const second = { ...first, id: "api-b", endpoint: "https://b.example/v1" };
    const provider = buildProviderConfigFromConnection(first);
    const onProvider = vi.fn();
    const onSelect = vi.fn();
    const onRefresh = vi.fn();
    const onManageVisibility = vi.fn();
    const preferences = { ...defaultAiViewPreferences(), hiddenConnectionIds: [first.id], hiddenProviders: ["openai_chat_completions" as const] };
    const props = { provider, onProvider, options: [], loading: false, discovered: false, error: null, onRefresh, onManageVisibility, connectionSelection: { list: { version: 1 as const, initialized: true, activeId: first.id, connections: [first, second] }, activeId: first.id, onSelect } };
    const { rerender } = render(<AiModelControls {...props} preferences={preferences} />);
    expect(pickerTrigger()).toHaveAttribute("data-provider", "Twin");
    expect(pickerTrigger()).toHaveTextContent("model-a");
    const panel = openPicker();
    expect(within(panel).getByRole("textbox", { name: "チャットのモデル" })).toHaveValue("model-a");
    expect(within(panel).getAllByRole("tab", { name: "Twin" })).toHaveLength(1);
    expect(within(panel).getByRole("tab", { name: "Twin" })).toHaveAttribute("title", "model-a • https://b.example/v1");
    expect(within(panel).getByText("選択中の候補は非表示です")).toBeVisible();
    fireEvent.click(within(panel).getByRole("button", { name: "AI の表示設定" }));
    expect(onManageVisibility).toHaveBeenCalledOnce();
    rerender(<AiModelControls {...props} preferences={{ ...preferences, hiddenConnectionIds: [] }} />);
    expect(screen.queryByText("選択中の候補は非表示です")).toBeNull();
    expect(within(openPicker()).getAllByRole("tab", { name: "Twin" })).toHaveLength(2);
    expect(onProvider).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
    expect(onRefresh).not.toHaveBeenCalled();
    expect(provider).toEqual(buildProviderConfigFromConnection(first));
  });
  it("preserves model and reasoning overrides when the same provider or model is chosen again", () => {
    const provider = defaultProviderConfig("acp");
    provider.acp!.selections = [{ id: "model", value: "fixture-a" }, { id: "reasoning", value: "xhigh" }];
    const onProvider = vi.fn();
    const onRefresh = vi.fn();
    render(<AiModelControls provider={provider} onProvider={onProvider} options={options} loading={false} discovered error={null} onRefresh={onRefresh} />);
    chooseProvider("Codex");
    chooseModel("Fixture A");
    expect(onProvider).not.toHaveBeenCalled(); expect(onRefresh).not.toHaveBeenCalled();
    expect(provider.acp!.selections).toHaveLength(2);
  });
  it("discovers when the picker opens, stores advertised model/effort, and clears dependent effort", async () => {
    const testConnection = vi.fn().mockResolvedValue({ ok: true, detail: "fixture", configOptions: options });
    render(<Harness gateway={{ testConnection } as unknown as AiGateway} />);
    expect(testConnection).not.toHaveBeenCalled();
    openPicker();
    await screen.findByRole("listbox", { name: "チャットのモデル" });
    expect(testConnection).toHaveBeenCalledWith(defaultProviderConfig("acp"), true);
    expect(pickerTrigger()).toHaveTextContent("Fixture A (High)");
    chooseEffort("Xhigh");
    chooseModel("Fixture B");
    expect(testConnection).toHaveBeenCalledTimes(1);
    expect(currentProvider().acp?.selections).toEqual([{ id: "model", value: "fixture-b" }]);
    chooseEffort("Xhigh");
    expect(currentProvider().acp?.selections).toEqual([{ id: "model", value: "fixture-b" }, { id: "reasoning", value: "xhigh" }]);
    chooseProvider("GitHub Copilot");
    expect(currentProvider().acp?.preset).toBe("copilot");
    expect(screen.queryByRole("listbox", { name: "チャットのモデル" })).toBeNull();
  });
  it("keeps hidden current values readable without changing connection or model", () => {
    const provider = defaultProviderConfig("acp");
    provider.acp!.selections = [{ id: "model", value: "fixture-a" }];
    const onProvider = vi.fn();
    const onRefresh = vi.fn();
    const onManageVisibility = vi.fn();
    const preferences = { ...defaultAiViewPreferences(), hiddenProviders: ["codex" as const], hiddenModels: [{ provider: "codex" as const, optionId: "model", value: "fixture-a" }] };
    render(<AiModelControls provider={provider} onProvider={onProvider} options={options} loading={false} discovered error={null} onRefresh={onRefresh} preferences={preferences} onManageVisibility={onManageVisibility} />);
    expect(pickerTrigger()).toHaveAttribute("data-provider", "Codex");
    expect(pickerTrigger()).toHaveTextContent("Fixture A");
    const panel = openPicker();
    expect(within(panel).queryByRole("option", { name: /Fixture A/ })).toBeNull();
    expect(within(panel).getByRole("option", { name: /Fixture B/ })).toBeVisible();
    fireEvent.click(within(panel).getByRole("button", { name: "AI の表示設定" }));
    expect(onManageVisibility).toHaveBeenCalledOnce();
    expect(onProvider).not.toHaveBeenCalled(); expect(onRefresh).not.toHaveBeenCalled();
  });
  it("hides selector controls independently and keeps explicit connect and management available", () => {
    const props = { provider: defaultProviderConfig("acp"), onProvider: vi.fn(), options, loading: false, discovered: true, error: null, onRefresh: vi.fn(), onManageVisibility: vi.fn() };
    const preferences = { ...defaultAiViewPreferences(), showProviderSelector: false, showModelSelector: false };
    const { rerender } = render(<AiModelControls {...props} preferences={preferences} />);
    const panel = openPicker();
    expect(within(panel).queryByRole("tablist")).toBeNull();
    expect(within(panel).queryByRole("listbox")).toBeNull();
    expect(within(panel).getByRole("button", { name: "接続して候補を確認" })).toBeEnabled();
    expect(within(panel).getByRole("button", { name: "AI の表示設定" })).toBeEnabled();
    rerender(<AiModelControls {...props} provider={defaultProviderConfig("openai_chat_completions")} preferences={preferences} />);
    expect(screen.queryByRole("textbox", { name: "チャットのモデル" })).toBeNull();
    expect(props.onProvider).not.toHaveBeenCalled();
  });
  it("does not invent choices or replace a configured value when discovery is empty", () => {
    const provider = defaultProviderConfig("acp");
    provider.acp!.selections = [{ id: "opaque.option", value: "retained-value" }];
    const onProvider = vi.fn();
    render(<AiModelControls provider={provider} onProvider={onProvider} options={[]} loading={false} discovered error={null} onRefresh={vi.fn()} />);
    const panel = openPicker();
    expect(within(panel).queryByRole("listbox", { name: "チャットのモデル" })).toBeNull();
    expect(within(panel).getByText("モデル候補なし（接続先の設定を使用）")).toBeVisible();
    expect(onProvider).not.toHaveBeenCalled();
    expect(provider.acp!.selections).toEqual([{ id: "opaque.option", value: "retained-value" }]);
  });
  it("preserves a direct API endpoint when editing the model", () => {
    const onProvider = vi.fn();
    const provider = defaultProviderConfig("openai_chat_completions");
    provider.openai = { endpoint: "http://localhost:8080/v1", model: "local-a" };
    render(<AiModelControls provider={provider} onProvider={onProvider} options={[]} loading={false} discovered={false} error={null} onRefresh={vi.fn()} />);
    fireEvent.change(within(openPicker()).getByRole("textbox", { name: "チャットのモデル" }), { target: { value: "local-b" } });
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

it("shows API connections only after registration and uses their names", () => {
  const provider = defaultProviderConfig("acp");
  const props = { provider, onProvider: vi.fn(), options: [], loading: false, discovered: false, error: null, onRefresh: vi.fn() };
  render(<AiModelControls {...props} />);
  const panel = openPicker();
  expect(within(panel).queryByRole("tab", { name: "OpenAI Chat Completions" })).toBeNull();
  expect(within(panel).queryByRole("tab", { name: "OpenAI Responses" })).toBeNull();
  expect(within(panel).queryByRole("tab", { name: "Anthropic API" })).toBeNull();
  expect(within(panel).getByRole("tab", { name: "Claude Code" })).toBeVisible();
});

it("shows the vendor of each model and only installed agents as tabs", () => {
  expect(modelVendor("gpt-6.1-sol 6.1 Sol")).toBe("openai");
  expect(modelVendor("opencode/claude-opus-5-5 Claude Opus 5.5")).toBe("anthropic");
  expect(modelVendor("opencode/gemini-4-argon Gemini 4 Argon")).toBe("gemini");
  expect(modelVendor("opencode/kimi-k3 Kimi K3")).toBe("kimi");
  expect(modelVendor("opencode/deepseek-v4-pro DeepSeek V4 Pro")).toBe("deepseek");
  expect(modelVendor("opencode/qwen3.6-plus Qwen3.6 Plus")).toBe("qwen");
  expect(modelVendor("opencode/glm-5.3 GLM-5.3")).toBe("glm");
  expect(modelVendor("opencode/minimax-m3 MiniMax-M3")).toBe("minimax");
  expect(modelVendor("opencode/grok-4.7 Grok 4.7")).toBe("grok");
  expect(modelVendor("opencode/mimo-v2.6-flash-free MiMo-V2.6-Flash Free")).toBe("xiaomi");
  expect(modelVendor("opencode/nemotron-3.5-super Nemotron 3.5")).toBe("nvidia");
  expect(modelVendor("opencode/big-pickle Big Pickle")).toBe("other");
  expect(shortModelName("Personal / OpenCode/Claude Fable 5.1")).toBe("Claude Fable 5.1");
  expect(shortModelName("6.1 Sol")).toBe("6.1 Sol");
  render(<AiModelControls provider={defaultProviderConfig("acp")} onProvider={vi.fn()} options={options} loading={false} discovered error={null} onRefresh={vi.fn()} installed={new Set(["opencode"])} />);
  const panel = openPicker();
  expect(within(panel).getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Codex", "OpenCode"]);
});
