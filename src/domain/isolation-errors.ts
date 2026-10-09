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
export function describeIsolationError(cause: unknown): string {
  if (typeof cause === "object" && cause !== null && "code" in cause) {
    const record = cause as { code: string; detail?: string; path?: string };
    switch (record.code) {
      case "conflict":
        return `保存競合を検出しました (${record.path ?? "不明"})。最新のMarkdownに再同期してから承認してください。`;
      case "stale_revision":
        return "リビジョンが古いため拒否しました。再同期してください。";
      case "outside_workspace":
        return "作業コピーの外を指しているため拒否しました。";
      case "not_found":
        return "隔離コピーが見つかりません。再作成してください。";
      case "invalid_path":
        return "隔離コピーは利用できません。再作成してください。";
      case "not_markdown":
        return "Markdown 以外は隔離の対象外です。";
      case "io":
        return record.detail ?? "操作に失敗しました。";
      case "neovim":
        return `Neovim との通信に失敗しました: ${record.detail ?? ""}`;
      default:
        return `操作に失敗しました (${record.code})。`;
    }
  }
  return cause instanceof Error ? cause.message : String(cause);
}
