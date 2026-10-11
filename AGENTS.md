# Marxen の作業規約

- ユーザーの計画と最新の指示を優先する。要件と担当は `docs/implementation.md`、GitHub Epic #1 / Issues #2–#9 に記載する。
- 開発の委任は Orca の Issue 単位の子ワークスペースで行い、依存、進捗、完了通知を管理する。
- Codex と OpenCode のみを使用する。Claude Code の起動 / 委任 / 実接続検証は行わない。
- OpenCode は **MuseSpark1.3 Contributor / Xhigh** の実効モデルと設定を確認してから委任する。利用できない場合はその担当を停止して報告する。別モデルへ自動変更しない。
- Anthropic Messages API は独立した利用者設定の接続先として実装できる。
- アプリの仕様・実装・検証方法に関わる持続的な意思決定を AnyDR として記録する。エージェント選定・委任・Orca 操作・復旧・実装途中の経緯や状態は ADR や作業ログに残さない。配置は `docs/adr/`、ファイル名は必ず `ADR-{4桁のゼロ埋め連番}-{意思決定を表す日本語タイトル}.md`。詳しくは `docs/adr/README.md`。
- 実 Neovim のバッファを正本にし、Rust が編集 / 保存 / AI 通信を所有する。GUI と AI は revision 付きの範囲編集を行う。
- 実施した検証と未実施の検証を区別する。各 OS の実 WebView / IME をコンテナやブラウザの成功から推定しない。
