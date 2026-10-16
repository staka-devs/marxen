import { expect, it } from "vitest";
import { aiAccountScope } from "./ai-account-scope";
import { defaultProviderConfig } from "./ai-config";
import type { AccountSnapshot } from "../contracts/provider-accounts";

it("fences local account revisions while keeping API and WSL selections independent", () => {
  const provider = defaultProviderConfig("acp");
  const snapshot: AccountSnapshot = { accounts: [], selections: [] };
  const system = aiAccountScope(provider, snapshot);
  snapshot.selections.push({ provider: "codex", host: { kind: "wsl", distribution: "Ubuntu" }, accountId: "wsl" });
  expect(aiAccountScope(provider, snapshot)).toBe(system);
  snapshot.selections.push({ provider: "codex", host: { kind: "local" }, accountId: "local" });
  snapshot.accounts.push({ hasCredential: true, account: { id: "local", revision: 1, provider: "codex", host: { kind: "local" }, name: "Work", endpoint: "https://chatgpt.com", project: "" } });
  const work = aiAccountScope(provider, snapshot);
  expect(work).not.toBe(system);
  snapshot.accounts[0].account.revision += 1;
  expect(aiAccountScope(provider, snapshot)).not.toBe(work);
  expect(aiAccountScope({ ...defaultProviderConfig("openai_responses"), connectionId: "api-work" }, snapshot)).toBe("api-work");
});
