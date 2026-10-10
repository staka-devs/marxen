# デスクトップ UI の検証

対象ソース: `4e9ffcf`。検証日: 2026-10-10。Windows x64 / WebView2 / 同梱 Neovim 0.11.5。NSIS から展開した配布アプリを使用した。文書、画像、AI 応答は検証専用 fixture。

## 画面と操作

ツリーの階層線とファイル種別アイコン、伸縮できるサイドバー、右端に収まる編集操作を採用した。ライブでは行番号を省き、Markdown / 分割の編集側では設定に応じて表示する。Vim カーソルの輪郭を強め、形をモードに対応させる。

設定は一覧・カテゴリ・検索を持つ。AI 接続をその場で変更でき、Agent・インラインと共通の provider と設定コンポーネントを使う。表示設定の自動保存と Neovim 設定の明示的な適用を区別する。

| 確認 | 結果 |
| --- | --- |
| 編集 | 実 WebView でツリー、タブ、ライブ本文、カーソルを目視確認。水平 overflow なし |
| 分割 | 編集 444.5px / プレビュー 444.5px / separator 5px。本文・revision を維持した左右ペイン |
| 操作メニュー | 右端に配置。Escape・外側クリック、矢印移動、フォーカス復帰を回帰テストで確認 |
| 設定 | 1180 × 800px の WebView 内に 860 × 680px。カテゴリをまたぐ検索、AI フィールド、本文不変を実アプリで確認。文字サイズ保存と provider 同期も回帰で確認 |
| Agent | 実 Rust → ローカル ACP fixture → WebView2 の回答。質問で本文を変更せず、二つの会話を切替して履歴を保持 |
| インライン | 編集領域内に収まり指示欄へフォーカス。回答は本文を変えず差分を提示 |
| 承認・Undo | 最初の見出しだけに承認を適用。残りの本文は完全一致。製品 UI の Undo 一回で実 Neovim と画面を元の本文・保存済みに復元 |
| リッチコピー | WebView のキーイベントから実 Neovim のヤンクと F8 を経由し、OS clipboard に HTML/RTF を生成。Word 16.0 の通常貼付で画像二枚、表、日本語、絵文字を確認。文書を保存せず閉じ、以前の clipboard を復元 |

画面は配布アプリの実 WebView レンダラーから取得し、OS の前面画面キャプチャとは区別する。[通常編集](issue-17-ui/windows-editor.png)、[分割](issue-17-ui/windows-split.png)、[設定](issue-17-ui/windows-settings.png)、[AI 設定](issue-17-ui/windows-settings-ai.png)、[Agent](issue-17-ui/windows-agent.png)、[インライン](issue-17-ui/windows-inline.png)。

## 設計と確認範囲

判断は [ADR-0104](../adr/ADR-0104-検索可能な設定と右端の操作メニュー.md)、検証コマンドは [手動 CI](manual-ci.md)、五層と原則のレビューは [TypeScript](issue-14-frontend-architecture.md) / [Rust](issue-15-backend-architecture.md)、資源・ハッシュは [統合検証](issue-9-integration.md) に記載する。

この版の実 Windows IME・OS キー注入によるショートカットは未確認。前面ウィンドウを確保できず、WebView の成功から推定しない。外部 AI provider の実認証・生成、macOS / Linux の実 WebView / IME、メールアプリへの画像貼付は未確認。
