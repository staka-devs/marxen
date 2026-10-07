# Issue #5 UI・ライブプレビュー・GUI範囲編集 検証報告

- 日付: 2026-10-08
- ブランチ: staka625/issue-5-ui
- 実装範囲: React / CodeMirror 6 のフロントエンドのみ。Rust 契約・アクター・IPC は変更しない（`contracts:check` で差分なし）。Issue #4 が Rust IPC 全体を所有するため、新規 Tauri コマンドを追加しない。
- 実効モデル: MuseSpark1.3 Contributor / Xhigh（`opencode.jsonc` の build 設定と models API の `active` + `xhigh` 変種で確認、代替なし）。

## 実装した内容

- 文書レジストリ実接続（`src/components/shell/WorkspaceShell.tsx`、`src/lib/document-client.ts`）: 見本固定の単一文書状態とフロント履歴の Undo 鏡像を撤去し、全操作を Issue #4 IPC（`open_workspace` / `list_workspace` / `list_documents` / `open_markdown` / `create_markdown` / `rename_markdown` / `fetch_snapshot` / `apply_gui_edits` / `save_document` / `reload_document` / `close_document` / `search_workspace` / `poll_workspace_events`+`marxen:workspace` / `list_recovery` / `restore_recovery` / `discard_recovery` / `load_relative_image` / `paste_image` / `nvim_input` / `fetch_mode` / `fetch_cursor` / `report_cursor` / `fetch_grid` / `undo_document` / `redo_document` / `configure_document` / `fetch_config`）に接続した。文書 ID はレジストリ返値を保持し、タブ・再開・改名で同一 ID を使う。改訂は応答 snapshot のみで進め、古い改訂は再送せず最新に再同期する。
- フォルダー選択・ツリー・タブ・新規・改名・保存・終了時判断: フォルダー切替の未保存拒否を表示し、終了時は保存・破棄・キャンセルの判断ダイアログを出す。タブごとに実カーソルと実 Undo を保持する。
- 検索・置換: 実検索（開文書は文書 ID・改訂付き、未開封はディスク値）を表示し、置換は新 snapshot に対する範囲編集で行う。単体・一括とも stale では再同期する。
- Vim キー経路: シェル層でキー入力を Neovim 記法に写像し、文書ごとの直列キューで `nvim_input` に送る。通常・挿入・選択・演算子・コマンドラインを扱い、単語・テキストオブジェクト・マクロは原文基準のまま動く。表示・原文の移動基準を選択でき、CodeMirror 側に Vim バインドを置かないためユーザーマッピングを上書きしない。IME は確定のみ送信し、通常モードの IME キーを移動として横取りしない。UTF-16 範囲の送受信と UTF-8 変換は Rust が行う。
- 外部変更・競合・復旧・画像: 外部変更・削除の帯表示と再読込、保存競合の本文保持表示、復旧一覧の復元・破棄、相対画像の読込表示と貼付挿入（範囲付き改訂検証）を実装した。
- 原文ビュー・設定: `fetch_grid` の raw redraw 更新を描画し、vimrc / _vimrc / init.vim / init.lua の選択・評価エラー表示・明示再起動（本文・改訂・未保存維持、Undo・モード初期化）を行う。
- 日本語シェル: tree、tabs、quick open（Ctrl+P）、全文検索置換、outline、command palette（Ctrl+Shift+P）、テーマ、live / source / read / split（主エディタ維持で scroll / cursor 保持）。
- 描画 #6 との境界面はカーソル反映の追加 prop のみとし、装飾・ウィジェット・合成処理には触れない。AI パネルは提供待ちのため組み込まない。IPC が無いブラウザ表示は読み取り専用に留め、保存成功や改訂増加を表示しない。

## ローカル結果

環境は Windows x64、Node 22.23.2、npm 11.17.0、Rust 1.99.0 MSVC、束ねた実 Neovim 0.11.5、Chromium（Playwright 1.63.0）。

| 検証 | 結果と根拠 |
| --- | --- |
| `./node_modules/.bin/tsc --noEmit` | 成功 |
| `./node_modules/.bin/vitest run` | 成功。文書 ID・改訂の直送、直列化、stale 再同期、Vim キー写像、範囲置換、読み取り専用拒否（模擬 IPC）、範囲編集・UTF-16 境界・IME 確定・outline・検索・grid 解析・プレビュー消毒（`tests/fixtures/malformed-markdown.md`、`unsafe-html.md` の実物読み込みを含む） |
| `./node_modules/.bin/playwright test --project chromium` | 成功。foundation 3（未接続の真実表示・読み取り専用・狭幅）と editor 5（モード維持・不正 fixture の安全表示・tree/tabs/quick-open/search/outline/palette/theme・原文ビュー・保存成功の非模擬） |
| UI 画像 | 成功。`docs/reports/issue-5-ui/live.png`、`read.png`、`source.png`、`split.png`、`palette.png`、`settings-dark.png` を E2E で生成 |
| `npm run contracts:check` | 成功。`src/shared/contracts.ts` に差分なし |
| `npm run test:bundling` | 成功。3 tests |
| `cargo test --no-default-features --locked` | 成功（lib・contracts・workspace・neovim の実 Neovim 統合を含む） |
| `cargo clippy --locked --no-default-features --all-targets -- -D warnings` | 成功 |
| `cargo check --locked`（desktop 既定） | 成功 |
| `cargo fmt -- --check` | 成功（Rust 無変更のため） |
| `npm run build` | 成功 |

## 未実施・制約

- Windows WebView2 + TSF、macOS WKWebView + NSTextInput、Linux WebKitGTK + IBus/Fcitx における実 IME のキー・確定・表示は未実施。Chromium の E2E と headless embed の成功から推定しない。詳細は ADR-0051 に記録した。
- macOS arm64 / x64 と Linux x64 の native compile・Neovim smoke・package 操作、署名 / 公証は未実施。4 native CI は Issue #2 の workflow を用いる。
- デスクトップ実機の GUI 通し操作（実フォルダー・実ファイル・実 WebView）は未実施。デスクトップ経路は Vitest の模擬 IPC と Rust の実 Neovim 統合で検証し、ブラウザ E2E は読み取り専用の代替にしない。
- プレビューの GFM 完全体（5 Alerts、脚注、MathJax、Mermaid、HTML sanitize 完全体、GeoJSON / TopoJSON / ASCII STL、Shiki、Leaflet / Three.js ローカル配布）は Issue #6 の責務とし、本プレビューは最小描画に留める。
- AI パネル（Issue #7/#8）の組み込みは提供待ちのため未実施。

## 意思決定と引き継ぎ

判断は `docs/adr/ADR-0051-文書レジストリとVimキー経路でシェルを実接続する.md` に記録した。Issue #6（描画基盤）はカーソル反映 prop を境界面に装飾・ウィジェットを受け持ち、Issue #7/#8 は提供モジュールの到着後に組み込む。
