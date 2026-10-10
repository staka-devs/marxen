# Marxen

Markdown の原文と実 Neovim の操作を大切にするデスクトップエディタ。現在は Issue #2 の開発基盤で、日本語シェルと読み取り専用サンプルを提供します。編集・保存・Vim 操作は後続の Neovim actor で追加します。

## 起動と検証

CI / Linux x64 devcontainer は Node 22.23.2 と Rust 1.99.0 を使用します。Windows の MSVC / WebView2、macOS の Xcode Command Line Tools、Linux の WebKitGTK 4.1 など、[Tauri の前提環境](https://v2.tauri.app/start/prerequisites/)を用意してください。

```sh
npm install
npm run dev             # ブラウザ。Neovim 未接続を明示
npm run desktop:dev     # Tauri v2。actor はまだ未接続
npm run typecheck
npm test
npx playwright install chromium
npm run test:e2e
npm run build
npm run contracts:check
npm run test:bundling
cargo test --manifest-path src-tauri/Cargo.toml --locked
cargo check --manifest-path src-tauri/Cargo.toml --locked
```

Rust 型の変更後は `npm run contracts:generate` を実行します。GUI 依存のない環境では `cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --locked` で契約のみ検証できます。native Tauri の検証は別途必要です。

## 実 Neovim の同梱

```sh
npm run bundle:neovim
npm run verify:neovim
npm run desktop:build
```

公式 0.11.5 archive を固定 SHA-256 で検証し、実行ファイル・DLL・runtime 全体を取り込みます。配布コマンドは未署名 package を生成します。CI は Windows x64 (NSIS)、macOS arm64/x64 (app/DMG)、Linux x64 (deb/AppImage) の native build を設定します。

別 target の取得は `npm run bundle:neovim -- --target <Rust target>`。smoke は対応 OS / CPU で実行します。devcontainer の GUI にはホストの表示サーバーが必要です。WebView / 日本語 IME の実機確認はブラウザテストと分けます。

[契約仕様](docs/foundation.md)と[検証報告](docs/reports/issue-2-foundation.md)を参照してください。
