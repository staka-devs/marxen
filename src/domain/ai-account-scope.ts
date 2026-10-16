import type { AiProviderConfig } from "../contracts/ai-contracts";
import type { AccountProvider, AccountSnapshot } from "../contracts/provider-accounts";

/** Separate histories and advertised models by the selected local CLI account revision. */
export function aiAccountScope(provider: AiProviderConfig, snapshot: AccountSnapshot): string | null {
  if (provider.kind !== "acp") return provider.connectionId ?? null;
  const preset = provider.acp?.preset;
  const command = (provider.acp?.argv?.command.split(/[/\\]/).pop() ?? "").toLowerCase().replace(/\.(exe|cmd|ps1)$/, "");
  const accountProvider: AccountProvider | undefined = preset === "codex" || (preset === "custom" && command === "codex-acp") ? "codex"
    : preset === "opencode" || (preset === "custom" && command === "opencode") ? "opencode"
    : preset === "claude_code" || (preset === "custom" && command === "claude-agent-acp") ? "claude" : undefined;
  if (!accountProvider) return null;
  const selection = snapshot.selections.find(item => item.provider === accountProvider && item.host.kind === "local");
  const id = selection?.accountId;
  const account = id ? snapshot.accounts.find(item => item.account.id === id)?.account : undefined;
  return JSON.stringify([accountProvider, id ?? "system", account?.revision ?? null]);
}
