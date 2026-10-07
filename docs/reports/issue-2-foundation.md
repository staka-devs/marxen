# Issue #2 基盤 実装・検証報告

- 日付: 2026-10-07
- ブランチ: staka625/issue-2-foundation
- 現行 Dispatch: ctx_7c27929f3352 / Task task_eb36870a6d0b
- この報告と全実装を同じコミットに含める。コミット SHA は coordinator への worker_done に記載する。

## 実装した内容

Rust / Tauri v2 と React / TypeScript / Vite / Tailwind v4 の起動基盤、Radix / cva による shadcn/ui 形式の Button / Card、CodeMirror 6 の読み取り専用 Markdown サンプルを実装した。日本語シェルは Rust の get_runtime_status を使用し、Neovim actor 未実装を表示する。ブラウザ起動、取得中、取得失敗を区別し、Vim / 編集 / 保存を偽装しない。

Rust の contracts.rs を正本として TypeScript を生成する。ID / revision / UTF-16 offset / UTF-8 byte / snapshot / edit / save / cursor / mode / event / error を定義し、validation.rs で exact revision、ID、半開範囲、非重複編集、Unicode 境界を検証する。共通 JSON fixture を Rust / TypeScript で使用する。

Windows x64、macOS arm64/x64、Linux x64 の native CI、Linux x64 devcontainer、固定版 Neovim 0.11.5 の全 runtime 同梱を追加した。公式 release asset の SHA-256 を固定し cache も検証する。Tauri 配布設定は neovim/ 全体を resources として配置する。npm / Cargo lock と desktop icons を含める。

root opencode.jsonc は指示どおりそのまま子 checkout にコピーした。Muse 1.3 Contributor / xhigh の設定保存は実効モデルの確認とは区別する。この作業では OpenCode / Claude Code を起動せず、委任もしていない。

## ローカル結果

環境は Windows x64、Node 22.23.2、npm 11.17.0、Rust 1.99.0 MSVC。

| 検証 | 結果と根拠 |
| --- | --- |
| npm install | 前段の worker 実行成功。0 vulnerabilities。coordinator も完了を報告 |
| npm run build / typecheck | 前段の worker 実行成功。production assets を生成 |
| npm test | 前段の worker 実行で Vitest 3 files / 5 tests 成功 |
| npm run test:bundling | 前段の worker 実行で Node 3 tests 成功 |
| cargo test --no-default-features --locked | 前段の worker 実行で 11 integration tests 成功 |
| cargo test --locked (desktop default) | coordinator が Windows native 11 tests 成功を報告。復旧後に重複実行せず採用 |
| cargo check --locked --offline | 現行 Dispatch で Windows native 成功。WebView2 / wry / Tauri を含む |
| cargo fmt -- --check | 現行 Dispatch で成功 |
| cargo clippy --locked --offline --all-targets -- -D warnings | 現行 Dispatch で成功 |
| npm run contracts:check | 現行 Dispatch で成功。Cargo に --check を渡す separator の不具合を発見・修正して再確認 |
| npm run verify:neovim | 現行 Dispatch で実 Neovim 0.11.5 / Markdown runtime / 日本語・絵文字 buffer smoke 成功 |
| npm run test:e2e | 現行 Dispatch の実 Chromium で 3 / 3 成功 (14.5s)。日本語・未接続表示、CodeMirror 非変更と開閉、375px 幅を確認 |

前段の passing checks は同じ実装に対する実行履歴を採用し、復旧後に繰り返していない。復旧後の変更は文書と npm script の argument separator 修正のみで、アプリ / Rust の動作コードは変更していない。修正した script の整合性チェックを再実行した。

production build は CodeMirror を含む約 724 KB の JS chunk に関する size warning を出すが成功する。現段階では blocker ではなく、後続 UI 実装で chunk 分割を検討できる。

## 未実施・制約

- macOS arm64 / x64 と Linux x64 の native compile、Neovim smoke、package 操作は手元で未実施。4 native runner の workflow を用意したが push / PR しておらず CI run は未実施。
- Windows / macOS / Linux の実 WebView 操作・日本語 IME・mapping・Undo・表示座標は未実施。Chromium の成功から推定しない。
- NSIS / DMG / deb / AppImage のローカル package build と配布後の runtime 配置確認、署名 / 公証は未実施。
- devcontainer の Docker build は未実施。docker version で dockerDesktopLinuxEngine の named pipe が存在せず、daemon に接続できなかった。
- Neovim actor、RPC、workspace、編集 / 保存、live preview、AI は後続 Issue の範囲。現在は共通型と validation だけで、権威ある文書をフロントエンドに作らない。

## 意思決定と引き継ぎ

coordinator 管理 ADR-0001 (実 Neovim 正本)、ADR-0002 (Rust 直列化)、ADR-0003 (devcontainer) に従う。固有の判断は docs/adr/ADR-0010〜0013 に、型生成、truthful UI、固定 runtime、native / browser 検証境界として記録した。root の AGENTS.md、implementation.md、ADR README を変更していない。

次の担当は src-tauri/src/contracts.rs、src-tauri/src/validation.rs、生成 src/shared/contracts.ts と docs/foundation.md を使用する。型変更時は contracts:generate と contracts:check を実行する。actor で文書変更を直列化し、stale revision を再同期、bundled resource_dir の Neovim と VIMRUNTIME を使用する。保存先パスや任意 process を JavaScript に公開しない。

## 運用ログ

Orca 復旧で旧 Dispatch ctx_045947f5f7ed から現行 ctx_7c27929f3352 に移行し、未追跡の実装を保存した。復旧後の通常ツール起動は orchestrator_helper_launch_canceled / ShellExecuteExW 1223 で停止したため、既に承認された PowerShell -Command の実行経路で必要な作業を継続した。依存取得、Chromium install、Neovim archive の取得を重複させず、pending ask に対して解消状況を coordinator に通知した。
