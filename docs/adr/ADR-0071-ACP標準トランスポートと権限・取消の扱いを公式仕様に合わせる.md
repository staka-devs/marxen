# ADR-0071 ACP標準トランスポートと権限・取消の扱いを公式仕様に合わせる

- 状態: 採用
- 日付: 2026-10-07
- 関連 Issue: #7 (担当 OpenCode)、#8 (隔離コピー連携)、Epic #1
- 置換元: ADR-0070 のうち Content-Length フレーミング、`codex acp` 既定、`session/cancel` 要求形式に関する部分。その他の決定 (独立スキーマ、資格情報、提案のみ出力、staging 境界) は維持する
- 典拠: https://agentclientprotocol.com/protocol/v1/transports 、 https://github.com/agentclientprotocol/codex-acp 、 https://opencode.ai/docs/acp/ 、同 schema (PermissionOption / RequestPermissionOutcome / StopReason / Initialize / session 系)

## 背景

ADR-0070 時点の実装は Content-Length フレーミング、`codex acp` という推測の既定 argv、`session/cancel` への ID 付与など、公式仕様との差分を含んでいた。実 OpenCode (v2.0.24) との initialize / session/new を無償範囲で実証し、差分を修正する。

## 検討した選択肢

1. Content-Length を独自拡張として残す / 公式 NDJSON に統一する。公式は「1 行 1 compact JSON、改行なし、UTF-8 必須、stdout に ACP 以外を書かない」と定めており、実エージェントは Content-Length を解釈しないため NDJSON に統一した。
2. Codex 既定を `codex acp` にする / `codex-acp` バイナリにする。公式 adapter は npm `@agentclientprotocol/codex-acp` の `codex-acp` バイナリであり、`codex acp` という subcommand は存在しないため後者にした。未導入環境への自動取得 (npx 含む) は行わず、missing-binary として明示する。
3. 権限要求を黙って無視する / 明示的に拒否する。承認 UI がないため、拒否 option の選択 (`reject_once` 優先) による deny-by-default とし、option が無い場合と取消後は spec の `cancelled` outcome を返す。未知の agent 発信要求 (fs / terminal / elicitation 等) は `-32601` で返す。capability は広告しない。
4. 取消を kill のみで行う / `session/cancel` 通知を送って `cancelled` 応答を待つ。公式手順 (通知 → `cancelled` stopReason) を第一経路とし、grace (5 秒) 超過と全体 timeout でのみ kill する。prompt 応答の `cancelled` は Done ではなく Cancelled として扱う。
5. 正常終了時に process を残す / stdin close で終了させる。公式 transport 図どおり stdin close を終了合図とし、5 秒待って残れば kill して必ず reap する。

## 決定

- 送受信は NDJSON (compact JSON + `\n`) のみ。受信は断片化・結合・UTF-8 途中分割・CRLF・空行 skip・8 MiB 上限・不正行の明示 error を実装し、mock agent は lib と独立に記述した実装で検証する。
- initialize は `protocolVersion: 1`、`clientCapabilities: {}`、`clientInfo: {marxen}` を送り、応答 version が 1 以外なら `unsupported_protocol` で接続を閉じる (wire に追加)。
- Codex preset は引数なし `codex-acp`、OpenCode preset は `opencode acp` (公式どおり)。preset 固定 argv の上書きは引き続き拒否する。
- `session/new` は cwd (staging 解決パス) + `mcpServers: []`。応答 ID 照合は厳密に行い、割り込み通知は捨てずに振り分け、未知応答 ID は error とする。再開 ID は従来どおり未知扱い (`UnknownSession`)。
- prompt 応答は stopReason で振り分ける。取消送信後の `end_turn` 等も Cancelled とし、提案の取り違えを防ぐ。prompt 待機は 500 ms poll で区切り、無言のエージェントに対する取消遅延を上限 500 ms にする。
- `agent_handshake` (initialize + session/new + graceful shutdown、prompt なし) を live 接続テストと実機 demo の共通経路にする。

## 結果・制約

- 実機 demo: 手元 OpenCode v2.0.24 (npm 版 `opencode.exe`) と protocol 1 / session `ses_ee92d2f62ffenjt7T6aKw5zXv2` / 通知 0 件で成功。prompt は送っていない (無償・認証不要の範囲)。WinGet 版 `opencode.exe` は起動直後に `Database is not empty and has no session table` で終了する利用者環境固有の状態であり、Marxen の問題ではない。`codex-acp` は未導入のため missing-binary 経路 (自動取得なし) をテストした。
- tool 呼び出し通知の個別表示、elicitation / fs / terminal の実装、session/load・resume・close、subagent 等の拡張は v1 の範囲外である。
- AI パネルは `App.tsx` に組み込まず、Codex 側の表示文言のみ `codex-acp` に更新した。

## 確認方法

- `cargo test` (両 feature): unit 25 + AI integration 19 (mock subprocess 11 件相当、mock HTTP 5 件、resolver 等) + 文書契約 11 が成功。mock は NDJSON を独立実装し、fragment (1〜3 byte 刻み・UTF-8 途中含む) / coalesce / 巨大行 / 早期通知の ID 照合 / 権限拒否の optionId 検証 (`permission.json`) / 通知取消と clean exit (`clean_exit`) / kill 取消を検証する。
- 実機 handshake は `MARXEN_REAL_ACP_BIN` / `MARXEN_REAL_ACP_ARGS` 指定時のみ実行し、未指定時は skip する。CI では常に skip される。
- `npm run typecheck`、Vitest 22 件、`ai-contracts:check`、`contracts:check`、`cargo fmt --check`、`cargo clippy -- -D warnings` が成功。
- 実 WebView / IME、macOS / Linux native、署名 / 配布は未実施であり、成功と記載しない。
