# ADR-0070: AI 接続とプロンプト送信の契約を定める

- 状態: 採用
- 対象: ACP、OpenAI 互換 Chat Completions、Anthropic Messages、AI パネル

## 決定

Rust が AI プロセス、HTTP 通信と資格情報を所有する。AI の型は `ai_contracts.rs` で定義し、TypeScript へ生成する。文書 ID・revision・UTF-16 範囲は文書契約を共有する。

ACP は Codex の `codex-acp`、OpenCode の `opencode acp` と利用者の明示的な argv 設定を扱う。argv 配列で直接起動し、シェルで文字列を展開しない。Claude Code は起動しない。プロトコルは ADR-0071 に従う。

AI に渡す作業ディレクトリは登録済みの隔離コピーに限る。送信対象の本文・範囲・基準 revision を画面に表示し、出力は適用前の提案として扱う。原文への適用はレビューと現在の revision の照合を必須にする。

資格情報は Windows Credential Store、macOS Keychain、Linux Secret Service に保存する。`keyring` の各 OS の機能を明示的に有効化し、保存先が利用できなければエラーを返す。ファイルやメモリを資格情報の代替保存先にしない。Linux は D-Bus が必要で、開発環境には `libdbus-1-dev` を含める。API キーの保存要求以外の応答・進捗・ログへ値を含めない。

Anthropic Messages API は独立した opt-in 接続先とし、OpenAI 互換 API と資格情報を分ける。接続テストは設定確認と、利用者が選んだ実通信を分ける。

## UI と IPC

`ai_credential_state` は資格情報の有無だけを返す。`ai_set_credential` / `ai_delete_credential` は OS ストアを操作する。`ai_test_connection` は接続結果を返す。

`ai_prompt_stream` は実行 ID を返し、`ai-stream` に開始・本文・完了・エラー・取消を通知する。完了時は提案と送信対象を返す。`ai_prompt_cancel` は当該実行だけを取り消す。

## 検証方法

独立した ACP mock とローカル HTTP サーバーで、送信対象、stream、認証エラー、取消、timeout を検証する。OS 資格情報は一意の使い捨てエントリーを別のインスタンスから読み直して永続性を検証し、必ず削除する。実 API・各 OS のストア・実 CLI の確認は mock の成功と区別する。
