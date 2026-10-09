// AI profile persistence in localStorage (infrastructure).
//
// Non-secret provider/endpoint/model/custom argv only. Secrets never touch
// this store: credentials live in the native OS store and are referenced by
// presence. Failures (private mode/quota) stay silent and fall back to defaults.

import { defaultProfile, sanitizeAiProfile, type AiProfile } from "../../domain/ai-profile";
import type { AiProfileStore } from "../../application/ports";

/** Storage key versioning the profile shape. */
const STORAGE_KEY = "marxen.ai-profile.v1";

/**
 * Load the sanitized AI profile, falling back to Codex defaults.
 *
 * Corrupt JSON or missing storage returns defaults so settings always open.
 */
export function loadAiProfile(): AiProfile {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (!stored) return defaultProfile();
    return sanitizeAiProfile(JSON.parse(stored));
  } catch {
    return defaultProfile();
  }
}

/**
 * Persist a sanitized AI profile, ignoring quota/private-mode failures.
 *
 * Sanitizes before writing so stored JSON always validates on next load.
 */
export function saveAiProfile(profile: AiProfile): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitizeAiProfile(profile)));
  } catch {
    // Private mode / quota: profiles simply do not persist.
  }
}


/** AI profile store adapter satisfying the application port with localStorage. */
export const aiProfileStore: AiProfileStore = {
  /** Load the sanitized profile or defaults. */
  load: loadAiProfile,
  /** Persist a sanitized profile; failures stay silent. */
  save: saveAiProfile,
};

