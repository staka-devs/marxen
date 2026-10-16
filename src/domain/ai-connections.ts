// Named direct-API connections (domain).
//
// Pure identifiers, validation, migration, and wire mapping for multiple
// registered API connections. No Tauri, DOM, React, or browser globals:
// persistence lives in infrastructure storage and secrets never touch
// this model. ACP presets stay separate and are never represented here.

import type { AiProviderConfig, ApiConnection, ApiConnectionId, ApiProtocol } from "../contracts/ai-contracts";
import { DEFAULT_ENDPOINTS } from "./ai-config";
import type { AiProfile } from "./ai-profile";

/** Persisted non-secret list of named API connections with the active selection. */
export interface ApiConnectionList {
  version: 1;
  activeId: string | null;
  connections: ApiConnection[];
  /**
   * True once the list was explicitly written (migration or any user action).
   * Guards the one-shot legacy migration so deleting the last connection
   * never recreates the legacy profile on restart.
   */
  initialized: boolean;
}

/** Protocols offered by the settings protocol dropdown. */
export const API_PROTOCOLS: ApiProtocol[] = ["openai_compatible", "openai_responses", "anthropic"];

/** Storage key versioning the named-connection shape. */
export const API_CONNECTIONS_STORAGE_KEY = "marxen.api-connections.v1";

/** Maximum display-name length in Unicode scalars. */
export const MAX_CONNECTION_NAME_CHARS = 64;

/**
 * Create an empty named-connection list with no active selection.
 *
 * The legacy single profile stays untouched; migration fills this in once.
 * Uninitialized lists may migrate; any persisted write marks initialization.
 */
export function defaultConnectionList(): ApiConnectionList {
  return { version: 1, activeId: null, connections: [], initialized: false };
}

/**
 * Check a raw value as a stable connection ID.
 *
 * IDs use the same bounded ASCII handle syntax as Rust `validate_handle`
 * so they stay safe as credential-store account suffixes.
 */
export function isConnectionId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 128 && /^[A-Za-z0-9_-]+$/.test(value);
}

/**
 * Check a raw value as a display name.
 *
 * Names are labels only; identity always comes from the connection ID.
 */
export function isConnectionName(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return trimmed.length >= 1 && [...trimmed].length <= MAX_CONNECTION_NAME_CHARS && !/[\0\n\r]/.test(value);
}

/**
 * Check a raw protocol value from stored JSON or the settings dropdown.
 *
 * Only direct-API protocols validate; ACP is never a connection protocol.
 */
export function isApiProtocol(value: unknown): value is ApiProtocol {
  return value === "openai_compatible" || value === "openai_responses" || value === "anthropic";
}

/**
 * Sanitize one stored connection, dropping it when identity or protocol is unrecoverable.
 *
 * Returns null for entries that must not survive; the list sanitizer filters them.
 */
export function sanitizeApiConnection(raw: unknown): ApiConnection | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (!isConnectionId(record.id) || !isApiProtocol(record.protocol)) return null;
  const name = typeof record.name === "string" && isConnectionName(record.name) ? record.name.trim() : null;
  if (name === null) return null;
  const endpoint = typeof record.endpoint === "string" ? record.endpoint : "";
  const model = typeof record.model === "string" ? record.model : "";
  if (endpoint.trim() === "") return null;
  return { id: record.id as ApiConnectionId, name, protocol: record.protocol, endpoint, model };
}

/**
 * Sanitize stored JSON into a valid connection list, dropping invalid entries.
 *
 * Duplicate IDs keep their first occurrence. An explicit `activeId: null`
 * stays null so ACP selections survive save/load round-trips; only undefined
 * or dangling non-null IDs not in the surviving set repair to the first
 * connection or null. Any present object sanitizes to initialized: presence
 * implies a prior write (including legacy flagless or empty stores) or
 * unknown bytes, and only a missing key yields the migration-eligible
 * default — so silent legacy recovery never overwrites stored data. Nullish
 * input keeps the plain default.
 */
