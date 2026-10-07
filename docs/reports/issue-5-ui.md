# Issue #5 UI・ライブプレビュー・GUI範囲編集 検証報告

- 日付: 2026-10-07
- ブランチ: staka625/issue-5-ui
- 実装範囲: React / CodeMirror 6 のフロントエンドのみ。Rust 契約・アクター・IPC は変更しない（`contracts:check` で差分なし）。Issue #4 が Rust IPC 全体を所有するため、新規 Tauri コマンドを追加しない。

## 実装した内容

- 日本語シェル（`src/components/shell/WorkspaceShell.tsx`、`src/App.tsx`）: tree、tabs、quick open（Ctrl+P）、全文検索、outline、command palette（Ctrl+Shift+P）、テーマ（ライト / ダーク / ハイコントラスト）、設定画面（Neovim 設定名検証）。表示モード live / source / read / split は主エディタを維持して scroll / cursor を保つ。
- 編集基盤: `src/lib/utf16.ts`（UTF-16 境界・行対応・範囲適用）、`src/lib/markdown-gui.ts`（チェック切替・太字・斜体・取消線・コード・リンク・画像・表挿入・行列追加・行削除の範囲パッチ）、`src/lib/document-client.ts`（デスクトップ用 Tauri 送受信、IPC 不在時は読み取り専用で保存成功を模擬しない `ReadonlyTransport`、IME 確定のみの `CompositionGate`）。
- 表示: `src/components/editor/CodeMirrorEditor.tsx`（折り返し、確定単一コミット、選択報告、外部 snapshot 同期、通常モードの IME 確定キーを移動として横取りしない）、`src/components/preview/MarkdownPreview.tsx` + `src/lib/preview.ts`（Issue #5 最小描画、HTML 消毒）、`src/components/workspace/RawGridView.tsx` + `src/lib/grid.ts`（`grid_line` 解析の TS 移植、画面依存プラグイン用原文ビュー）。
- 依存整合: Issue #3 の `apply_edits` / `sync` / `save` と `Utf16Range` 契約のみを用いる。Issue #4 予告のコマンド名（`open_workspace`、`list_workspace`、`open_markdown`、`create_markdown`、`rename_markdown`、`search_workspace`、`close_document`、`poll_workspace_events`、`list_recovery`、`restore_recovery`、`load_relative_image`、`paste_image`）は `src/lib/workspace.ts` に型予告として記録し、実装・呼び出しはしない。表示移動は既定に任せて mapping を上書きしない。単語・テキストオブジェクト・マクロなど原文基準操作は実 Neovim が所有する。AI パネルは既存 Issue #7 の提供待ちのため組み込まない。

## ローカル結果

環境は Windows x64、Node 22.23.2、npm 11.17.0、Rust 1.99.0 MSVC、束ねた実 Neovim 0.11.5、Chromium（Playwright 1.63.0）。

| 検証 | 結果と根拠 |
| --- | --- |
| `./node_modules/.bin/tsc --noEmit` | 成功 |
| `./node_modules/.bin/vitest run` | 成功。範囲編集・UTF-16 境界・IME 確定・outline・検索・grid 解析・プレビュー消毒（`tests/fixtures/malformed-markdown.md`、`unsafe-html.md` の実物読み込みを含む）と読み取り専用拒否 |
| `./node_modules/.bin/playwright test --project chromium` | 成功。foundation 3（未接続の真実表示・読み取り専用・狭幅）と editor 5（モード維持・不正 fixture の安全表示・tree/tabs/quick-open/search/outline/palette/theme・原文ビュー・保存成功の非模擬） |
| UI 画像 | 成功。`docs/reports/issue-5-ui/live.png`、`read.png`、`source.png`、`split.png`、`palette.png`、`settings-dark.png` を E2E で生成 |
| `npm run contracts:check` | 成功。`src/shared/contracts.ts` に差分なし |
| `npm run test:bundling` | 成功。3 tests |
| `cargo test --no-default-features --locked`（lib 8、contracts 11） | 成功 |
| `cargo test --no-default-features --locked --test neovim`（実 Neovim 9 件） | 成功。`npm run bundle:neovim` / `verify:neovim` 後に日本語 composition、絵文字、mapping、モード、表示座標+grid、Undo 共有+stale 拒否、`:w` 委譲、設定エラー、cursor 検証が成立 |
| `cargo clippy --locked --no-default-features --all-targets -- -D warnings` | 成功 |
| `cargo check --locked`（desktop 既定） | 成功 |
| `cargo fmt -- --check` | 成功（Rust 無変更のため） |
| `npm run build` | 成功 |

## 未実施・制約

- Windows WebView2 + TSF、macOS WKWebView + NSTextInput、Linux WebKitGTK + IBus/Fcitx における実 IME の composition・確定・表示は未実施。Chromium の E2E と headless embed の成功から推定しない。GUI は確定だけを送る契約とし、詳細は ADR-0050 に記録した。
- macOS arm64 / x64 と Linux x64 の native compile・Neovim smoke・package 操作、署名 / 公証は未実施。4 native CI は Issue #2 の workflow を用いる。
- Issue #4 の workspace registry・全文置換・相対画像貼付保存・atomic save・外部変更検出・競合解決・未保存終了 / クラッシュ復元・`nvim_input` / `fetch_grid` / `redo` / 設定反映は本実装の対象外。ブラウザ見本は読み取り専用であり、保存成功や改訂増加を表示しない。
- プレビューの GFM 完全体（5 Alerts、脚注、MathJax、Mermaid、HTML sanitize 完全体、GeoJSON / TopoJSON / ASCII STL、Shiki、Leaflet / Three.js ローカル配布）は Issue #6 の責務とし、本プレビューは最小描画に留める。共有の原文オフセットを保ち、AST 描画基盤へ差し替え可能にする。
- `nvim_get_mode` が headless embed に応答しない件は Issue #3 の回避策（`mode()` 取得）を継承し、将来の版更新時に再確認する。
- AI パネル（Issue #7）の組み込みは提供待ちのため未実施。

## 意思決定と引き継ぎ

判断は `docs/adr/ADR-0050-UIとGUI範囲編集をNeovim正本で実装する.md` に記録した。Issue #6（描画基盤）は本シェルの `MarkdownPreview` と `tests/fixtures/github-markdown.md` を用い、Issue #4 は `src/lib/workspace.ts` の型予告に沿って Tauri コマンドを提供する。Tauri `resource_dir` 配下の実配置確認は Issue #3 の残課題として継続する。
