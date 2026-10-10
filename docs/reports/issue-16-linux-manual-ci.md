# Linux x64 の手動検証

検証日: 2026-10-10。Ubuntu 26.04.1 x64、Node 22.22.1、npm 9.2.0、Rust 1.99.0。workflow の Ubuntu 24.04 / Node 22.23.2 とは同一ではない。Linux WebKitGTK / OS IME の検証ではない。

## 実行結果

| コマンド | ソース | 結果 |
| --- | --- | --- |
| `npm run typecheck` | `4e9ffcf` | exit 0 |
| `npm run architecture:check` | `4e9ffcf` | exit 0、205 ファイル、1633/1633 文書、違反 0 |
| `npm test -- --maxWorkers=1` | `9b4cea8` | exit 0、40 ファイル / 243 件 |
| `npm run test:bundling` | `4e9ffcf` | exit 0、Node 19 件 |
| `npm run build` | `4e9ffcf` | exit 0 |
| `CI=true npm run test:e2e` | `4e9ffcf` | exit 0、製品 12 件 / ライブ 17 件 |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | `4e9ffcf` | exit 0 |
| `CARGO_BUILD_JOBS=1 cargo test --manifest-path src-tauri/Cargo.toml --locked --features dev-tools -j1` | `4e9ffcf` | exit 101、pkg-config / GLib の開発依存不足。assertion 前に停止 |

`9b4cea8` と `4e9ffcf` の製品 `src/` の差は末尾空行だけで、比較済み。単体の assertion を減らしていない。E2E の画像十五枚は検証用保存先に保存し、検証ソースは clean と確認した。

Linux の package、native 回帰、契約出力、Clippy、実 WebView / IME は、このソースで成功したとは扱わない。開発依存を準備した環境での確認が必要。macOS の結果にも置き換えない。

## 依存と配布資源の確認範囲

同一 lockfile の `npm ci`、Linux 用 Neovim の bundle / verify、Chromium の準備は 2026-10-09 の環境確認で実施した。Neovim 0.11.5 の版・Markdown runtime・日本語・絵文字を確認した。今回の frontend / Rust ソースの成功として古い検証を流用しない。

Windows の同実装の Rust・契約・配布検証は [手動 CI](manual-ci.md) / [統合検証](issue-9-integration.md) を参照する。
