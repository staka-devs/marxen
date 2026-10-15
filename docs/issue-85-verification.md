# Issue #85 名前変更の検証

実施日: 2026-10-15。Windows x64、Rust MSVC、同梱 Neovim 0.11.5。

## 実ファイルと実 Neovim

Cargo は `.local/cargo-target`、build jobs 1、test threads 1 を使用した。

| コマンド | 結果 |
| --- | --- |
| `npm run bundle:neovim` / `npm run verify:neovim` | 固定版資源を準備し、日本語・絵文字を含む実バッファの smoke 成功 |
| `cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --features dev-tools --test workspace -- --test-threads=1` | 29 件成功 |
| `cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --features dev-tools --lib rename_tests -- --test-threads=1` | 2 件成功 |

対応 UTF-8 テキストの名前変更後も DocumentId・revision・未保存内容と既存 disk bytes を維持し、Undo と新しい保存先への保存を実 Neovim で確認した。画像は actor を生成せず、ネイティブ fingerprint による disk 変更拒否・宛先衝突・画像種別不一致を確認した。フォルダーは子ファイルを保持して移動し、ルート・自分への移動・既存の空ディレクトリ・開いた未保存子孫・外部 junction 経由の移動を拒否した。二つの同時移動で一方だけが成功し、他方のファイルが保持されることを Windows の実ファイルで確認した。

## シミュレーションと静的検査

| コマンドまたは対象 | 結果 |
| --- | --- |
| `npm test -- --maxWorkers=1 src/presentation/shell/hooks/useWorkspace.workbench.test.tsx src/presentation/shell/WorkspaceShell.explorer.test.tsx src/infrastructure/tauri/workspace-api.test.ts` | 追加前の explorer 5 件を含め 20 件成功 |
| `npm test -- --maxWorkers=1 src/presentation/shell/WorkspaceShell.explorer.test.tsx` | F2・文脈メニュー・取消・名前変更後の行へのフォーカス復帰を追加した最終 7 件成功 |
| `src/infrastructure/images/image-loader.test.ts` | 上記とは別の対象実行で 1 件成功。キャッシュ失効と失効前の応答の再登録拒否を確認 |
| `npm run contracts:generate` | fingerprint とフォルダー拒否理由を含む TypeScript 契約を Rust から生成 |
| `.local/cargo-target/debug/export-contracts.exe --check` | 生成時の実行ファイルで TypeScript 契約の一致を確認 |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | 成功 |
| `npm run typecheck` | 成功 |
| `npm run architecture:check` | 330 files、2760/2760 named operations documented、0 violations |
| `npm run localization:check` | 807 complete base keys、61 presentation files、0 violations |
| `git diff --check` | 成功 |

Hook と GUI の検証では IPC を模擬し、画像および子フォルダーのタブ参照更新、捕捉した revision と画像 fingerprint の伝達、fingerprint 欠落時の拒否、未保存子孫の保持を確認した。実 WebView や実 IME の成功を意味しない。

## 未完了・未実施

- `cargo test ... --test isolation folder_guard -- --test-threads=1` はテスト本体の実行前にホストのメモリー確保失敗でコンパイラが中断した。閉じた子孫文書の AI 作業コピー・pin・scope の拒否テストは追加済みだが、実行成功は未確認。
- desktop feature の最終 `cargo check`、全 Rust テスト、Clippy、Rustdoc、Cargo 経由の契約 check とその他の契約 check、全フロントエンド suite、production build、bundling、Playwright、配布ビルドはこの差分の最終状態では未実施。
- Linux/macOS の no-replace adapter、各 OS の実 WebView/日本語 IME、実アプリでの一連の名前変更操作、四対象 CI は未実施。Windows のファイルテストや jsdom の結果から推定しない。
- 協調しない外部プロセスによるパス検証直後の親ディレクトリ差替えや画像バイト変更の最終 race は検証していない。
