# Issue #3 実Neovim・IME・表示座標 技術検証報告

- 日付: 2026-10-07
- ブランチ: staka625/issue-3-neovim
- 実装範囲: `src-tauri` の Neovim / document モジュールと IPC binding のみ。フロントエンド / AI は変更しない。

## 実装した内容

- 同期 msgpack-RPC（`src-tauri/src/neovim/rpc.rs`）: `nvim --embed` の stdio  over `rmpv`。reader スレッドが応答と通知を分離する。新規依存は `rmpv` / `unicode-width` / `tempfile` のみ。
- 座標変換（`coordinates.rs`）: 全文 UTF-16 offset と Neovim `(row, UTF-8 byte col)` の相互変換、表示セル幅。`strdisplaywidth` と一致することを実測する。
- 設定（`config.rs`）: 既定は隔離（`-u NONE`）。ユーザー `vimrc` / `_vimrc` / `init.vim` / `init.lua` は起動後に `:source` / `:luafile` で明示読込し、失敗を `ConfigReport.errors` に残す。
- mapping（`mapping.rs`）: ユーザー mapping の検査と適用のみ。自前既定で上書きしない。
- モード（`mode.rs`）: 短縮形→`VimMode` の単一写像。`nvim_get_mode` は headless embed で応答しない実測のため `mode()` 取得を用いる。
- grid（`grid.rs`）: `nvim_ui_attach` と `redraw` の `grid_line` 解析。可変長引数に対応する。
- セッション（`neovim/mod.rs`）: bundle 解決、buffer 真理値操作、カーソル、Undo/Redo、`:w` 横取り（`BufWriteCmd`→通知、書込なし）。
- 文書アクター（`document/mod.rs`）: revision 直列化、末尾からの範囲適用、Vim 側 drift の再同期、Rust 所有の保存（revision 不変、dirty 解消）。
- IPC（`ipc.rs`、`lib.rs`）: `open_document` / `fetch_snapshot` / `apply_gui_edits` / `save_document` / `fetch_mode` / `undo_document` を登録。契約型 v1 は不変で `contracts:check` が通る。

## ローカル結果

環境は Windows x64、Node 22.23.2、npm 11.17.0、Rust 1.99.0 MSVC、束ねた実 Neovim 0.11.5。

| 検証 | 結果と根拠 |
| --- | --- |
| `npm run bundle:neovim` / `verify:neovim` | 成功。実 Neovim 0.11.5 の版・Markdown runtime・日本語・絵文字 buffer smoke を確認 |
| `cargo test --no-default-features` | 成功。lib 8、既存 contracts 11、新規 `tests/neovim.rs` 8（日本語 composition、絵文字、mapping、モード、表示座標+grid、Undo 共有+stale 拒否、`:w` 委譲、設定エラー） |
| `cargo check --locked`（desktop 既定） | 成功。Tauri コマンドの型を含めて確認 |
| `cargo clippy --locked --all-targets -- -D warnings` | 成功（no-default-features と desktop の両方） |
| `cargo fmt -- --check` | 成功 |
| `npm run contracts:check` | 成功。`src/shared/contracts.ts` に差分なし |
| `npm run typecheck` / `npm test`（Vitest）/ `npm run test:bundling` | 成功。typecheck clean、Vitest 3 files / 5 tests、Node bundling 3 tests |

## 未実施・制約

- Windows WebView2 + TSF、macOS WKWebView + NSTextInput、Linux WebKitGTK + IBus/Fcitx における実 IME の composition・確定・表示は未実施。本機は headless embed のみで、ブラウザやコンテナの成功から推定しない。GUI は確定だけを正本へ送る契約とし、詳細は ADR-0014 に記録した。
- macOS arm64 / x64 と Linux x64 の native compile・Neovim smoke・package 操作、署名 / 公証は未実施。4 native CI は Issue #2 の workflow を用いる。
- Playwright E2E は今回の対象外（フロントエンド未変更）。実 WebView の代替にしない。
- `nvim_get_mode` が headless embed に応答しない件は回避策（`mode()` 取得）で成立させ、将来の版更新時に再確認する。

## 意思決定と引き継ぎ

判断は `docs/adr/ADR-0014-実NeovimのembedRPCと文書アクターの技術検証.md` に記録した。Issue #5（GUI 範囲編集）は本アクターの `apply_edits` / `sync_from_nvim` / `save` と `Utf16Range` 契約を用い、Issue #4（保存競合・復元）は `StaleRevision` と `dirty` を用いる。Tauri の `resource_dir` 配下の解決は現行の manifest-dir 優先に加え、配布時の実配置確認が残っている。