export function sanitizeApiConnectionList(raw: unknown): ApiConnectionList {
  const fallback = defaultConnectionList();
  if (raw === null || raw === undefined) return fallback;
  if (typeof raw !== "object") return { ...fallback, initialized: true };
  const record = raw as Record<string, unknown>;
  const items = Array.isArray(record.connections) ? record.connections : [];
  const seen = new Set<string>();
  const connections: ApiConnection[] = [];
  for (const item of items) {
    const parsed = sanitizeApiConnection(item);
    if (parsed === null || seen.has(parsed.id)) continue;
    seen.add(parsed.id);
    connections.push(parsed);
  }
  if (record.activeId === null) return { version: 1, activeId: null, connections, initialized: true };
  const activeId = typeof record.activeId === "string" && seen.has(record.activeId) ? record.activeId : (connections[0]?.id ?? null);
  return { version: 1, activeId, connections, initialized: true };
}

/**
 * Report whether stored JSON must be retained instead of silently overwritten.
 *
 * Missing keys (nullish) are migration-eligible and report false; every other
 * present value reports true when sanitizing would lose data: non-objects,
 * unsupported versions, non-array connection payloads, unrecoverable entries,
 * duplicate IDs, or a dangling active selection over an empty list. Repaired
 * active selections over surviving connections stay repairable and report
 * false so normal selection repair never blocks editing.
 */
export function isConnectionStorageCorrupted(raw: unknown): boolean {
  if (raw === null || raw === undefined) return false;
  if (typeof raw !== "object") return true;
  const record = raw as Record<string, unknown>;
  if (record.version !== 1 && record.version !== undefined) return true;
  if (!Array.isArray(record.connections)) return true;
  const seen = new Set<string>();
  for (const item of record.connections) {
    const parsed = sanitizeApiConnection(item);
    if (parsed === null) return true;
    if (seen.has(parsed.id)) return true;
    seen.add(parsed.id);
  }
  if (typeof record.activeId === "string" && record.activeId !== "" && !seen.has(record.activeId) && seen.size === 0) return true;
  return false;
}

/**
 * Pick the first usable candidate ID, falling back to deterministic suffixes.
 *
 * Pure and deterministic: callers supply randomness-backed candidates while
 * tests supply fixed ones. Invalid or colliding candidates are skipped; the
 * `api-<n>` fallback always terminates because the namespace is unbounded.
 */
export function pickConnectionId(existing: readonly string[], candidates: readonly string[]): string {
  const taken = new Set(existing);
  for (const candidate of candidates) {
    if (isConnectionId(candidate) && !taken.has(candidate)) return candidate;
  }
  let suffix = 0;
  let candidate = `api-${suffix}`;
  while (taken.has(candidate)) {
    suffix += 1;
    candidate = `api-${suffix}`;
  }
  return candidate;
}

/**
 * Validate dialog input, returning message keys for each invalid field.
 *
 * An empty model is allowed at rest and rejected when connecting, matching
 * the legacy single-profile behavior; callers render each key via `t`.
 */
