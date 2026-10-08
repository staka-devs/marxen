# AI 接続とチャットの検証

Windows x64 / MSVC、実 WebView2、同梱 Neovim 0.11.5 で確認した。

| 検証 | 結果 |
| --- | --- |
| Rust AI 統合テスト | 21 件成功。ローカル SSE、独立 ACP 子プロセス、会話履歴、取消、無応答サーバー、timeout、巨大行、権限拒否、接続失敗 |
| Windows Credential Store | opt-in テストで専用 entry を保存、別インスタンスから取得、削除。利用者の API 資格情報は不使用 |
| OpenCode v2.0.24 の接続確認 | initialize / session/new 成功。生成プロンプトは未送信 |
| Windows Agent チャット | 実 Rust → ACP fixture → WebView2 の回答を確認。非表示・再表示、会話新規作成・切替で履歴を保持し、質問は文書を変更しない |
| Windows インラインチャット | 編集位置の近くに開き、Agent パネルは閉じたまま。提案の差分確認、選択範囲だけの適用、一回の Undo、本文へのフォーカス復帰を確認 |
| Windows 取消 | 応答途中の取消が完了し、提案を作らず文書を保持 |
| フロントエンド回帰 | 早着イベント、遅延した実行 ID、重複終端イベント、送信と取消の競合、接続先ごとの履歴分離、完了会話だけの履歴送信を確認 |

ACP は要求ごとに新規 session を作り、完了した会話をプロンプトへ含める。ACP の永続 session 再開は提供しない。選択範囲の context はその抜粋だけを送り、Rust が Neovim の文書と照合する。

実 CLI の接続テストは MARXEN_REAL_ACP_BIN / MARXEN_REAL_ACP_ARGS 指定時だけ実行する。既定の成功は実 provider による生成の成功を意味しない。GUI の生成・適用検証もローカル fixture を使用した。

認証済み provider への生成要求、macOS / Linux の OS ストアと実 WebView 操作は未確認。全体の最終結果は [統合検証報告](issue-9-integration.md) を参照する。
