# ADR-0070 AI接続とプロンプト送信の契約を定める

- 状態: 採用
- 日付: 2026-10-07
- 関連 Issue: #7 (担当 OpenCode)、#8 (隔離コピー連携)、Epic #1
- 予約枠: coordinator 指定の ADR-0070〜0079 の先頭を使用する

## 背景

ACP (Codex / OpenCode / カスタム)、OpenAI 互換 Chat Completions、Anthropic Messages の 3 backend を Rust が所有し、React の AI パネルから利用する。文書の正本は実 Neovim (#3)、隔離コピーと差分適用は #8 が所有するため、#7 は送信側の契約と transport に専念し、他担当の所有物を変更しない。

## 検討した選択肢

1. AI 型を `contracts.rs` に追加する / 独立した `ai_contracts.rs` に分ける。coordinator 指示どおり独立させ、文書契約 (#3) と AI スキーマ版を別々に進化できるようにした。
2. HTTP 実装を std のみにする / reqwest + rustls を使う。実 endpoint は https のため TLS が必須で、reqwest (rustls-tls-native-roots) を採用した。テストは 127.0.0.1 の mock server に対する平文 HTTP で実 transport 経路を検証する。
3. 資格情報の保管を自前ファイルにする / OS ストアを使う。`keyring` crate (Windows 資格情報マネージャー / macOS Keychain / Linux Secret Service) を `AgentKeyring` trait の背後に置き、テストは `MemoryKeyring` を使う。値は IPC に載せない。
4. ACP セッションを永続化する / 実行ごとに作り直す。v1 は実行ごとに initialize → session/new → prompt を行い、呼び出し側指定の session_id は未知として拒否する。cancel・timeout・隔離の見通しを優先した。
5. preset の既定 argv を仕様から断定する / 暫定値として実行時検証に委ねる。`codex acp` / `opencode acp` を暫定値とし、バイナリ不在は起動せず明示、handshake 失敗も明示する。実 CLI との照合は利用者環境での確認事項とした。

## 決定

- AI IPC スキーマ版 1 を `src-tauri/src/ai_contracts.rs` に定義し、`src/shared/ai-contracts.ts` を生成する。JSON field は camelCase、enum 値は snake_case。文書型 (`DocumentId` / `Revision` / `Utf16Range`) は読むだけで、`contracts.rs` を編集しない。
- Claude Code の preset を作らず、`claude` / `claude-code` の basename は custom argv でも拒否する (Rust とパネル双方で検証)。
- subprocess は argv 配列で直接起動し、シェルを介さない。`session/update` の `agent_message_chunk` のみを提案テキストに集約し、staging copy 内の変更は #8 の diff 対象として残す。
- エージェントに渡す cwd は隔離コピーの解決パスに限定し、staging root 外への逸脱は `live_target_rejected` で拒否する。解決自体は `StagingResolver` trait とし、#8 実装までは `RejectingResolver` が `staging_unresolved` を返す。
- モデル出力は `ProposalText` (text + base revision) のみで、直接書き込みは行わない。HTTP backend に `session_id` を付けた要求は拒否する。
- Anthropic は `enabled: true` の opt-in でのみ動作し、OpenAI 互換とは資格情報 slot を分ける。
- 接続テストは dry-run (設定・バイナリ存在・資格情報有無、通信なし) と live (明示 opt-in の最小要求。Anthropic は max_tokens: 1) を分ける。

## Tauri コマンド / イベント契約 (編集側担当者向け)

| コマンド | 引数 | 戻り値 / 効果 |
| --- | --- | --- |
| `ai_credential_state` | kind | `CredentialRef` (有無のみ) |
| `ai_set_credential` | kind, secret | 保存。値は返さない |
| `ai_delete_credential` | kind | 削除 (冪等) |
| `ai_test_connection` | config, live | `AiTestResult`。live のみ通信 |
| `ai_prompt_stream` | request | `AiRunId` を即時返却。`ai-stream` に進捗を emit |
| `ai_prompt_cancel` | runId | 中断の成否。ACP は process kill を伴う |

イベント `ai-stream` の `type`: `started` / `chunk` / `done` (proposal + sent) / `error` (AiError) / `cancelled`。`done.sent` が正確な送信範囲であり、パネルはこれを表示する。`AiError.code` の一覧と日本語文言は `src/lib/ai.ts` の `describeAiError` が正本の対応表である。

## 結果・制約

- ACP 実行は #8 の解決実装まで `staging_unresolved` で停止する。HTTP backend は資格情報があれば実行できる。
- preset 既定 argv と ACP メッセージ subset (initialize / session/new / prompt / cancel / agent_message_chunk) は実 CLI 照合が未済の暫定値である。
- セッション再開、tool 呼び出しの個別表示、Anthropic の非 stream 応答は v1 の範囲外である。
- AI パネル (`src/components/ai-panel.tsx`) は独立コンポーネントとして配布し、`App.tsx` への組み込みは UI 担当 (#5) の判断に委ねる。
- Linux の OS ストアは Secret Service (D-Bus) が実行時に必要で、無い環境では `credential_store_failed` を返す。

## 確認方法

- `cargo test --locked` (desktop) と `--no-default-features`: unit 20 + AI integration 12 + 文書契約 11 が成功。integration は mock HTTP server と mock ACP subprocess のみを使い、実資格情報・外部通信なし。
- `npm run typecheck`、`vitest run` (AI 8 件を含む 21 件)、`ai-contracts:check`、`contracts:check`、`cargo fmt --check`、`cargo clippy -- -D warnings`、`npm run build`、`test:bundling`、`test:e2e` (3 件) が成功。
- 実 WebView / IME / 署名 / 配布 package、macOS / Linux native、実 CLI との handshake は未実施であり、成功と記載しない。
