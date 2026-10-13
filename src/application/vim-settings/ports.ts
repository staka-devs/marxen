// Vim-settings gateway port (application).
//
// Narrow boundary between the vim-settings use case and the native file
// adapter. Domain and contract types only; no Tauri, DOM, React, or browser
// globals. The composition root injects the infrastructure implementation.

import type { VimConfigRead, VimConfigWrite, VimSettings } from "../../contracts/vim-settings";

/** Native vim-settings file gateway with fingerprint-guarded writes. */
export interface VimSettingsGateway {
  /**
   * Read a config file with its fingerprint and managed parse state.
   *
   * Resolves `null`/empty paths to the app-specific standard config.
   */
  read(path: string | null): Promise<VimConfigRead>;
  /**
   * Rewrite only the managed block, refusing stale baselines and Lua targets.
   *
   * Pass the fingerprint observed by `read` (`null` when missing) so
   * external changes conflict instead of being overwritten.
   */
  writeManaged(path: string | null, expectedFingerprint: string | null, settings: VimSettings): Promise<VimConfigWrite>;
  /**
   * Store caller-edited raw text verbatim with a stale-file guard.
   *
   * Accepts both Vimscript and Lua targets without reinterpretation.
   */
  writeRaw(path: string | null, expectedFingerprint: string | null, raw: string): Promise<VimConfigWrite>;
}
