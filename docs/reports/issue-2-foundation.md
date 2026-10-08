# デスクトップ基盤の検証

Windows x64、Node 22.23.2、Rust 1.99.0 MSVC で Rust / Tauri、React / TypeScript、IPC 契約、Neovim 配布資源を検証した。

| 検証 | 結果 |
| --- | --- |
| TypeScript と製品ビルド | typecheck / build 成功 |
| 配布資源スクリプト | Node 3 件成功 |
| IPC 契約 | 文書・AI・隔離の生成型と Rust 型が一致 |
| Rust | desktop を含むテスト、fmt、全 target の Clippy 成功 |
| 同梱 Neovim | 0.11.5、Markdown runtime、日本語・絵文字 buffer の smoke 成功 |
| Windows 配布 | NSIS を生成し、展開した実行ファイルと Neovim 資源を照合。展開先から実 WebView2 と同梱 Neovim を起動 |

全体の件数、配布物のハッシュ、各 OS の確認範囲は [統合検証報告](issue-9-integration.md) を参照する。ブラウザ E2E と headless Neovim は、OS 固有の実 WebView / IME の代替ではない。

devcontainer の Docker build、署名・公証、Windows インストーラーによる実インストールは未実施。
