# Marxen の作業規約

- ユーザーの計画と最新の指示を優先する。要件は `docs/implementation.md`、GitHub Epic #1 / Issues #2–#9 に記載する。
- アプリの仕様・実装・検証方法に関わる持続的な意思決定を AnyDR として記録する。エージェント選定・委任・実装途中の経緯や状態は ADR や作業ログに残さない。配置は `docs/adr/`、ファイル名は必ず `ADR-{4桁のゼロ埋め連番}-{意思決定を表す日本語タイトル}.md`。詳しくは `docs/adr/README.md`。
- 実 Neovim のバッファを正本にし、Rust が編集 / 保存 / AI 通信を所有する。GUI と AI は revision 付きの範囲編集を行う。
- 実施した検証と未実施の検証を区別する。各 OS の実 WebView / IME をコンテナやブラウザの成功から推定しない。
- 製品コードは `domain`、`application`、`contracts`、`infrastructure`、`presentation` に分ける。`contracts` は副作用のない共有型、`domain` は純粋な規則、`application` はユースケースと利用する port を所有する。外側の具体実装は composition root で注入する。
- `domain` / `application` は OS・Tauri・UI の具体実装を参照しない。`infrastructure` と `presentation` は互いを直接参照しない。旧 namespace の転送で依存を隠さない。
- SOLID、YAGNI、DRY を守り、実際に使う小さい interface と責務分割を採用する。手書きの名前付き関数・メソッド・trait 操作には、公開・非公開を問わず Rustdoc / JSDoc を付ける。匿名 callback と生成物は除く。`npm run architecture:check` で依存とコメントを検査する。
