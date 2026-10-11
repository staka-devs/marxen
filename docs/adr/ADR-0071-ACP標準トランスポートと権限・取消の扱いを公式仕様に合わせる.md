# ADR-0071: ACP 標準トランスポートと権限・取消の扱いを定める

- 状態: 採用
- 対象: ACP stdio 接続

## 決定

[ACP の標準トランスポート](https://agentclientprotocol.com/protocol/v1/transports)に従い、compact UTF-8 JSON-RPC を一行一メッセージで送る。断片化・結合・UTF-8 の途中分割を扱い、不正な行・途中終了・8 MiB を超える行は明示的に失敗させる。

`initialize` で protocol version 1 を照合し、対応しない版は接続を閉じる。要求 ID と応答 ID を厳密に照合し、割り込む通知と要求を別に扱う。

各実行は `initialize` → `session/new` → `session/prompt` とする。実行ごとに新しいセッションを使い、他実行の session ID は受け付けない。作業ディレクトリは登録済み隔離コピーとし、未実装の fs / terminal capability を広告しない。

権限要求には黙って待機せず、拒否 option または `cancelled` outcome を返す。未知の agent 発信要求は method-not-found とする。

取消は `session/cancel` 通知を送り、取消後の応答を提案の完了として扱わない。応答を一定時間待ち、stdin を閉じても終了しなければ process を終了して回収する。stderr は上限を設けて継続的に読み取る。

[Codex ACP adapter](https://github.com/agentclientprotocol/codex-acp)は利用者が導入した `codex-acp` を使い、自動取得しない。[OpenCode](https://opencode.ai/docs/acp/)は `opencode acp` を使う。未導入・起動失敗は利用者に原因を表示する。

## 検証方法

本体と独立した NDJSON mock で ID 照合、通知の割り込み、権限拒否、巨大行、取消と終了を検証する。実 CLI の接続確認は `initialize` と `session/new` までとし、プロンプト送信の検証と分ける。
