// Generated from src-tauri/src/contracts/provider_accounts.rs. Run export-provider-account-contracts.
export type AccountProvider = "codex" | "claude" | "opencode" | "devin" | "gemini" | "antigravity" | "opencode_go" | "minimax" | "grok" | "cursor" | "glm";
export type AccountHost = { "kind": "local" } | { "kind": "wsl", distribution: string, };
export type ProviderAccount = { id: string, revision: number, provider: AccountProvider, host: AccountHost, name: string,
/**
 * Trusted provider endpoint; credentials are never sent to user-defined hosts.
 */
endpoint: string,
/**
 * Gemini Code Assist project, when explicitly configured.
 */
project: string, };
export type AccountSelection = { provider: AccountProvider, host: AccountHost, accountId: string | null, };
export type AccountSettings = { accounts: Array<ProviderAccount>, selections: Array<AccountSelection>, };
export type AccountState = { account: ProviderAccount, hasCredential: boolean, };
export type AccountSnapshot = { accounts: Array<AccountState>, selections: Array<AccountSelection>, };
export type AccountReason = "wsl_unsupported" | "private_files_unsupported" | "adapter_unsupported" | "missing_credential" | "login_required" | "missing_project" | "refresh_required" | "invalid_response";
export type ProviderAccountError = { "code": "invalid_settings" } | { "code": "not_found" } | { "code": "store_failed" } | { "code": "credential_store_failed" } | { "code": "unsupported", reason: AccountReason, } | { "code": "request_failed" } | { "code": "unauthorized" } | { "code": "rate_limited" } | { "code": "invalid_response" };
export type AccountQuota = { label: string, usedPercent: number,
/**
 * Provider-reported reset value; no duration is inferred.
 */
resetsAt: string | null, };
export type ProviderAccountUsage = { quotas: Array<AccountQuota>, receivedMs: number, unavailableReason: AccountReason | null, };
