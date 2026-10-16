import type { AccountCredentialPatch, AccountHost, AccountProvider, AccountSelection, AccountSnapshot, ProviderAccount, ProviderAccountUsage } from "../../contracts/provider-accounts";

/** Native account settings keep secrets out of browser persistence and returned data. */
export interface ProviderAccountGateway {
  /** Open the provider's fixed official page with the native default browser. */
  openSetup(provider: AccountProvider): Promise<void>;
  /** Read saved metadata and credential presence. */
  snapshot(): Promise<AccountSnapshot>;
  /** Save metadata plus an optional replacement secret directly to Rust. */
  save(account: ProviderAccount, credentials?: AccountCredentialPatch): Promise<void>;
  /** Select an account from the same provider and host for subsequent operations. */
  select(selection: AccountSelection): Promise<void>;
  /** Delete only a managed account, never a system default. */
  delete(id: string): Promise<void>;
  /** Check presence without a network request or an authentication claim. */
  credentialPresent(provider: AccountProvider, host: AccountHost): Promise<boolean>;
  /** Fetch measured account limits without inference. */
  usage(provider: AccountProvider, host: AccountHost): Promise<ProviderAccountUsage>;
}
