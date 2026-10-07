# 作業ログ

## 2026-10-07 Orca 中断後の復旧

- Orca 1.4.221 のアプリ・runtime・graph が稼働し、CLI 接続できることを確認した。sandbox 内では CLI が PATH に見つからず、管理ディレクトリへのアクセスも拒否されたため、承認された権限で確認した。
- 既存 Run `run_6a5494594710` と Issue #2–#8 のタスク・依存関係を保持した。Issue #2 の前 Dispatch `ctx_045947f5f7ed` は実行ホストが `exited` と記録しており、子ワークスペースの実装ファイルは残っていた。
- Orca の履歴検索で得た Codex セッション `01a11347-f874-7df2-83fe-9ee6ff8df978` を、既存の `issue-2-foundation` 子ワークスペースで `resume` した。新端末は `term_e178de48-4210-4a2f-b42f-7c887ceca074`。
- 前 Dispatch が failed、Task が ready だったため、最初の `--retry-of` は拒否された。最新 Dispatch の終了を再確認し、Task に中断を記録した後、同じ Task を新 Dispatch `ctx_7c27929f3352` に再接続した。Orca の受付結果で `turn_started`、稼働確認で `live` / `working` を確認した。
- 最新 AGENTS.md・実装契約・AnyDR 規約を読むこと、既存変更を保持すること、古い Dispatch の権限を使わないこと、残りの検証・コミット・報告を行うことを担当へ通知した。前の検証結果の履歴と、今回実際に検証した結果を区別するよう伝えた。
- Claude Code は起動・委任・実接続検証していない。OpenCode の後続タスクは未着手。設定ファイルには指定モデルがあるが、今回その実効モデル・Xhigh の検証や新規委任は行っていない。
- 今回の確認対象は復旧と作業再開。アプリの機能完了、E2E、各 OS の実 WebView / IME の成功をこの記録から判断しない。既存ユーザー変更（AGENTS.md、ADR README、opencode.jsonc）は保持した。
- 最終の端末確認では、再開した担当が README・AnyDR・基盤検証報告の書き込み承認で待機していた。子ワークスペースはこのセッションの writable root 外にある。確認画面はユーザーの承認が必要であり、coordinator から代理で承認入力は送っていない。

## 2026-10-07 継続実装の再開

- Issue #2 は worker_done とコミット `26acc9c` により完了。開発ブランチへ `dc36c83` として統合した。.gitignore の競合は双方の除外設定を保持して解決した。
- Issue #3 の Codex と Issue #7 の OpenCode を、既存 Run 内の Issue 別子ワークスペースへ並行委任した。後続 Issue #9 の最終統合タスクも依存付きで登録した。
- OpenCode のプロジェクト build 設定と起動 TUI で、実効 MuseSpark1.3 Contributor / OpenCode Go / Xhigh を確認してから委任した。一般 CLI のモデル一覧は Orca 管理アカウントの一覧と異なった。
- OpenCode の管理サービスは既存ポート 49374 が使用中だった。同じ端末で `opencode --standalone` を起動し、作業開始を端末出力で確認した。既存サービスや他作業のプロセスは終了していない。
- Codex の sandbox helper 起動失敗には、前回成功した full PowerShell -Command / require_escalated の呼出構文を伝達した。誤ってエスケープされたコマンドの確認を取消して同じ Dispatch を継続した。代理で承認入力は送っていない。
- ユーザーの最新指示に従い、Orca 操作は既存の許可範囲で継続し、sandbox の Orca 実行許可は継続適用できるカテゴリとして要求した。

## 2026-10-07 実装の引き継ぎと ACP 相互運用レビュー

- Issue #3 の Codex は Dispatch `ctx_01ec32aa5b39` の failed worker_done で、変更なしの `dc36c83` checkout を引き継いだ。sandbox helper 1223 と反復する承認待ちにより実装・検証は未実施。worker-release は user_takeover / retained と判定し、旧端末は強制終了しなかった。
- 同じ Run・Task・Issue #3 子ワークスペースで `opencode --standalone` を起動した。新端末 `term_6213fa46-2da6-4ce6-80dd-10dc618b0e43` の TUI は `Build · Muse Spark 1.3 Contributor OpenCode Go · xhigh`。旧 Dispatch を指定した retry `ctx_ab8426ea04f4` を受け付け、heartbeat と実ファイルの編集開始を確認した。担当変更は ADR-0016 に記録した。
- Issue #7 の初回実装は commit `11a2b0ba45bff33ddc98c90c2a3c92a196333dc4`、worker_done `msg_8f93676b6389`。報告された 43 Rust / 21 Vitest / build / Playwright の成功はモック中心であり、ACP 実接続・UI 統合・隔離 resolver の接続完了を意味しない。
- coordinator のレビューで ACP stdio が Content-Length framing になっていること、Codex preset が `codex acp` を想定していること、初期応答の ID 照合とエージェントからの permission request 応答が不足することを確認した。公式 ACP は改行区切り JSON-RPC、Codex は `@agentclientprotocol/codex-acp` adapter を使用する。根拠: https://agentclientprotocol.com/protocol/v1/transports 、https://github.com/agentclientprotocol/codex-acp 、https://opencode.ai/docs/acp/ 。
- 同じ Issue #7 ワークスペース・確認済みモデルの端末に、追加 Task `task_1019ff4090af` / Dispatch `ctx_64843498a2a8` を委任した。独立した NDJSON mock、通知を挟む応答、stderr の上限、プロセス終了、実 OpenCode の initialize / session/new（有料 prompt なし）を検証し、結果を分けて記録させる。修正のレビュー前に全機能完了とは扱わない。
