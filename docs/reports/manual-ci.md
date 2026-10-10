# CI 相当の手動検証

検証日: 2026-10-10。最新 UI の実装は `25a7fee430d16ea4e437c81cfdcafcd5890d8689`。[workflow](../../.github/workflows/ci.yml) のコマンドを手動で確認し、GitHub Actions の成功と区別する。

## Windows x64 の最新フロントエンドと配布

Node 22.23.2、npm 11.17、Rust 1.99.0、Neovim 0.11.5。Vitest threads / Playwright / Cargo は各 1 worker。テストの隔離と assertion を維持する。

| コマンド | 結果 |
| --- | --- |
| `npm ci` | exit 0、脆弱性 0。同一 lockfile の `bcec6af` で実行 |
| `npm run typecheck` | exit 0 |
| `npm run architecture:check` | exit 0、209 ファイル、1646/1646 操作に文書、違反 0 |
| `npm test -- --pool=threads --maxWorkers=1` | exit 0、43 ファイル / 255 件 |
| `npm run test:bundling` | exit 0、Node 19 件 |
| `npm run build` | exit 0 |
| `npm run test:e2e:product -- --workers=1` | exit 0、12 件 |
| `npm run test:e2e:live -- --workers=1` | exit 0、17 件 |
| `npm run tauri -- build --config src-tauri/tauri.bundle.conf.json --bundles nsis` | exit 0、未署名 Windows NSIS |

配布物と実 WebView の画面・範囲編集・Undo は [UI 検証](issue-20-ui.md)。

## 変更していない Rust・契約・Neovim の検証

次の結果は前回の配布ソース `4e9ffcf` に対応する。最新 UI ソースとの `src-tauri/` の差はなく、この表を今回の再実行としない。

| コマンド | 結果 |
| --- | --- |
| `npm run bundle:neovim -- --target x86_64-pc-windows-msvc` | exit 0 |
| `npm run verify:neovim -- --target x86_64-pc-windows-msvc` | exit 0、版・Markdown runtime・日本語・絵文字 |
| `npm run contracts:check` / `ai-contracts:check` / `isolation-contracts:check` | 各 exit 0 |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | exit 0 |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked --features dev-tools -j1` | exit 0、165 件 |
| `cargo check --manifest-path src-tauri/Cargo.toml --locked -j1` | exit 0 |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --locked --features dev-tools -j1 --all-targets -- -D warnings` | exit 0 |
| `RUSTDOCFLAGS="-D warnings" cargo doc --manifest-path src-tauri/Cargo.toml --locked --features dev-tools --no-deps --document-private-items` | exit 0、非公開操作・bin・build を含む |
| `npx playwright install --with-deps chromium` | exit 0 |

Rust 回帰・Clippy のソース `2bb2f3e` と `4e9ffcf` は実装トークンが同一。差は Rustdoc だけで、Rustdoc は `4e9ffcf` で検査した。165 件には実 credentials / ACP の opt-in 各一件を含み、既定の早期 return を実認証成功に含めない。Word の画像入り貼付は [統合検証](issue-9-integration.md) の配布ソースで確認している。

## Linux、macOS、GitHub Actions

[Linux 手動検証](issue-16-linux-manual-ci.md) の frontend は型・依存・文書・243 件・Node 19 件・build・E2E 29 件が成功した。これは最新 UI の Linux 再実行ではない。Linux native は開発依存不足、macOS 手動検証は未実施。macOS / Linux の実 WebView / IME の確認へ置き換えない。

`4e9ffcf` の [Actions](https://github.com/staka-devs/marxen/actions/runs/38027095455) は四 target とも step 数 0。注釈は支払い失敗または利用上限を示す。[最新 PR checks](https://github.com/staka-devs/marxen/pull/10/checks) と手動検証を区別する。

五層・SOLID・YAGNI・DRY は [TypeScript](issue-14-frontend-architecture.md)、[Rust](issue-15-backend-architecture.md)、[最新 UI](issue-20-ui.md) でレビューする。依存と文書の静的検査は成功し、原則の全面的な証明とは区別する。
