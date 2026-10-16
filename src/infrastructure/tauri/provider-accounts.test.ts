import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { providerAccountGateway } from "./provider-accounts";
import { requireDesktop } from "./ai-client";

vi.mock("@tauri-apps/api/core", () => ({
  /** Stub IPC without contacting a native process. */
  invoke: vi.fn(async () => undefined)
}));
vi.mock("./ai-client", () => ({ requireDesktop: vi.fn() }));
beforeEach(() => vi.clearAllMocks());

it("routes all account controls to native IPC with no JavaScript persistence", async () => {
  const persistence = vi.spyOn(Storage.prototype, "setItem");
  const host = { kind: "local" } as const;
  const account = { id: "", revision: 0, name: "work", provider: "minimax" as const, host, endpoint: "https://www.minimax.io", project: "", groupId: "", models: [], workspaceId: "" };
  await providerAccountGateway.openSetup("minimax");
  await providerAccountGateway.snapshot(); await providerAccountGateway.save(account, { apiKey: "fixture-key" });
  await providerAccountGateway.select({ provider: "minimax", host, accountId: null });
  await providerAccountGateway.credentialPresent("minimax", host); await providerAccountGateway.usage("minimax", host); await providerAccountGateway.delete("a".repeat(32));
  expect(requireDesktop).toHaveBeenCalledTimes(7);
  expect(persistence).not.toHaveBeenCalled();
  persistence.mockRestore();
  expect(invoke).toHaveBeenCalledWith("provider_accounts_save", { account, credentials: { apiKey: "fixture-key" } });
  expect(invoke).toHaveBeenCalledWith("provider_accounts_usage", { provider: "minimax", host });
  expect(invoke).toHaveBeenCalledWith("provider_accounts_delete", { id: "a".repeat(32) });
});
