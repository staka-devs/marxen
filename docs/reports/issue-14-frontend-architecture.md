# フロントエンドの設計レビュー

検証日: 2026-10-09。対象: `src/**`。

Agent とインラインチャットの実行・取消・遅延イベント処理を `lib/ai-run.ts` に共有化し、描画・画像・通信の重複と逆向きの依存を整理した。厳密な Clean Architecture / SOLID の完全準拠とは判定しない。

## 判定と根拠

| 原則 | 判定・根拠 |
| --- | --- |
| Clean Architecture | UI から Tauri の呼出し・購読を `lib/` へ集約。画像の URL 判定・hydrate は `lib/preview-images.ts` に置き、clipboard から component への依存を解消。`WorkspaceShell` が編集や AI 隔離のユースケースも持つため厳密な層分離は未達 |
| YAGNI | 製品が使用しない旧 Markdown renderer と全文書再構築型 `replaceAll` を削除。範囲編集の `replaceEdits` と共通 remark/rehype renderer に統一。実行 hook の未使用操作も除去。将来の provider や単一実装のための port・framework は追加しない |
| DRY | run token・取消要求・確定・stop・busy・unmount を共有。ラベル、mdast text / alert 判定、HTML escape、画像 bytes の変換、プレビュー resolver、非質問の staging intake を単一化。会話履歴・mode・配置・Escape・再取得の差はそれぞれの呼出側に維持 |
| SRP | 描画器・画像処理・実行所有の責務は分離。`WorkspaceShell.tsx` は約2700行で文書、Vim、検索、設定、staging、review を持つため未達 |
| OCP | React component を変更せず共通 renderer の各描画器を利用できる。一方 Shell の操作追加や provider の追加には分岐変更が必要。全面的な拡張閉鎖性は未達 |
| LSP | 継承による置換関係は設けていない。共有 hook の採用で、両 chat の取消・early events・会話切替の既存契約を回帰確認。これだけで全アプリの置換可能性を保証しない |
| ISP | 文書・AI・隔離の IPC 型を分離。共有 run は実際に使う操作に限定。workspace の大きな API 集約や Shell の状態所有は引き続き分割余地あり |
| DIP | components の transport 直接参照と lib→component の import を除去。ただしユースケースが `lib/ai.ts` や `workspaceApi` の具体的 Tauri adapter を参照するため厳密な DIP は未達 |

## 維持する契約

- Rust / 実 Neovim 正本、revision、stale 再同期、UTF-16 の範囲編集、IME、Undo、`:w` の保存経路。
- IPC の early-event queue と runId fencing。staging 待ち・start 待ち・実行中の取消、late handle の破棄、unmount の停止。
- busy 所有を同期的に判定し、古い実行からの解除が新しい実行を止めない。共有 staging slot の相互抑止は Shell が所有。
- Agent の複数会話と履歴、inline の rewrite とカーソル位置、フォーカス復帰、Ctrl+I / Ctrl+Shift+I の共存。
- 画像 hydrate の abort・文書切替・node 再利用・遅延 bytes 拒否。clipboard とプレビューは同じ Rust workspace loader を使用。

## 検証

- `npm run typecheck`: 成功。
- `npm test -- --maxWorkers=4`: 38 ファイル / 236 件成功。既存の送信、取消、遅延開始、unmount、履歴・接続先変更のテストを含む。
- `npm run test:bundling`: 3 件成功。
- `npm run build`: 成功。
- 不使用 renderer の専用テストは削除した。製品 renderer の GFM、HTML sanitize、壊れた入力の検証は `render/pipeline.test.ts` で維持。
- 実 WebView / OS IME の結果、全 E2E・Rust・package の結果は [統合検証](issue-9-integration.md) と手動 CI の報告を参照。ブラウザ・jsdom の成功を実 WebView の成功に代用しない。

## 残る設計上の制約

Shell の分割は、文書 generation、カーソル、画像貼付、AI staging の所有境界を定めてから行う必要がある。行数だけを減らす移動や、具体的な第二実装のない DI framework は導入しない。現在の具体依存は隠さず、仕様追加で変更が広がる箇所として評価する。
