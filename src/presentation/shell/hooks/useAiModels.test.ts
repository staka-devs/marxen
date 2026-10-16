import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { AiGateway } from "../../../application/ports";
import type { AiTestResult } from "../../../contracts/ai-contracts";
import { defaultProviderConfig } from "../../../domain/ai-config";
import { useAiModels } from "./useAiModels";

it("coalesces simultaneous probes and retains an advertised catalog after a transient failure", async () => {
  let finish!: (reply: AiTestResult) => void;
  /** Hold the probe response to verify concurrent requests and transient failures. */
  const testConnection = vi.fn(() => new Promise<AiTestResult>((resolve) => { finish = resolve; }));
  const gateway = { testConnection } as unknown as AiGateway;
  const { result } = renderHook(() => useAiModels(defaultProviderConfig("acp"), gateway));
  await act(async () => { void result.current.refresh(); void result.current.refresh(); });
  expect(testConnection).toHaveBeenCalledTimes(1);
  const options = [{ id: "model", name: "Model", category: "model", currentValue: "actual", options: [{ value: "actual", name: "Actual" }] }];
  await act(async () => { finish({ ok: true, detail: "connected", configOptions: options }); });
  await waitFor(() => expect(result.current.options).toEqual(options));
  await act(async () => { void result.current.refresh(); });
  await act(async () => { finish({ ok: false, detail: "temporarily unavailable" }); });
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.error).toBe("temporarily unavailable");
  expect(result.current.options).toEqual(options);
});
