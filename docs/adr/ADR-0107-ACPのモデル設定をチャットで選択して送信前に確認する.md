# ACP のモデル設定をチャットで選択して送信前に確認する
- 状態: 採用
- 日付: 2026-10-10
- 関連: #22

## 背景
CLI の既定モデルだけに依存すると、利用者がチャットの接続先・モデル・推論強度を把握できない。候補は接続先ごとに異なるため、固定のモデル一覧をアプリが持つ方式は採用しない。

## 選択肢と決定
Agent とインラインチャットに共通の接続先・モデル操作欄を置く。Codex、OpenCode、GitHub Copilot CLI、カスタム ACP、OpenAI 互換 API、独立した Anthropic API を選択できる。Claude Code の起動制約は維持する。

ACP は利用者が候補取得を実行したとき、専用の一時ディレクトリで initialize / session/new を行い、configOptions の model / thought_level の select を表示する。文書や prompt は送らない。グループ化された選択肢も値を保持して扱う。モデル名や候補を推測しない。API は設定済み endpoint を維持してモデル名を直接入力する。

選択値を非秘密設定として保存し、prompt 前にそのセッションが公開した値と照合する。モデルを先に適用し、返された完全な候補一覧で推論強度を検証する。session/set_config_option の返答に選択値が反映されなければ送信を中止する。利用不能な値を別モデルに置き換えない。

## 結果・制約
チャット内にモデルと失敗理由を表示し、設定はフォーカスを保持するダイアログで開く。Windows の ACP 子プロセスは標準入出力の pipe と CREATE_NO_WINDOW を使用する。接続先の CLI は事前インストールと利用者の認証が必要で、アプリは自動ダウンロードやログインを行わない。候補を公開しないエージェントはその旨を表示して CLI の設定を使う。権限要求の拒否、隔離コピー、提案の差分承認、revision 検証を維持する。

## 確認方法
独立した ACP fixture で候補、指定適用、無効値、指定を無視する返答、prompt の順序、Windows の console handle を確認する。両チャットの選択、接続変更後の古い返答の破棄、設定のキーボード操作と画面を確認する。外部サービスの実認証・生成は fixture の成功と区別する。

## 根拠
- [ACP session config options](https://agentclientprotocol.com/protocol/v1/session-config-options)
- [Copilot CLI ACP server](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server)
