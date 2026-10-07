# 実Neovimのembed RPCと文書アクターの技術検証

- 状態: 採用
- 日付: 2026-10-07
- 関連: Issue #3、ADR-0001（実 Neovim 正本）、ADR-0002（Rust 直列化）

## 背景と選択肢

実 Neovim を文書の正本とし、GUI 範囲編集・mapping・Undo を共存させる必要があった。RPC 方式は Tokio + nvim-rs と、標準スレッド + rmpv の自前 msgpack-RPC を検討した。後者を選ぶと test に async runtime が不要になり、Tauri コマンドの同期アクターと相性が良い。

## 決定と理由

- `nvim --embed` の stdio に `[0, id, method, params]` / `[1, id, error, result]` / `[2, method, params]` を話す同期クライアントを `rmpv` のみで実装する。reader スレッドが応答と通知を分離する。新規依存は `rmpv` / `unicode-width` / `tempfile` に限定する。
- モード取得は `nvim_get_mode` を使わない。実測で headless embed チャネルに応答が返らず 15 秒で timeout する（`nvim_get_current_buf` / `nvim_eval("mode()")` は応答する）。`nvim_call_function("mode")` の短縮形を契約の `VimMode` へ写像する。`parse_mode` は互換用に残す。
- ユーザー設定は `-u <path>` で起動せず、隔離起動後に `:luafile` / `:source` で明示読込する。実測で `--embed -u bad.lua` は stderr / `:messages` に何も残さず、RPC 経由の明示読込だけが E492 / E5113 を返す。読込失敗は `ConfigReport.errors` に残し、沈黙の fallback をしない。
- headless embed は UI なしでは `nvim_input` が処理されない（`i` でも Normal のまま）。文書アクターは 80x24 の最小 UI を attach し、mapping・挿入・grid を成立させる。raw セッションの検証も attach 後に行う。
- `redraw` 通知の `params` 自体が更新配列であり、`params[0]` ではない。`grid_line` の引数は `[grid, row, col, cells, wrap?]` の 4〜5 要素、cell は `[text]` / `[text, hl]` / `[text, hl, repeat]` の可変長である。可変長を受け付けて描画テキストを復元する。
- `:w` は `BufWriteCmd` autocmd で横取りし、Lua 側で書かず `marxen:save-requested` を通知する。バッファに実ファイル名を付けて E32 を避け、Rust の `fs::write` が保存を所有する。保存は revision を増やさない。
- 初期テキストは `nvim_buf_set_lines` 一回で置き、履歴を汚さない。GUI 編集は末尾から `nvim_buf_set_text` で適用し、Vim 側の変更は再読込で新 revision を採番する。GUI 編集と `u` は同一履歴を共有する。

## 結果と制約

- 日本語の composition（preedit 追加→確定置換）、絵文字の UTF-16/UTF-8 対応、ユーザー mapping 優先（`jj`）、モード追従、表示幅（Rust と `strdisplaywidth` の一致）、raw grid、GUI 編集と native Undo の共有、`:w` 委譲、設定エラー、stale revision 拒否が実 Neovim で成立する。
- 実 OS IME の制限: Windows の WebView2 + TSF、macOS の WKWebView + NSTextInput、Linux の WebKitGTK + IBus/Fcitx における composition・確定・表示の挙動は本機（Windows x64 の headless embed）では検証できない。GUI 側は composition を未確定 preedit の範囲編集として扱い、確定だけを正本へ送る契約とする。各 OS の実 WebView / IME 確認は未実施とし、コンテナや Chromium の成功から推定しない。
- 画面依存 plugin の操作は Neovim 原文 UI の範囲とし、本アクターは headless embed の成立条件だけを保証する。

## 確認方法

`npm run bundle:neovim` で束ねた実 Neovim 0.11.5 に対し `cargo test --locked`（`src-tauri/tests/neovim.rs` 全 8 件）で検証する。fake Vim は使わない。bundle が無い場合は明示エラーで止める。
