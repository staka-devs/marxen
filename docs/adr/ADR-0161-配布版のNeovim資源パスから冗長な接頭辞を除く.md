# ADR-0161-配布版のNeovim資源パスから冗長な接頭辞を除く

- 状態: 採用
- 日付: 2026-11-09

## 決定

- Tauri が返す資源ディレクトリの Windows 拡張パス接頭辞（`\\?\`、`\\?\UNC\`）を除いてから、同梱 Neovim の実行ファイルと `VIMRUNTIME` に使う。
- 接頭辞付きの `VIMRUNTIME` では、Neovim が runtime 内の Lua モジュール（`vim.snippet` など）を遅延読み込みできない。v0.2.0 の配布版では、キー入力ごとのマッピング判定がこのエラーで失敗し、エディタに入力できなかった。
- キー入力ごとに走るマッピング判定の Lua では、`vim.snippet` の参照を `pcall` で包む。モジュールが無くても入力を止めない。

## 確認方法

- `cargo test --features dev-tools --lib`（`strips_windows_verbatim_prefixes`）。
- Windows で `VIMRUNTIME=\\?\…\runtime` を与えると `require('vim.snippet')` が失敗し、通常パスなら成功することを確認済み。
- 配布版と同じ配置（`Marxen.exe` と `neovim/`）のリリースビルドで、修正前は全キー入力がエラー、修正後は入力できることを確認済み。
- インストーラー（NSIS）版と macOS / Linux の配布版は未確認。
