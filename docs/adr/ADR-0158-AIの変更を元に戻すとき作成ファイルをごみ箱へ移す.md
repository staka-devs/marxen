# ADR-0158-AIの変更を元に戻すとき作成ファイルをごみ箱へ移す

- 状態: 採用
- 日付: 2026-10-22
- 関連 Issue: #127
- 置換元: ADR-0153 の「元に戻すは既存文書だけを対象とし、新規ファイルは残る」

## 決定

- AI の実行で作成されたファイルも「AI の変更」に含め（反映前の本文は空として差分表示）、「元に戻す」でその文書を閉じてファイルを OS のごみ箱へ移す。完全削除はしない（利用者が復元できる）。
- 作成後に編集された・未保存の文書は移さない（Rust の `trash_document` が改訂の一致と未保存でないことを検証する）。
- 通知に、ごみ箱へ移した件数と、編集後のため戻さなかった件数を示す。
- ごみ箱への移動は `trash` クレートを使う（Windows のごみ箱、macOS のゴミ箱、Linux の freedesktop ゴミ箱）。

## 確認方法

- `cargo test --test workspace trash_document_moves_only_unedited_files_to_the_trash`（Windows の実ごみ箱で実施）。
- `npx vitest run src/presentation/shell/WorkspaceShell.ai-review.test.tsx`（作成ファイルの元に戻すでごみ箱へ移動しタブを閉じる）。
- macOS・Linux の実ごみ箱は CI のみ。実エージェントでの操作は未確認。
