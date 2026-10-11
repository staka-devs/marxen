# WindowsのACP実行をシェルなしで解決する
- 状態: 採用
- 日付: 2026-10-11
- 関連: #54

## 背景
Windows では公式アダプターが npm の `.cmd` / `.ps1` シムで配布される。ファイルの存在だけでは直接起動可能か判断できない。接続テストと会話の起動に同じ解決方法を用いる必要がある。OpenCode v2 は `opencode acp` で ACP v1 を扱い、Codex の公式アダプターは `@agentclientprotocol/codex-acp` の `codex-acp` である。

## 選択肢と決定
シェルの文字列結合や引数補間は使わない。`PATH` のディレクトリ順を守り、その中の `.com` / `.exe` を `PATHEXT` 順で優先する。公式 npm シムは同梱配置から解決する。`opencode` は `node_modules/@opencode/cli/bin/opencode.exe`、`codex-acp` は Node.js と `node_modules/@agentclientprotocol/codex-acp/dist/index.js` に解決する。未知のシムは実行せず、直接実行可能なコマンドの指定を案内する。自動導入は行わない。ACP の認証エラーコードと明示的な認証失敗メッセージは認証エラーとして扱う。v1 以外は版番号付きで未対応を返す。モデルの選択には公開された `configOptions` の `model` / `thought_level` を用いる。

## 結果・制約
欠落・認証・未対応プロトコルを区別して案内する。子プロセスは解決した `program` と配列 `args` で起動し、`CREATE_NO_WINDOW` と隔離した `cwd` を維持する。空白を含むパスも引数配列で扱う。接続は利用者が設定済みの認証情報を用い、認証やアカウント変更を自動実行しない。

## 確認方法
単体テストではシム解決、空白を含むパス、欠落、認証分類、設定候補の解析を検証する。Windows のシムを扱うテストは Windows で実施する。実接続は隔離した一時ディレクトリから `initialize` / `session/new` を行い、プロトコルと公開設定を確認する。設定候補の取得、実際の会話、各 OS のアプリからの接続を別々に検証する。

## 根拠
- [OpenCode ACP](https://opencode.ai/v2/docs/cli/acp/)
- [codex-acp](https://github.com/agentclientprotocol/codex-acp)
- [ACP session config options](https://agentclientprotocol.com/protocol/v1/session-config-options)
