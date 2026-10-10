# CI 相当の手動検証

検証日: 2026-10-10。配布対象の実装は `4e9ffcf`。[workflow](../../.github/workflows/ci.yml) のコマンドを手動実行し終了コードを確認した。GitHub Actions の成功とは区別する。

## Windows x64

Windows / MSVC、Node 22.23.2、npm 11.17、Rust 1.99.0、Neovim 0.11.5。並列度は Vitest 2 / Cargo 1。テスト・assertion・retry を削減していない。

| コマンド | 結果 |
| --- | --- |
| `npm ci` | exit 0、脆弱性 0 |
| `npm run bundle:neovim -- --target x86_64-pc-windows-msvc` | exit 0 |
| `npm run verify:neovim -- --target x86_64-pc-windows-msvc` | exit 0、版・Markdown runtime・日本語・絵文字 |
| `npm run contracts:check` / `ai-contracts:check` / `isolation-contracts:check` | 各 exit 0、生成契約と一致 |
| `npm run typecheck` | exit 0 |
| `npm run architecture:check` | exit 0、205 ファイル、1633/1633 操作に文書、違反 0 |
| `npm test -- --maxWorkers=2` | exit 0、40 ファイル / 243 件 |
| `npm run test:bundling` | exit 0、Node 19 件 |
| `npm run build` | exit 0 |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | exit 0 |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked --features dev-tools -j1` | exit 0、165 件 |
| `cargo check --manifest-path src-tauri/Cargo.toml --locked -j1` | exit 0 |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --locked --features dev-tools -j1 --all-targets -- -D warnings` | exit 0 |
| `RUSTDOCFLAGS="-D warnings" cargo doc --manifest-path src-tauri/Cargo.toml --locked --features dev-tools --no-deps --document-private-items` | exit 0、非公開操作・bin・build の Rustdoc も検査 |
| `npx playwright install --with-deps chromium` | exit 0 |
| `npm run test:e2e` | exit 0、製品 12 件 / ライブ 17 件 |
| `npm run tauri -- build --config src-tauri/tauri.bundle.conf.json --bundles nsis` | exit 0、未署名 NSIS |

Rust 回帰・Clippy のソース `2bb2f3e` と配布ソース `4e9ffcf` は Rust の実装トークンが一致する。差は Rustdoc の表記だけ。フロントエンド単体のソース `9b4cea8` と `4e9ffcf` の `src/` の差は末尾空行だけ。Rustdoc、E2E、配布は最終実装で確認した。

165 件に含まれる実 credentials / ACP の opt-in テスト各一件は、既定では早期 return する。外部 provider の実認証・生成成功に含めない。実アプリ・Word・画像資源の結果は [UI](issue-17-ui.md) / [統合検証](issue-9-integration.md) を参照する。

## Linux と macOS

[Linux 手動検証](issue-16-linux-manual-ci.md) に成功・依存不足・ソースの区別を記載する。Linux frontend は型・依存・文書・243 件・Node 19 件・build・E2E 29 件が成功。Linux native は開発依存不足で未完了。macOS の手動検証は未実施。ブラウザや headless Neovim の成功を各 OS の実 WebView / IME に置き換えない。

## GitHub Actions と設計

`4e9ffcf` の [Actions](https://github.com/staka-devs/marxen/actions/runs/38027095455) は四 target とも step 数 0。Windows check の注釈は支払い失敗または利用上限を示し、テストと package は実行されていない。最新状態は [PR checks](https://github.com/staka-devs/marxen/pull/10/checks) を参照する。

五層、SOLID・YAGNI・DRY、文書・保存・取消・revision の契約を [TypeScript](issue-14-frontend-architecture.md) / [Rust](issue-15-backend-architecture.md) でレビューする。依存方向と文書の違反は 0。原則の全面的な証明と静的検査の成功は区別する。