export function validateConnectionFields(input: { name: string; protocol: unknown; endpoint: string; model: string }): string[] {
  const errors: string[] = [];
  if (!isConnectionName(input.name)) errors.push("接続先名は 1〜64 文字で指定します");
  if (!isApiProtocol(input.protocol)) errors.push("通信形式を選びます。");
  const endpoint = input.endpoint.trim();
  if (!/^https?:\/\/\S+$/.test(endpoint) || endpoint.includes("@") || endpoint.split(/[#?/]/)[0].includes("@")) errors.push("endpoint は http:// または https:// です");
  const model = input.model.trim();
  if (model !== "" && (model.length > 256 || /[\0\n]/.test(model))) errors.push("model は 1〜256 文字で指定します");
  return errors;
}

/**
 * Migrate the legacy single profile into named connections, if it configures one.
 *
 * Migrates only the currently selected legacy backend and only when it
 * differs from an untouched default (custom endpoint or non-empty model);
 * ACP selections and untouched defaults yield null so no phantom
 * connections appear. The legacy profile itself is never modified here.
 * The connection ID is caller-minted so this stays pure and deterministic.
 */
export function migrateLegacyProfile(profile: AiProfile, defaultName: string, id: string): { connections: ApiConnection[]; activeId: string } | null {
  if (profile.kind !== "openai_compatible" && profile.kind !== "openai_responses" && profile.kind !== "anthropic") return null;
  if (profile.kind === "anthropic" && !profile.anthropicEnabled) return null;
  const fallback = profile.kind !== "anthropic" ? DEFAULT_ENDPOINTS.openai_compatible : DEFAULT_ENDPOINTS.anthropic;
  const customized = profile.endpoint.trim() !== "" && profile.endpoint.trim() !== fallback;
  if (!customized && profile.model.trim() === "") return null;
  const connection: ApiConnection = {
    id: id as ApiConnectionId,
    name: defaultName,
    protocol: profile.kind,
    endpoint: profile.endpoint.trim() === "" ? fallback : profile.endpoint.trim(),
    model: profile.model.trim(),
  };
  return { connections: [connection], activeId: connection.id };
}

/**
 * Resolve a provider change against the stored list without side effects.
 *
 * ACP and ID-less API selections clear the named marker without editing saved
 * records. API configs carrying a connectionId restore that saved record;
 * missing or deleted IDs report missing so callers keep the previous selection.
 * Only same-ID, same-protocol field edits refresh the active record: historical
 * configs using its old protocol cannot overwrite current endpoint/model data.
 * Callers persist the returned list first and apply the provider only on
 * persistence success.
 */
export function resolveProviderChange(
  list: ApiConnectionList,
  next: AiProviderConfig,
): { persist: ApiConnectionList | null; provider: AiProviderConfig | null; missing: boolean } {
  if (next.kind === "acp") {
    if (list.activeId !== null) return { persist: { ...list, activeId: null }, provider: next, missing: false };
    return { persist: null, provider: next, missing: false };
  }
  if (next.kind !== "openai_compatible" && next.kind !== "openai_responses" && next.kind !== "anthropic") {
    return { persist: null, provider: next, missing: false };
  }
  const nextId = next.connectionId ?? null;
  if (nextId !== null) {
    const target = list.connections.find((item) => item.id === nextId) ?? null;
    if (target === null) return { persist: null, provider: null, missing: true };
    if (target.id !== list.activeId || target.protocol !== next.kind) {
      return { persist: target.id === list.activeId ? null : { ...list, activeId: target.id }, provider: buildProviderConfigFromConnection(target), missing: false };
    }
    const endpoint = next.kind !== "anthropic" ? (next.openai?.endpoint ?? "") : (next.anthropic?.endpoint ?? "");
    const model = next.kind !== "anthropic" ? (next.openai?.model ?? "") : (next.anthropic?.model ?? "");
    if (endpoint === target.endpoint && model === target.model) {
      return { persist: null, provider: buildProviderConfigFromConnection(target), missing: false };
    }
    const updated: ApiConnection = { ...target, endpoint, model };
    return {
      persist: { ...list, connections: list.connections.map((item) => (item.id === target.id ? updated : item)) },
      provider: buildProviderConfigFromConnection(updated),
      missing: false,
    };
  }
  return {
    persist: list.activeId === null ? null : { ...list, activeId: null },
    provider: next,
    missing: false,
  };
}

/**
 * Build a wire provider config from one named connection.
 *
 * Trims pasted values; Anthropic connections always carry the opt-in flag.
 * An empty model stays empty here and is rejected at connection time.
 * The stable connection ID travels with the config so Rust resolves only
 * that connection's credential slot, never the legacy kind slot.
 */
export function buildProviderConfigFromConnection(connection: ApiConnection): AiProviderConfig {
  const endpoint = connection.endpoint.trim();
  const model = connection.model.trim();
  const connectionId = connection.id;
  if (connection.protocol !== "anthropic") {
    return { kind: connection.protocol, acp: null, openai: { endpoint, model }, anthropic: null, connectionId };
  }
  return { kind: "anthropic", acp: null, openai: null, anthropic: { enabled: true, endpoint, model }, connectionId };
}

/**
 * Find the stored connection matching a wire provider by protocol and endpoint/model.
 *
 * Returns null for ACP providers or unmatched API providers so the chat
 * switcher never highlights a foreign connection.
 */
export function findConnectionForProvider(list: ApiConnectionList, provider: AiProviderConfig): ApiConnection | null {
  if (provider.kind !== "openai_compatible" && provider.kind !== "openai_responses" && provider.kind !== "anthropic") return null;
  const endpoint = provider.kind !== "anthropic" ? provider.openai?.endpoint.trim() : provider.anthropic?.endpoint.trim();
  const model = provider.kind !== "anthropic" ? provider.openai?.model.trim() : provider.anthropic?.model.trim();
  return list.connections.find((item) => item.protocol === provider.kind && item.endpoint.trim() === endpoint && item.model.trim() === model) ?? null;
}
