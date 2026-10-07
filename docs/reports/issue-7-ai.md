# Issue #7 ACP・直接 API・AI 接続パネル 実装・検証報告

- 日付: 2026-10-07
- ブランチ: staka625/issue-7-ai
- この報告と全実装を同じコミットに含める。コミット SHA は worker_done に記載する。

## 実装した内容

Rust が AI transport と資格情報を所有し、React が AI パネルを提供する。文書契約 (`contracts.rs`) と基盤 UI (`App.tsx`) には触れていない。

- `src-tauri/src/ai_contracts.rs` (新規): AI IPC スキーマ版 1。provider (acp / openai_compatible / anthropic)、ACP preset (codex / opencode / custom、Claude Code なし)、argv、4 prompt mode、送信対象 (document / revision / ranges / 抜粋)、隔離コピー handle、提案テキスト、送信 echo、15 種類の `AiError`、資格情報の有無、テスト結果。`src/shared/ai-contracts.ts` を生成し、`ai-contracts:generate` / `ai-contracts:check` を追加した。
- `src-tauri/src/ai.rs` (新規): argv 検証 (Claude 拒否、shell なし)、endpoint / model / 要求検証 (範囲は抜粋テキスト境界で検証)、SSE decoder、OpenAI / Anthropic delta 解析と 401/403 の auth 振り分け、Content-Length フレーミング、ACP ライフサイクル tracker、OS keyring (`AgentKeyring` + `OsKeyring` + `MemoryKeyring`)、staging guard、mock transport、ACP stdio driver (initialize / session/new / prompt / cancel、timeout watchdog、kill による cancel)、HTTP SSE driver (reqwest + rustls)、dry-run / live 接続テスト、6 Tauri コマンド。
- `src-tauri/src/bin/mock-acp-agent.rs` (新規): integration 用 mock subprocess。`CARGO_BIN_EXE_mock-acp-agent` で起動し、`--respond-after-ms` / `--no-chunks` / `--exit-early` を持つ。
- `src-tauri/src/lib.rs`: 最小登録のみ (mod 追加と 6 コマンドの handler 追加)。`Cargo.toml` は `keyring` / `reqwest` (rustls) / `tokio` / `futures` と 2 bin を追加し、`Cargo.lock` を更新した。
- `src/lib/ai.ts` (新規): invoke wrapper、run 単位の event 振り分け、cancel、資格情報の browser 誤用防止、全 error code の日本語対応表、Claude 拒否の mirror、送信範囲の 1 行要約。
- `src/components/ai-panel.tsx` (新規): 接続先切替、ACP preset / custom argv (1 行 1 引数)、endpoint / model、Anthropic opt-in、資格情報の保存・削除 (値は非表示・password 入力)、dry-run / live テスト (live は明示 checkbox)、送信対象の正確な範囲表示、4 mode、送信・取消、stream 応答、提案と基準 revision、送信済み範囲、alert 表示。未解決 staging と無効 Anthropic では送信を disabled にする。
- `tests/fixtures/ai_sse_{openai,anthropic}.txt` (新規): Rust と TypeScript で共有する SSE 記録。どちらも `Hello, 世界！` に結合する。
- テスト: Rust unit 20 (`ai.rs` 内)、Rust integration 12 (`src-tauri/tests/ai.rs`: mock HTTP server 5 件相当、mock ACP subprocess 5 件、dry-run / handshake / resolver 2 件)、Vitest 8 件 (`ai.test.ts` + `ai-panel.test.tsx` を含む全 21 件)。追補後は unit 25、integration 19 (実機 handshake 1 件は環境変数指定時のみ実行)、全 Vitest 22。詳細は末尾の追補節。
- 判断記録は `docs/adr/ADR-0070-AI接続とプロンプト送信の契約を定める.md` (予約枠 0070〜0079 の先頭)。Tauri コマンド / イベント契約表を編集側担当者向けに含めた。

## ローカル結果

環境は Windows x64、Node 22.23.2、npm 11.17.0、Rust 1.99.0 MSVC。

| 検証 | 結果と根拠 |
| --- | --- |
| cargo test --no-default-features --locked | 20 unit + 12 AI integration + 11 文書契約が成功。外部通信は 127.0.0.1 のみ、実資格情報なし |
| cargo test --locked (desktop) | 同 43 件が成功。Tauri コマンド層を含む |
| cargo fmt -- --check | 成功 |
| cargo clippy --locked --offline --all-targets -- -D warnings | 成功 (drain_collect / while_let / single_match を修正) |
| npm run ai-contracts:check / contracts:check | 成功。イベント payload を named struct 化して camelCase (`runId`) を統一 |
| npm run typecheck | 成功 |
| npm test (Vitest) | 5 files / 21 tests 成功 (AI transport 7 件、AI パネル 8 件を含む) |
| npm run build | 成功。chunk size warning (724 KB) は #2 既知のまま |
| npm run test:bundling | 3 tests 成功 |
| npm run test:e2e | 実 Chromium で 3 / 3 成功。基盤 UI に回帰なし |

