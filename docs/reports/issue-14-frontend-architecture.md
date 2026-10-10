# フロントエンドの設計レビュー

対象: `src/`。検証日: 2026-10-10。対象コミットとコマンドの結果は [手動 CI](manual-ci.md) に記載する。

製品コードを五つの層に分け、依存の方向と名前付き操作の JSDoc を自動検査する。旧 `lib/`・`components/`・`shared/` namespace に転送用モジュールを置かない。

| 層 | 責務と実装 |
| --- | --- |
| `contracts` | Rust から生成する文書・AI・隔離の共有 IPC 型と外部形式の型宣言。副作用を持たない |
| `domain` | Markdown の解析・描画規則、UTF-16 座標、GUI 範囲編集、会話・選択範囲、設定の正規化。Tauri・React・DOM・具体的 transport を参照しない |
| `application` | [文書 registry](../../src/application/document/registry-client.ts) が文書ごとの直列 queue、実行時 revision、mapping prefix、stale 再取得、Undo・保存の呼出順を所有。AI run と隔離のユースケースが [実際に使う port](../../src/application/ports.ts) を利用する |
| `infrastructure` | Tauri invoke/listen、ネイティブ dialog/drop、clipboard、画像 bytes、ブラウザの非秘密設定を扱う adapter。presentation を参照しない |
| `presentation` | React、CodeMirror、DOM widget、ツリー・タブ・設定・チャット。application port を受け取り、infrastructure を参照しない |

[composition root](../../src/composition.ts) が具体的 adapter を注入する。文書 adapter は `DocumentTransport` を直接満たし、application の registry に渡す。各操作を別の forwarding wrapper に包まない。ブラウザ用 registry は書込みを明示的に拒否する。

## SOLID・YAGNI・DRY

| 原則 | 確認した設計 |
| --- | --- |
| SRP | Shell は画面構成を所有する。React の文書 session、Vim 入力、workspace navigation、画像貼付、AI staging の状態寿命を五つの hook に分けた。revision と直列化は application registry、ネイティブ呼出しは adapter が所有する |
| OCP | UI と use case は注入された port を利用する。接続先の実装変更は composition と adapter に閉じる。新しい provider 種別や新しい表示方式の追加には共有契約と対応する分岐の変更が必要 |
| LSP | 実 transport と試験用 transport は同じ port の revision・取消・エラー契約を使う。stale、early event、遅延開始、会話切替、unmount の回帰で確認する。ブラウザの拒否動作は desktop 書込み成功と区別する |
| ISP | 文書操作と生の document transport、workspace、AI、隔離、runtime、dialog/drop、clipboard、設定・画像の port を責務ごとに分ける。実際に使われない補助型と再 export を置かない |
| DIP | domain/application の外側への依存と infrastructure/presentation 間の直接 import を検査する。concrete singleton は composition から渡し、内側で取得しない |
| YAGNI | 汎用 DI framework、旧 namespace facade、未使用の拡張 port を追加しない。文書や clipboard の実際の振る舞いに必要な境界だけを設ける |
| DRY | Agent とインラインの run fencing・取消・確定、共通 Markdown pipeline、画像 loader、文書 queue を共有する。UI の会話履歴やフォーカスの違いはそれぞれの状態所有者に残す |

## 維持する振る舞い

Rust と実 Neovim を正本にし、GUI は UTF-16 範囲と revision を送る。stale を再取得して画面を同期し、ローカルの履歴で native Undo を代用しない。Agent とインラインは開始前の取消、遅延 run handle、early event、古い run からの通知、busy と staging の所有を保つ。画像 hydrate は文書切替・abort・node 再利用後の遅延 bytes を拒否する。

型検査、依存・コメント検査、40 ファイル / 243 テスト、製品 UI 12 件とライブ編集器 17 件の E2E、production build で確認する。実 WebView と OS IME の結果は [デスクトップ検証](issue-17-ui.md) を参照する。

依存検査は SRP・OCP・LSP の数学的な証明ではない。複雑な workspace と文書操作には複数の協調状態が残るため、変更時は所有境界と取消・revision の契約をレビューする。
