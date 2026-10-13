import type { Translator } from "../contracts/localization";
import { japaneseTranslator } from "./localization";
import { renderLocalizedText } from "./localization";
import { LocalizableError } from "./localized-error";
// Deterministic isolation error text (domain).
//
// Pure Japanese messages for staging/approve/reject/cancel failures. No
// Tauri, DOM, React, or browser globals: the Tauri transport surfaces wire
// shapes and the shell shows these messages.

/**
 * Describe an isolation failure in Japanese for review notices.
 *
 * Covers conflict/stale/outside/not-found/path/markdown/IO/Neovim codes;
 * unknown codes fall back to their raw code instead of `undefined`.
 */
export function describeIsolationError(cause: unknown, t: Translator = japaneseTranslator): string {
  if (cause instanceof LocalizableError) return renderLocalizedText(cause.localized, t);
  if (typeof cause === "object" && cause !== null && "code" in cause) {
    const record = cause as { code: string; detail?: string; path?: string };
    switch (record.code) {
      case "conflict":
        return t("保存競合を検出しました ({{value0}})。最新のMarkdownに再同期してから承認してください。", { value0: (record.path ?? t("不明")) });
      case "stale_revision":
        return t("リビジョンが古いため拒否しました。再同期してください。");
      case "outside_workspace":
        return t("作業コピーの外を指しているため拒否しました。");
      case "not_found":
        return t("隔離コピーが見つかりません。再作成してください。");
      case "invalid_path":
        return t("隔離コピーは利用できません。再作成してください。");
      case "not_markdown":
        return t("Markdown 以外は隔離の対象外です。");
      case "io":
        return record.detail ?? t("操作に失敗しました。");
      case "neovim":
        return t("Neovim との通信に失敗しました: {{value0}}", { value0: (record.detail ?? "") });
      default:
        return t("操作に失敗しました ({{value0}})。", { value0: (record.code) });
    }
  }
  return cause instanceof Error ? cause.message : String(cause);
}