## 未実施・制約

- macOS arm64 / x64 と Linux x64 の native compile・package、`cargo test` の他 OS 実行は未実施。CI run は未実施。
- 実 Codex / OpenCode CLI との handshake は未実施。preset 既定 argv (`codex acp` / `opencode acp`) と ACP subset は暫定値で、バイナリ不在時は明示する設計である。Claude Code の実接続検証は禁止事項として実施していない。
- ACP 実行は #8 の `StagingResolver` 実装まで `staging_unresolved` で停止する。HTTP backend は利用者の資格情報設定後に有効化する。実資格情報・有料要求の送信は行っていない。
- AI パネルは独立コンポーネントとして Vitest で検証し、`App.tsx` へ組み込んでいない。組み込みとブラウザ E2E は UI 担当 (#5) の判断に委ねる。
- Windows / macOS / Linux の実 WebView 操作・日本語 IME、署名 / 公証、配布後の runtime 配置確認は未実施。Chromium の成功から推定しない。
- Linux の OS ストアは実行時に Secret Service (D-Bus) が必要で、無い環境では `credential_store_failed` になる。OS 実機確認は未実施。

## 意思決定と引き継ぎ

ADR-0001 (実 Neovim 正本)、ADR-0002 (Rust 直列化) に従う。固有の判断は ADR-0070 に記録した。`contracts.rs`、`App.tsx`、基盤 UI の所有コードは読むだけで変更していない。基盤側の修正が必要な箇所は見つからなかった。

次の担当は `src-tauri/src/ai_contracts.rs`、生成 `src/shared/ai-contracts.ts`、`src-tauri/src/ai.rs` (特に `StagingResolver`、`run_acp_prompt`、`AiError`)、`src/lib/ai.ts`、`src/components/ai-panel.tsx`、ADR-0070 を使用する。型変更時は `ai-contracts:generate` と `ai-contracts:check` を実行する。#8 は `StagingResolver` を実装して ACP driver に渡し、提案の適用は revision 付きレビュー経路に限定する。#5 は AI パネルの組み込み位置を決め、E2E を追加する。

## 運用ログ

`cargo test` の SSE 2 件失敗は mock server の Content-Length 見落とし (小文字 header) が原因で、読み取り側を case-insensitive に修正して再確認した。SSE payload の snake_case (`run_id`) は named struct 化で camelCase (`runId`) に統一し、生成物を commit する。push / PR は行わない。

## 追補 2026-10-07: NDJSON 是正と実機 handshake

- 公式調査: transports (NDJSON のみ)、codex-acp (バイナリ `codex-acp`、npm `@agentclientprotocol/codex-acp`)、opencode ACP (`opencode acp`)、schema (PermissionOption / outcome / StopReason / initialize / session 系) を取得し、ADR-0071 で ADR-0070 の transport 部分を置換した。`contracts.rs`、`App.tsx` には触れていない。
- 実装差し替え: Content-Length を廃止し NDJSON (独立実装の mock 付き) にした。Codex preset を引数なし `codex-acp` にし、自動取得はしない。`session/cancel` を通知化し、stopReason 振り分け、権限要求の deny-by-default (`reject_once` 選択・`cancelled` outcome・未知 method は `-32601`)、ID 厳密照合、500 ms poll による取消上限、stdin-close の graceful shutdown、version 不一致の `unsupported_protocol` を追加した。
- 実機 demo: 手元 OpenCode v2.0.24 (npm 版 `opencode.exe` の絶対パス + `acp`) に対し実 driver で initialize + session/new を成功 (protocol 1、session `ses_ee92d2f62ffenjt7T6aKw5zXv2`、通知 0 件、1.32 秒)。prompt は送っていない。WinGet 版 `opencode.exe` は起動直後に `Database is not empty and has no session table` で終了する利用者環境固有の状態で、Marxen の問題ではない。`codex-acp` 未導入のため missing-binary 経路を検証した。
- 検証: `cargo test` (両 feature) で unit 25 + AI integration 19 + 文書契約 11、`npm test` 22 件、`ai-contracts:check`、`contracts:check`、`typecheck`、`fmt`、`clippy -D warnings` が成功。実機 handshake テストは `MARXEN_REAL_ACP_BIN` / `MARXEN_REAL_ACP_ARGS` 指定時のみ実行し、未指定時は skip する。
- 既知の残件: 純粋 unit 25 件の wall clock が約 27 秒かかる (各テストは即時 ok。Windows Defender 等の実行環境要因と判断)。tool 通知の個別表示、承認 UI、session/load・resume・close、実 WebView / IME、macOS / Linux native、署名 / 配布は未実施。
