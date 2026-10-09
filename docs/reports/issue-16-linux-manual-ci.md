# Linux x64 の手動検証

検証日: 2026-10-09。フロントエンドの検証ソース: `8150fa1`。Rust・契約出力・配布コマンドの検証ソース: `8eccced`。両者の `src-tauri/` の一致を比較した。Linux WebKitGTK / OS IME の検証ではない。

## 環境と workflow との差

Ubuntu 26.04.1 x64、Node 22.22.1、npm 9.2.0、Rust 1.99.0、Neovim 0.11.5。workflow は Ubuntu 24.04 / Node 22.23.2 であり、この環境と同一ではない。

Vitest の worker 数を 1 に制限し、assertion・timeout・retry を変更せず全 239 件が成功した。

Playwright は `TMPDIR="$PWD/.local/pw-download-temp" npx playwright install --only-shell chromium` を実行し、Headless Shell 153.0.8010.12 / v1243 を取得した。workflow の `--with-deps` による system package の準備は完了していない。ブラウザ E2E の実行結果と native 開発依存の不足を分けて評価する。

## 成功したコマンド

| コマンド | 結果 |
| --- | --- |
| `npm ci` | 成功、脆弱性 0 件 |
| `npm run bundle:neovim -- --target x86_64-unknown-linux-gnu` | 成功 |
| `npm run verify:neovim -- --target x86_64-unknown-linux-gnu` | 実 Neovim の版・Markdown runtime・日本語・絵文字を確認 |
| `npm run typecheck` | 成功 |
| `npm test -- --maxWorkers=1` | exit 0、38 ファイル / 239 件成功、コマンド全体 159 秒 |
| `npm run test:bundling` | Node 3 件成功 |
| `npm run build` | 成功 |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | 成功 |
| `CI=true npm run test:e2e` | exit 0。製品 12 件 / 43.7 秒、ライブ編集器 17 件 / 1.1 分。コマンド全体 113 秒 |

フロントエンド検証の終了後、ソースは `8150fa1` のまま変更なし。15 枚のブラウザ画像を検証用の保存先へコピーした。ブラウザの IME composition fixture の成功を、Linux 実 WebView / OS IME の成功として扱わない。

## native 開発依存で実行できない検証

以下を手動で実行したが、`pkg-config` がなく `libdbus-sys` / `glib-sys` 等の build script で停止する。Rust のテスト assertion や Clippy 診断まで到達していない。system package のインストールには対話的な管理者認証が必要で、この環境では完了していない。

| コマンド | 結果 |
| --- | --- |
| `npm run contracts:check` / `ai-contracts:check` / `isolation-contracts:check` | 各 exit 101、DBus の開発依存不足 |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked --features dev-tools -j2` | exit 101、GLib 等の開発依存不足 |
| `cargo check --manifest-path src-tauri/Cargo.toml --locked -j2` | exit 101、同上 |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --locked --features dev-tools -j2 --all-targets -- -D warnings` | exit 101、同上 |
| `CI=true npm run tauri -- build --target x86_64-unknown-linux-gnu --config src-tauri/tauri.bundle.conf.json --bundles deb,appimage` | exit 1、GLib 等の開発依存不足。package は未生成 |

`8eccced` の `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` は exit 0。Windows での同ソースの Rust 検証は [手動 CI](manual-ci.md) / [統合検証](issue-9-integration.md) を参照。Linux native テスト、deb / AppImage、実 WebView / IME は未確認として追跡する。
