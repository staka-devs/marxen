# ADR-0133: 名前付きAPIとACPの実モデル候補を接続先として扱う

- 状態: 採用
- 日付: 2026-10-16
- 関連: #102、#103、#54、#79

## 背景と選択肢

未登録のAPI形式がチャットの接続先として表示され、実際に使える接続先と区別しにくかった。ACPではモデル公開形式の違いや応答待ちが接続失敗の原因になりうる。

## 決定と理由

- チャットの接続先にはACPエージェントと登録済みの名前付きAPIだけを表示する。API形式は「APIを追加」の中で選択する。
- OpenAI Chat Completions、OpenAI Responses、Anthropic Messagesを別の通信形式として扱う。APIルートまたは完全なエンドポイント、モデル、資格情報を接続先ごとに設定する。
- 既存`openai_compatible`保存値はChat Completionsとして維持し、名前・ID・キーを消さない。Responsesは`openai_responses`を使う。
- Responsesは`input`と型付きSSEを使い、`store: false`で必要な履歴だけを送信する。完了イベント前の切断・失敗・不完全な生成を成功扱いしない。
- ACPのモデル取得は有界の初期化・セッション作成で行い、非同期ランタイムを同期処理で塞がない。同じ接続への同時取得をまとめ、一時的な失敗で最後に公開された候補を消さない。
- `configOptions`を優先し、未提供の場合は旧`models`と`session/set_model`を扱う。送信時はそのセッションの候補と設定応答を再確認する。モデルを推測しない。
- Claude Codeは利用者向けの`claude-agent-acp`アダプターとして選択できる。開発でのClaude Code起動・委任・実接続検証の禁止は維持する。

## 制約と確認方法

資格情報はOSストアまたはプロバイダーのローカルログインで管理し、APIを追加しても自動接続・自動認証しない。ACP接続テストには文書もプロンプトも送らない。

独立したACPプロセスfixture、ループバックHTTP/SSE、選択欄と永続化のテストで確認する。実プロバイダーと各OSの資格情報ストアは、このfixture検証から成功を推定しない。

参照: [ACP設定候補](https://agentclientprotocol.com/protocol/v1/session-config-options)、[Claude ACP](https://github.com/agentclientprotocol/claude-agent-acp)、[OpenAI Responses移行](https://developers.openai.com/api/docs/guides/migrate-to-responses)。
