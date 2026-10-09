# CI 相当の手動検証

検証日: 2026-10-09。対象コマンドは [Integration workflow](../../.github/workflows/ci.yml)。各コマンドの終了コードを確認した。GitHub Actions の成功としては扱わない。

## Windows x64

Windows / MSVC、Node 22.23.2、npm 11.17、Rust 1.99.0、同梱 Neovim 0.11.5。UI・フロントエンドのソースは `8150fa1`。Rust・生成契約の検証ソースは `8eccced` で、`8150fa1` の `src-tauri/` との一致を比較した。配布物の識別情報は [統合検証](issue-9-integration.md) に記載する。

| 手動実行したコマンド | 結果 |
| --- | --- |
| `npm ci` | 成功、脆弱性 0 件。依存 lockfile は検証後変更していない |
| `npm run bundle:neovim -- --target x86_64-pc-windows-msvc` | 成功 |
| `npm run verify:neovim -- --target x86_64-pc-windows-msvc` | 実 Neovim の版・Markdown runtime・日本語・絵文字を確認 |
| `npm run contracts:check` | 成功 |
| `npm run ai-contracts:check` | 成功 |
| `npm run isolation-contracts:check` | 成功 |
| `npm run typecheck` | 成功 |
| `npm test -- --maxWorkers=2` | exit 0、38 ファイル / 239 件成功 |
| `npm run test:bundling` | Node 3 件成功 |
| `npm run build` | 成功 |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | 成功 |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked --features dev-tools -j1` | Windows native Rust 162 件成功 |
| `cargo check --manifest-path src-tauri/Cargo.toml --locked -j1` | 成功 |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --locked --features dev-tools -j1 --all-targets -- -D warnings` | 成功 |
| `npx playwright install --with-deps chromium` | 成功 |
| `npm run test:e2e` | 製品 12 件 / ライブ編集器 17 件成功 |
| `npm run tauri -- build --config src-tauri/tauri.bundle.conf.json --bundles nsis` | 未署名 NSIS の生成に成功。展開・資源照合は統合検証に記載 |

並列度だけを Vitest 2 / Cargo 1 に制限し、Rust build cache を使用した。Windows の package コマンドは host が `x86_64-pc-windows-msvc` のため明示的な `--target` を省略した。workflow の別 target 用の出力ディレクトリとは異なるが、製品 feature と配布設定は同じ。テスト対象・assertion・retry は削減していない。

Rust の件数には、既定では早期 return する実資格情報ストアと実 ACP 接続の opt-in テスト各 1 件を含む。利用者の API 認証・生成の成功として扱わない。

## Linux x64

Linux のコマンド、実際の環境差、成功・実行不能の区別は [Linux 手動検証](issue-16-linux-manual-ci.md) に記載する。macOS arm64 / x64 の手動検証は未実施。

## GitHub Actions

`8150fa1` の [workflow run](https://github.com/staka-devs/marxen/actions/runs/37926614016) は 4 target とも step 数 0。Windows の check annotation はアカウントの支払い失敗または利用上限の制限を示す。コードのテスト結果や package は生成されていない。以降の対象コミットの状態は [PR #10 checks](https://github.com/staka-devs/marxen/pull/10/checks) を参照する。

## 設計レビュー

[フロントエンド](issue-14-frontend-architecture.md) と [Rust](issue-15-backend-architecture.md) で Clean Architecture、YAGNI、DRY、SOLID の各原則を確認する。未使用経路・重複・UI と IPC の責務混在を修正した。一方、Shell の状態所有、文書 actor の Neovim / 保存への具体依存、provider 追加時の分岐変更が残るため、厳密な完全準拠とは判定しない。
