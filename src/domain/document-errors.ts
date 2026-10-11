// Deterministic document error shapes (domain).
//
// Pure Japanese messages and stale-revision detection. No Tauri, DOM, React,
// or browser globals: transports surface these shapes and the shell replaces
// its view instead of retrying blindly.

import type { DocumentSnapshot } from "../contracts/contracts";

/** Read-only message for the browser demo, never simulating a save. */
export const READONLY_MESSAGE = "ブラウザ表示では編集できません。デスクトップで開いてください。";

/**
 * Stale rejection carrying the freshly re-read authoritative snapshot.
 *
 * The real Neovim buffer moved out of band; callers replace their view with
 * `snapshot` and retry once only when the full source still matches.
 */
export class StaleResync extends Error {
  /** Fresh authoritative snapshot to replace the stale view. */
  readonly snapshot: DocumentSnapshot;
  /**
   * Create a stale resync carrying the fresh snapshot.
   *
   * Message includes the fresh revision so notices stay actionable.
   */
  constructor(snapshot: DocumentSnapshot) {
    super(`改訂が古いため最新のMarkdownに再同期しました（リビジョン ${snapshot.revision}）。`);
    this.name = "StaleResync";
    this.snapshot = snapshot;
  }
}

/**
 * Check whether a Tauri rejection is a revision-stale contract error.
 *
 * True only for `{ code: "contract", error: { code: "stale_revision" } }`;
 * all other shapes (including transport `Error`s) return false.
 */
export function isStaleError(cause: unknown): boolean {
  if (typeof cause !== "object" || cause === null) return false;
  const record = cause as { code?: unknown; error?: unknown };
  if (record.code !== "contract") return false;
  const inner = record.error as { code?: unknown } | undefined;
  return typeof inner === "object" && inner !== null && inner.code === "stale_revision";
}

/**
 * Describe any workspace/document failure in Japanese for notices.
 *
 * `StaleResync` keeps its message; transport `Error`s keep theirs unless
 * empty; wire `WorkspaceError` objects map per code without leaking `undefined`.
 */
export function workspaceErrorText(cause: unknown): string {
  if (cause instanceof StaleResync) return cause.message;
  if (cause instanceof Error) {
    // Tauri serializes WorkspaceError as a plain object, but real Error
    // instances (transport failures) keep their message.
    if (cause.message && cause.message !== "{}") return describeWorkspaceError(cause);
    return cause.message || String(cause);
  }
  return describeWorkspaceError(cause);
}

/**
 * Map a wire `WorkspaceError` (or transport error) to a Japanese message.
 *
 * Covers contract/stale, unsaved/conflict, workspace, type, encoding, path,
 * Neovim, and IO codes; unknown codes fall back to the raw code or JSON.
 */
function describeWorkspaceError(cause: unknown): string {
  if (typeof cause !== "object" || cause === null) return String(cause);
  const record = cause as { code?: unknown; [key: string]: unknown };
  switch (record.code) {
    case "contract": {
      const inner = record.error as { code?: unknown; expected?: unknown; received?: unknown } | undefined;
      if (inner?.code === "stale_revision") {
        return `改訂が古いため再同期してください（期待 ${String(inner.expected)}, 受信 ${String(inner.received)}）。`;
      }
      return `契約エラー: ${String(inner?.code ?? "不明")}`;
    }
    case "unsaved_changes":
      return "未保存の変更があるため操作できません。";
    case "conflict":
      return `保存競合: ディスクが変更されています（${String(record.path ?? "")}）。本文は保持しています。`;
    case "no_workspace":
      return "フォルダーが開かれていません。フォルダーを開いてください。";
    case "not_found":
      return "ファイルが見つかりません。";
    case "already_exists":
      return "宛先に既存のファイルがあるため上書きしません。";
    case "outside_workspace":
      return "ワークスペースの外には操作できません。";
    case "not_markdown":
      return "Markdown ファイル（.md / .markdown）のみ開けます。";
    case "not_text":
      return "対応する UTF-8 テキストファイルのみ開けます。";
    case "invalid_utf8":
      return "UTF-8 ではないため開けません。";
    case "invalid_path":
      return "パスが正しくありません。";
    case "invalid_image":
      return "対応画像（PNG/JPEG/GIF/WebP、20 MiB 以下）のみ扱えます。";
    case "neovim":
      return `Neovim エラー: ${String(record.detail ?? "")}`;
    case "io":
      return `入出力エラー: ${String(record.detail ?? "")}`;
    default:
      return typeof record.code === "string" ? record.code : JSON.stringify(cause);
  }
}
