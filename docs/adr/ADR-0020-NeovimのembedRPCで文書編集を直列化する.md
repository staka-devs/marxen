# ADR-0020: Neovim の embed RPC で文書編集を直列化する

- 状態: 採用
- 日付: 2026-10-07
- 関連: Issue #3、ADR-0001（実 Neovim 正本）、ADR-0002（Rust 直列化）

## 背景

実 Neovim のバッファと Undo を GUI と共有する。文書ごとに編集を直列化し、応答と非同期の描画・バッファ通知を取り違えない接続が必要になる。

## 決定と理由

- `nvim --embed` の stdio に対して `rmpv` による msgpack-RPC クライアントを使う。専用 reader が要求 ID ごとの応答と通知を分離する。Tauri コマンドは文書アクター経由で編集する。
- UI を attach して Vim 入力と raw grid を扱う。モードは fast API の `nvim_get_mode()` の戻り値を共通の `VimMode` に写像する。次のキーを待つ状態の扱いは ADR-0023 に従う。
- ユーザー設定は隔離起動後に `:luafile` / `:source` で明示的に読み込み、評価エラーを `ConfigReport.errors` に返す。設定パスの扱いと配布資源の解決は ADR-0021 に定める。
- `redraw` の可変長の `grid_line` 更新を解析し、文字・強調・繰り返し数を保持する。
- 初期本文を Undo の開始点とする。GUI の範囲編集は末尾から適用し、一操作の複数範囲を一つの native Undo にまとめる。Vim の変更は正本から読み戻し、本文が変わった時だけ新しい revision を発行する。
- 保存は Rust が所有する。Vim の保存経路は ADR-0022、原子的なファイル置換と競合検知はワークスペースの保存契約に従う。保存だけでは revision を増やさない。

## 制約

GUI の IME は確定した本文差分だけを正本へ送る。表示幅とバイト位置を分け、UTF-16 のサロゲートを分断する編集を拒否する。画面依存 plugin は Neovim の原文ビューで扱う。

実 WebView の IME と headless Neovim の座標・編集検証は別の検証対象とする。各 OS の成功をブラウザやコンテナの結果から推定しない。

## 確認方法

同梱した実 Neovim に対し `src-tauri/tests/neovim.rs` と `neovim_runtime.rs` で座標、mapping、モード、Undo、保存経路、設定エラー、プロセス終了を検証する。配布資源がなければ明示的に失敗する。
