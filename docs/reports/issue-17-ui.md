# デスクトップ UI の検証

対象ソース: `8150fa1`。検証日: 2026-10-09。Windows x64 / WebView2 / 同梱 Neovim 0.11.5。生成した NSIS から展開した配布アプリを起動した。実アプリの文書と画像は検証専用のローカル fixture。

## 画面と操作

タブとツリーの行高、アイコン、余白、選択状態、ボタンの密度を統一した。ライブは本文幅を調整し、ステータスバーは通常の編集に必要な情報を示す。Agent のモードと操作は入力欄にまとめ、履歴・新規・閉じる操作はヘッダーに置く。接続設定と完了したレビューは折りたたむ。設定はアプリ全体の中央へ配置する。

実 Windows WebView2 の配布アプリ画面を撮影し、ライブ、左右分割、Agent、インライン、設定を目視確認した。WebView 内の寸法は 1180 × 800、Windows の 125% 表示で撮影したウィンドウは 1493 × 1047。配布物の資源と SHA-256 は [統合検証](issue-9-integration.md) に記載する。

| 確認 | 結果 |
| --- | --- |
| ライブとツリー | フォルダー・ファイル・画像のアイコン、選択行、タブの名前・アイコン・閉じる操作、本文の余白、アクティブ行とブロックカーソルを確認 |
| 分割 | 編集とプレビューの幅は各 453.5px、間に 5px の separator。本文を重ねず左右に表示。独立したスクロールと幅変更操作がある |
| 設定 | 760 × 600px の dialog がアプリ全体の中央。Agent が開いていても中心が変わらない。カテゴリ、数値・選択・チェック操作を確認 |
| Agent | 実 Rust → ローカル ACP fixture → WebView2 の回答。質問で本文を変更しない。二つの会話を作成・切替し、回答履歴を保持。入力欄がパネル下部に収まる |
| ショートカット | Windows 合成キーを WebView の trusted event として観測。Ctrl+i はインラインを開かず、Ctrl+Shift+i はインラインを開く |
| インライン | 編集領域の中、カーソル付近に収まる。入力欄へフォーカスし、Agent を閉じる。回答前後の Rust snapshot は同一 |
| 承認と Undo | UI の承認で最初の見出しだけを変更し、残りの本文は完全一致。製品 UI の「元に戻す」一回で Neovim と画面が元の本文・保存済みへ復元。ディスクを変更しない |
| 完了したレビュー | 結果を折りたたみ、無効な承認操作を表示しない。失敗・rollback の既存回帰を維持 |

画面画像は [Agent](issue-17-ui/windows-agent.png)、[インライン](issue-17-ui/windows-inline.png)、[分割](issue-17-ui/windows-split.png)、[設定](issue-17-ui/windows-settings.png) を参照する。

## 回帰と設計

CI 相当の実行コマンドと最終結果は [手動 CI](manual-ci.md)。`WorkspaceShell.ai-review.test.tsx` は radio から select への操作変更に対応し、範囲・revision・承認・競合・rollback の assertion を維持した。追加の回帰は履歴コントロール・初回の不要な再試行非表示、閉じる操作、完了したレビューの表示を確認する。

新しい dependency や汎用状態管理基盤は追加していない。共通の Button と chat CSS で操作の見た目を共有し、Neovim・保存・AI 通信の所有は Rust のまま。アプリの判断は [ADR-0102](../adr/ADR-0102-編集画面とチャットの操作密度を統一する.md)。厳密な Clean Architecture / SOLID の未達箇所は [フロントエンド](issue-14-frontend-architecture.md) / [Rust](issue-15-backend-architecture.md) に記載する。

## 確認範囲

デスクトップの操作確認は実 Windows WebView2 を使った。AI は fixture による回答であり、認証済みの外部 provider の生成結果ではない。今回の実 IME・Word 貼り付けの再検証、macOS / Linux の実 WebView / IME は未実施。過去の IME・コピー検証とは [統合検証](issue-9-integration.md) で区別する。
