# Markdown 描画の検証

GFM の表・タスク・取消線・自動リンク・脚注、5 種の Alerts、Shiki の構文強調、MathJax の数式、Mermaid、サニタイズした HTML、GeoJSON / TopoJSON、ASCII STL を共通 AST から描画する。ライブと閲覧は同じ描画基盤を使い、原文を再シリアライズしない。

描画ライブラリはローカルに同梱する。地図は外部タイルを使わないベクタ表示で、STL は ASCII のみ対応する。数式の編集支援とバイナリ STL は対象外。コードの配色はライト・ダーク・ハイコントラストに追従する。

危険な URL、script、iframe、イベント属性を除き、HTML の ID と本文内リンクを隔離する。不正な Mermaid・数式・地図・STL は日本語のエラーと原文を表示する。遅延描画は取消と破棄に対応し、古い DOM 更新、地図、3D 資源を残さない。相対画像は文書ごとの Rust 読み込み経路で解決する。

環境: Windows x64、Node 22.23.2、Playwright 1.63.0。

| 検証 | 実施結果 |
| --- | --- |
| `npm run typecheck` | 成功 |
| `npm test` | 25 ファイル / 185 件成功。描画、サニタイズ、原文範囲、画像、取消、絵文字の境界を含む |
| `npm run test:e2e` | 製品ビルド 11 件、ライブ編集器 15 件成功。Mermaid SVG、地図 SVG、STL canvas、数式、コード、Alerts、脚注、エラー表示を確認 |
| テーマ | ライト・ダーク・ハイコントラストのコード背景と文字色を計算済み CSS で照合し、原文の不変を確認 |
| Windows 実 WebView2・開発アプリ | 表、タスク、Rust コードの強調、NOTE、Mermaid、数式の表示を確認。タスク変更の保存と実 Neovim Undo 後の原文復元も確認 |
| UI 画像 | [ライブ](issue-6-rendering/live-github.png)、[閲覧](issue-6-rendering/read-github.png)、[Alerts](issue-6-rendering/alerts.png)、[数式・Mermaid](issue-6-rendering/mermaid-math.png)、[地図・3D](issue-6-rendering/map-3d.png)、[STL](issue-6-rendering/stl.png)、[不正入力](issue-6-rendering/malformed.png) を製品 E2E で生成 |

Windows 実 WebView2 での地図・3D と OS IME、macOS / Linux の実 WebView・IME、配布後の操作は未確認。ブラウザの成功から推定しない。開発用ハーネスは配布物に含めない。

ライブ固有の検証は [ライブ編集器の検証](issue-6-live.md)、設計は [ADR-0060](../adr/ADR-0060-共通ASTでGFMと数式と地図と3Dをローカル描画する.md) を参照する。
