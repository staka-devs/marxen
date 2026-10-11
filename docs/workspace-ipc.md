# ワークスペースと文書 IPC

`src/lib/workspace.ts` の `workspaceApi` と `listenWorkspaceEvents` を使用する。
型は Rust の `contracts.rs` から `src/shared/contracts.ts` へ生成する。
ブラウザ表示には実ファイル・Neovim の代替を用意しない。

## 基本契約

`openWorkspace(path)` の path は絶対フォルダーパス。以後はワークスペース相対の
`/` 区切りで `.md` または `.markdown` を開く。同じファイルは同じ文書 ID を返す。
複数文書は別々の実 Neovim と Undo を保持する。
フォルダー切替は未保存文書があれば拒否する。

`OpenDocument` は `{path, snapshot}`。
snapshot.text は BOM・CRLF・末尾空行を含む UTF-8 原文そのもの。
BOM (U+FEFF) と CR も UTF-16 オフセットに含む。
`SaveRequest` は `{documentId, baseRevision}`。
編集範囲はグローバル UTF-16 の半開区間 `[start, end)`。
古い revision、サロゲート分断、重複範囲を拒否する。

## コマンド

| TypeScript メソッド | Rust IPC | 引数・結果 |
| --- | --- | --- |
| openWorkspace | open_workspace | path → WorkspaceInfo |
| listWorkspace | list_workspace | path (ルートは空文字) → WorkspaceEntry[] |
| listDocuments | list_documents | → OpenDocument[] |
| openMarkdown | open_markdown | path → OpenDocument |
| createMarkdown | create_markdown | path, text → OpenDocument (ディスクへ作成) |
| renameMarkdown | rename_markdown | SaveRequest, path → OpenDocument |
| fetchSnapshot | fetch_snapshot | documentId → DocumentSnapshot |
| applyEdits | apply_gui_edits | SaveRequest, TextEdit[] → DocumentSnapshot |
| saveDocument | save_document | SaveRequest → SaveResult |
| reloadDocument | reload_document | SaveRequest → DocumentSnapshot |
| closeDocument | close_document | SaveRequest, save/discard/cancel → boolean |
| searchWorkspace | search_workspace | query → SearchMatch[] |
| pollEvents | poll_workspace_events | → WorkspaceEvent[] |
| listRecovery | list_recovery | → RecoveryEntry[] |
| restoreRecovery / discardRecovery | restore_recovery / discard_recovery | documentId → OpenDocument / void |
| loadImage | load_relative_image | documentId, path → ImageData |
| pasteImage | paste_image | SaveRequest, name, Uint8Array, range → PasteResult |
| input | nvim_input | SaveRequest, keys → DocumentSnapshot |
| fetchMode / fetchCursor | fetch_mode / fetch_cursor | documentId → ModeUpdate / CursorUpdate |
| reportCursor | report_cursor | CursorUpdate → CursorUpdate |
| fetchGrid | fetch_grid | documentId, width, height → GridUpdate |
| undo / redo | undo_document / redo_document | documentId → DocumentSnapshot |
| configure | configure_document | SaveRequest, path/null → NvimConfig |
| fetchConfig | fetch_config | documentId → NvimConfig |

検索は大文字小文字を区別する文字列検索。開いた文書は未保存の Neovim 本文を検索し、
documentId と revision を返す。未開封ファイルはディスクを検索し両値は null。
検索置換は文書を開き、その snapshot に対して `applyEdits` を行う。
`open_document` はパスを受け付けない未命名バッファ用の低水準 API。
ファイル保存が必要な新規文書は `createMarkdown` で名前を付けて作る。

reportCursor は anchor/head を検証し、head の実 Neovim カーソルを動かす。
`has_nvim_mapping(documentId, mode, lhs)` は表示操作の前に global / buffer-local の mapping の先頭キーを確認する。mode は `n/i/v/x/s/o/c/t`、lhs は Vim キー文字列。進行中の Vim 操作や入力待ちも true を返し、続きのキーを Neovim へ届ける。
GUI の選択 anchor は GUI が保持し、fetchCursor は実 Vim カーソルを返す。
GridUpdate.updates は実 Neovim の raw redraw 通知。
configure は明示的再起動で、本文/revision/未保存状態を維持し、Undo とモードを初期化する。
設定評価エラーは NvimConfig.errors、読めない設定では元セッションを保持する。

## 保存、外部変更、復旧

GUI 保存と `:w` は同じ Rust の保存処理に入る。
本文の UTF-8 バイト列を変換せず、同じディレクトリの一時ファイルへ全量を書き、
同期し、SHA-256 のディスク基準値を再確認して置換する。
Unix の mode と Windows の ACL・名前付きストリームを維持する。
新規作成とリネームは既存宛先を上書きしない。
リネームは hard link と元名除去で行うため、非対応の保存先ではエラーを返す。

500ms 監視が `marxen:workspace` に WorkspaceEvent[] を送る。
listenWorkspaceEvents または pollEvents を利用する。同じ fingerprint の変更は重複通知しない。
本文は自動で置き換えず、external_change の dirty/deleted を表示する。
clean な文書だけが reloadDocument で明示的再読込を許可する。
拒否と error イベントは WorkspaceError。stale_revision では snapshot を取得して再同期する。
競合・保存失敗では本文を保持し、close の save を中止する。
明示的 discard だけが未保存本文と復旧記録を捨てる。

復旧記録はアプリデータの `recovery/<workspace の識別値>/` に置く。
編集を Neovim から読み戻した後に同期してから成功を返す。
プロセス/Neovim 終了後も最後に確認した本文を復元する。
RecoveryEntry.conflict は復元時のディスク変更を示し、古い基準値を保持して保存競合を拒否する。
保存成功、保存済み本文への Undo、明示的破棄で記録を除去する。

保存は外部プロセスにロックを強制しない。
最終 fingerprint 確認と OS 置換の間の compare-and-swap は保証しない。
置換後の同期・後処理失敗も成功扱いにせず、未保存状態と復旧記録を保持する。

## 画像

PNG/JPEG/GIF/WebP の相対参照とパーセントエンコードした日本語・空白の名前を扱う。
`../` は最終パスがワークスペース内にある場合のみ許可する。
リンク、外部 junction、絶対パス、Windows ADS は拒否する。
SVG はこのバイト転送 API の対象外。上限は 20 MiB。
貼付は文書の隣の images/ に書き、指定範囲に Markdown 参照を revision 付きで挿入する。
名前衝突・古い revision は拒否する。
画像作成後に Neovim 編集が失敗した場合は画像を保持してエラーを返す。
