# ADR-0118-Agentチャットの実行可視化と承認後保存

## 状態

採用

## 背景

AIチャットはテキスト回答を手動で隔離・差分適用する画面であり、文書作業を進めるAgentの画面ではなかった。
ACPの実際のツール実行・進行状態・権限要求・変更ファイルがチャットに表示されず、既存文書の編集と新規文書の作成を自然な操作で取り込み・保存できなかった。
適用済みの変更に承認・却下ボタンが残り、最終状態が実際の保存結果を反映せず、内部機構の説明段落とlive/staging識別子が常時表示されていた。
権限要求は無条件承認ではなく実際のIDで返答し、取消は一度だけ確定させる必要があった。
外部ターミナル窓・偽のツール時系列・トークン由来のクレジット推計は禁止であり、APIプロファイルとClaude阻止を保持し、直接APIの能力不足は正直に報告する必要があった。
公式ACP仕様（tool_call/tool_call_update/plan/permission、fs/read_text_file・write_text_file、session/cancel）とOpenCodeの`opencode acp`対応（内蔵ツール・権限系）を一次情報として確認した。

## 決定

- ACPの`session/update`の`tool_call`・`tool_call_update`・`plan`を検証して非終端イベントとして配信し、チャットにツール進捗カードと作業計画カードを表示する。HTTP backendでは偽の時系列を作らない。
- `session/request_permission`をチャットに表面化し、実際のoptionIdで拒否（取消後はcancelled）を返答する。対話的な許可・拒否の選択は将来の`ai_permission_reply`統合とし、今回の対面では自動拒否＋表示に留める。
- クライアント能力として`fs.readTextFile`・`writeTextFile`を申告し、隔離 staging 内に限定して実読み書きする。Askは読取専用として書込を拒否する。terminal系は未対応として外部窓を作らない。
- 隔離に新規Markdown一覧（`staged_new_files`・`isolation_new_files`）を追加し、変更ファイルカードで既存差分と新規を表示する。承認は適用＋保存の単一操作とし、適用後は承認系を引退させ、最終状態を実際の保存・失敗件数で報告する。新規取込のworkspace配線は shell 側の最小追加（`workspaceGateway`受渡）に留め、配線自体は coordinator 所有とする。
- 再現可能な mock（`--agentic-demo`）が計画→読取（直接FS＋`fs/read`）→編集（`fs/write`＋diff）→新規作成（実ファイル＋diff）→権限（拒否で特権書込を省略）→完了の多段階変更を行う。
- AI IPCを version 6、隔離 IPCを version 3 に上げ、生成契約を更新する。

## 影響

- チャットは実際の作業進捗と変更ファイルを示し、質問は読取専用、直接APIは文章のみであることを明示する。
- 承認後保存の単一操作により、Neovim正本・revision束縛・dirty保持を保ちつつ、保存成功・失敗を区別して報告する。
- 権限の対話選択・新規文書の本番取込配線・実接続検証・各OS実WebView/IME確認は未実施であり、root側の統合・手動CI・実機確認に委ねる。
