import { invoke } from "@tauri-apps/api/core";
import type { ProviderAccountGateway } from "../../application/ai/provider-account-ports";
import { requireDesktop } from "./ai-client";

/** Explicit IPC adapter; credential inputs are sent only to Rust and never cached. */
export const providerAccountGateway: ProviderAccountGateway = {
  /** Open only a provider enum's fixed setup URL, with no arbitrary URL argument. */
  async openSetup(provider) { requireDesktop(); await invoke("provider_accounts_open_setup", { provider }); },
  /** Read public records without any credential value in the response. */
  async snapshot() { requireDesktop(); return invoke("provider_accounts_snapshot"); },
  /** Forward one explicitly supplied secret without saving it in JavaScript storage. */
  async save(account, credentials) { requireDesktop(); await invoke("provider_accounts_save", { account, credentials: credentials ?? null }); },
  /** Change only the provider and host's native account selection. */
  async select(selection) { requireDesktop(); await invoke("provider_accounts_select", { selection }); },
  /** Delete one Rust-issued identifier through the native account use case. */
  async delete(id) { requireDesktop(); await invoke("provider_accounts_delete", { id }); },
  /** Report local credential presence rather than invented authentication success. */
  async credentialPresent(provider, host) { requireDesktop(); return invoke("provider_accounts_credential_present", { provider, host }); },
  /** Request explicit measured usage for the same selected host scope. */
  async usage(provider, host) { requireDesktop(); return invoke("provider_accounts_usage", { provider, host }); },
};
