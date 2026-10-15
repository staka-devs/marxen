import type { Translator } from "../contracts/localization";
import { japaneseTranslator } from "./localization";
import { renderLocalizedText } from "./localization";
import { LocalizableError } from "./localized-error";
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
 * Describe workspace failures using the supplied locale and preserve opaque backend details.
 *
 * `StaleResync` keeps its message; transport `Error`s keep theirs unless
 * empty; wire `WorkspaceError` objects map per code without leaking `undefined`.
 */
export function workspaceErrorText(cause: unknown, t: Translator = japaneseTranslator): string {
  if (cause instanceof LocalizableError) return renderLocalizedText(cause.localized, t);
  if (cause instanceof StaleResync) return t("改訂が古いため最新のMarkdownに再同期しました（リビジョン {{value0}}）。", { value0: cause.snapshot.revision });
  if (cause instanceof Error) {
    // Tauri serializes WorkspaceError as a plain object, but real Error
    // instances (transport failures) keep their message.
    if (cause.message && cause.message !== "{}") return cause.message;
    return cause.message || String(cause);
  }
  const explanation = describeWorkspaceError(cause, t);
  if (typeof cause !== "object" || cause === null) return explanation;
  const record = cause as { code?: unknown; detail?: unknown; path?: unknown };
  const detail = typeof record.detail === "string" && record.detail !== "" && record.code !== "io" && record.code !== "neovim" ? ` ${record.detail}` : "";
  const path = typeof record.path === "string" && record.path !== "" && record.code !== "conflict" ? ` (${record.path})` : "";
  return `${explanation}${detail}${path}`;
}

/**
 * Map a wire `WorkspaceError` (or transport error) to a Japanese message.
 *
 * Covers contract/stale, unsaved/conflict, workspace, type, encoding, path,
 * Neovim, and IO codes; unknown codes fall back to the raw code or JSON.
 */
function describeWorkspaceError(cause: unknown, t: Translator = japaneseTranslator): string {
  if (typeof cause !== "object" || cause === null) return String(cause);
  const record = cause as { code?: unknown; [key: string]: unknown };
  switch (record.code) {
    case "unknown_root":
    case "stale_root":
    case "wrong_owner":
    case "stale_location":
      return t("フォルダーまたは文書の位置が変わりました。操作し直してください。");
    case "search_pattern":
      return t("検索パターンが不正、未対応、または上限を超えています。一致規則と上限を確認してください。");
    case "stale_search":
      return t("検索条件または本文が変わりました。検索し直してください。");
    case "search_incomplete":
      return t("検索結果が不完全なため置換できません。検索範囲を絞ってください。");
    case "contract": {
      const inner = record.error as { code?: unknown; expected?: unknown; received?: unknown } | undefined;
      if (inner?.code === "stale_revision") {
        return t("改訂が古いため再同期してください（期待 {{value0}}, 受信 {{value1}}）。", { value0: (String(inner.expected)), value1: (String(inner.received)) });
      }
      return t("契約エラー: {{value0}}", { value0: (String(inner?.code ?? t("不明"))) });
    }
    case "unsaved_changes":
      return t("未保存の変更があるため操作できません。");
    case "conflict":
      return t("保存競合: ディスクが変更されています（{{value0}}）。本文は保持しています。", { value0: (String(record.path ?? "")) });
    case "no_workspace":
      return t("フォルダーが開かれていません。フォルダーを開いてください。");
    case "not_found":
      return t("ファイルが見つかりません。");
    case "already_exists":
      return t("宛先に既存のファイルがあるため上書きしません。");
    case "outside_workspace":
      return t("ワークスペースの外には操作できません。");
    case "not_markdown":
      return t("Markdown ファイル（.md / .markdown）のみ開けます。");
    case "not_text":
      return t("対応する UTF-8 テキストファイルのみ開けます。");
    case "folder_open_documents":
      return t("フォルダー内に開いた文書があるため名前を変更できません。");
    case "folder_working_copy":
      return t("フォルダー内にAI作業コピーがあるため名前を変更できません。");
    case "invalid_utf8":
      return t("UTF-8 ではないため開けません。");
    case "invalid_path":
      return t("パスが正しくありません。");
    case "invalid_image":
      return t("対応画像（PNG/JPEG/GIF/WebP、20 MiB 以下）のみ扱えます。");
    case "neovim":
      return t("Neovim エラー: {{value0}}", { value0: (String(record.detail ?? "")) });
    case "io":
      return t("入出力エラー: {{value0}}", { value0: (String(record.detail ?? "")) });
    default:
      return typeof record.code === "string" && Object.keys(record).length === 1 ? record.code : JSON.stringify(cause);
  }
}
