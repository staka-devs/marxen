import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import AiProviderSettings from "./ai-provider-settings";
import { defaultProviderConfig } from "../domain/ai-config";
import type { AiGateway } from "../application/ports";

beforeEach(() => vi.resetAllMocks());

it("reflects a provider edited in the other settings surface without publishing stale fields", async () => {
  const onProvider = vi.fn();
  const acp = defaultProviderConfig("acp");
  const { rerender } = render(<AiProviderSettings embedded provider={acp} onProvider={onProvider} />);
  expect(screen.queryByLabelText("資格情報の入力")).not.toBeInTheDocument();
  const next = defaultProviderConfig("openai_compatible");
  next.openai!.endpoint = "http://localhost:3000/v1";
  next.openai!.model = "local-model";
  rerender(<AiProviderSettings embedded provider={next} onProvider={onProvider} />);
  await waitFor(() => expect(screen.getByLabelText("API エンドポイント")).toHaveValue("http://localhost:3000/v1"));
  expect(screen.getByLabelText("モデル")).toHaveValue("local-model");
  expect(onProvider).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("モデル"), { target: { value: "edited-model" } });
  await waitFor(() => expect(onProvider).toHaveBeenCalledWith(expect.objectContaining({ openai: expect.objectContaining({ endpoint: "http://localhost:3000/v1", model: "edited-model" }) })));
});

it("clears a successful connection result and fences a pending result when the configured model changes", async () => {
  let finish!: (result: { ok: boolean; detail: string }) => void;
  /** Delay a connection result until the test changes its configured target. */
  const testConnection = vi.fn(() => new Promise<{ ok: boolean; detail: string }>((resolve) => { finish = resolve; }));
  render(<AiProviderSettings embedded provider={defaultProviderConfig("openai_compatible")} onProvider={vi.fn()} gateway={{ testConnection } as unknown as AiGateway} />);
  fireEvent.click(screen.getByRole("button", { name: "設定を確認" }));
  fireEvent.change(screen.getByLabelText("モデル"), { target: { value: "changed-model" } });
  await act(async () => finish({ ok: true, detail: "old target is valid" }));
  expect(screen.queryByRole("status")).toBeNull();
  expect(testConnection).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "設定を確認" }));
  await act(async () => finish({ ok: true, detail: "current target is valid" }));
  expect(screen.getByRole("status")).toHaveTextContent("成功");
  fireEvent.change(screen.getByLabelText("モデル"), { target: { value: "new-target" } });
  expect(screen.queryByRole("status")).toBeNull();
  expect(testConnection).toHaveBeenCalledTimes(2);
});
