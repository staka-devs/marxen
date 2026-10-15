import { LocalizedError } from "../../domain/localized-error";
// Tauri AI transport (infrastructure).
//
// `ai_*` IPC, credential store, and stream subscription. The early-event
// buffer and run ownership live here with the transport so both chats keep
// one ordering: IPC can emit before returning its run ID, stale runs never
// touch UI, and unmount always cancels the owned run.

import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AiPromptRequest,
  AiProviderConfig,
  AiProviderKind,
  AiRunId,
  AiStreamEvent,
  AiTestResult,
  ApiConnectionId,
  ConnectionCredentialRef,
  CredentialRef,
} from "../../contracts/ai-contracts";
import { AI_STREAM_EVENT } from "../../domain/ai-config";
import { cancelPromptSafe as cancelPromptSafeCore } from "../../application/ai/ai-run-core";
import type { AiGateway, ApiConnectionGateway } from "../../application/ports";

/**
 * Require the desktop transport, throwing a localizable error in the browser.
 *
 * AI features never run in the read-only browser demo.
 */
export function requireDesktop(): void {
  if (!isTauri()) {
    throw new LocalizedError("AI 機能はデスクトップアプリで利用します。ブラウザ表示では使えません。");
  }
}

/**
 * Read whether a secret exists for the provider in the OS store.
 *
 * Presence only, never the secret value.
 */
export async function getCredentialState(kind: AiProviderKind): Promise<CredentialRef> {
  requireDesktop();
  return invoke<CredentialRef>("ai_credential_state", { kind });
}

/**
 * Store a secret for the provider in the OS store.
 *
 * Secrets never touch `localStorage`.
 */
export async function setCredential(kind: AiProviderKind, secret: string): Promise<void> {
  requireDesktop();
  await invoke("ai_set_credential", { kind, secret });
}

/**
 * Delete the stored secret for the provider from the OS store.
 *
 * Best-effort from settings UI; failures surface as invoke errors.
 */
export async function deleteCredential(kind: AiProviderKind): Promise<void> {
  requireDesktop();
  await invoke("ai_delete_credential", { kind });
}

/**
 * Test the provider connection, optionally with a live probe.
 *
 * Used by settings to validate endpoint/model/credentials before sending.
 */
export async function testConnection(config: AiProviderConfig, live: boolean): Promise<AiTestResult> {
  requireDesktop();
  return invoke<AiTestResult>("ai_test_connection", { config, live });
}

/**
 * Read whether a secret exists for one named connection in the OS store.
 *
 * Presence only, never the secret value.
 */
export async function getConnectionCredentialState(connectionId: ApiConnectionId): Promise<ConnectionCredentialRef> {
  requireDesktop();
  return invoke<ConnectionCredentialRef>("ai_connection_credential_state", { connectionId });
}

/**
 * Store a secret for one named connection in the OS store.
 *
 * Secrets never touch `localStorage`.
 */
export async function setConnectionCredential(connectionId: ApiConnectionId, secret: string): Promise<void> {
  requireDesktop();
  await invoke("ai_set_connection_credential", { connectionId, secret });
}

/**
 * Delete the stored secret of one named connection from the OS store.
 *
 * Removes only that connection's slot; other connections and legacy
 * kind slots stay untouched. Failures surface as invoke errors.
 */
export async function deleteConnectionCredential(connectionId: ApiConnectionId): Promise<void> {
  requireDesktop();
  await invoke("ai_delete_connection_credential", { connectionId });
}

/**
 * Copy the legacy kind credential into an empty connection slot inside Rust.
 *
 * Copies only when the target slot is absent; legacy slots are never
 * deleted and no secret crosses the IPC boundary.
 */
export async function migrateConnectionCredential(connectionId: ApiConnectionId, kind: AiProviderKind): Promise<ConnectionCredentialRef> {
  requireDesktop();
  return invoke<ConnectionCredentialRef>("ai_migrate_connection_credential", { connectionId, kind });
}

/** Owned prompt run with its cancellation handle. */
export interface PromptSession {
  runId: AiRunId;
  /** Cancel the owned run once and release the listener. */
  stop: () => Promise<void>;
}

/**
 * Best-effort cancel from UI handlers without surfacing cancel errors.
 *
 * Delegates to the application core so both chats share one guard.
 */
export async function cancelPromptSafe(stop: () => Promise<void>): Promise<void> {
  await cancelPromptSafeCore(stop);
}

/**
 * Start a streaming prompt, buffering early events until the run ID arrives.
 *
 * IPC can emit before `ai_prompt_stream` returns: events are queued (bounded
 * at 256) and delivered once the ID is known. Foreign run IDs and post-terminal
 * events are dropped; terminal events release the listener exactly once. The
 * returned `stop` cancels through IPC once and always releases the listener.
 */
export async function startPrompt(
  request: AiPromptRequest,
  onEvent: (event: AiStreamEvent) => void,
): Promise<PromptSession> {
  requireDesktop();
  let unlisten: UnlistenFn | null = null;
  let runId: AiRunId | null = null;
  let stopped = false;
  let completed = false;
  const pending: AiStreamEvent[] = [];
  /** Deliver one event when it belongs to the owned run and is not settled. */
  const deliver = (payload: AiStreamEvent) => {
    const eventRunId = payload.payload.runId;
    if (eventRunId !== runId || completed) return;
    const terminal = payload.type === "done" || payload.type === "error" || payload.type === "cancelled";
    if (terminal) completed = true;
    try { onEvent(payload); }
    finally {
      if (terminal) { unlisten?.(); unlisten = null; }
    }
  };
  unlisten = await listen<AiStreamEvent>(AI_STREAM_EVENT, (event) => {
    const payload = event.payload;
    if (runId === null) {
      // IPC can emit before returning its run id. Fence other runs first;
      // keep this temporary queue bounded while the command is pending.
      if (pending.length === 256) pending.shift();
      pending.push(payload);
      return;
    }
    deliver(payload);
  });
  try {
    runId = await invoke<AiRunId>("ai_prompt_stream", { request });
    for (const event of pending) deliver(event);
    pending.length = 0;
  } catch (cause) {
    unlisten?.();
    throw cause;
  }
  const owned = runId;
  return {
    runId: owned,
    /** Cancel the owned run once through IPC and release the listener. */
    stop: async () => {
      if (stopped) {
        return;
      }
      stopped = true;
      try {
        if (!completed) await invoke("ai_prompt_cancel", { runId: owned });
      } finally {
        unlisten?.();
      }
    },
  };
}

/** AI gateway adapter satisfying the application port with Tauri IPC. */
export const aiGateway: AiGateway = {
  /** Start a streaming prompt with early-event buffering. */
  startPrompt,
  /** Best-effort cancel without surfacing cancel errors. */
  cancelPromptSafe,
  /** Read credential presence for a provider. */
  getCredentialState,
  /** Store a secret in the OS store. */
  setCredential,
  /** Delete a secret from the OS store. */
  deleteCredential,
  /** Test a provider connection. */
  testConnection,
};

/** Per-connection credential gateway adapter satisfying the application port with Tauri IPC. */
export const apiConnectionGateway: ApiConnectionGateway = {
  /** Read credential presence for one named connection. */
  getConnectionCredentialState,
  /** Store a secret for one named connection in the OS store. */
  setConnectionCredential,
  /** Delete the secret of one named connection from the OS store. */
  deleteConnectionCredential,
  /** Copy the legacy kind credential into an empty connection slot inside Rust. */
  migrateConnectionCredential,
};
