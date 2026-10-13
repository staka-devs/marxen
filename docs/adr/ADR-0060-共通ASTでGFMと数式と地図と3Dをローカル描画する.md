# 共通ASTでGFMと数式と地図と3Dをローカル描画する

- 状態: 採用
- 日付: 2026-10-07
- 関連 Issue: #6

## 背景・選択肢

ライブと閲覧で同じ Markdown を二つの描画器で表示する方法と、remark / rehype の共通構文木と原文範囲を共有する方法を比較した。コード強調・数式・図・地図・3D に CDN を使う方法と、すべて同梱する方法を比較した。不正なブロックを黙って落とす方法と、原文と可視エラーを残す方法を比較した。

## 決定と理由

- `src/domain/render/pipeline.ts` の単一 unified 処理をライブ / 閲覧の両方で使う。remark-parse、remark-gfm（表・タスク・取消線・自動リンク・脚注）、remark-math、remark-github-blockquote-alert（5 Alerts）、remark-rehype、rehype-raw、rehype-sanitize、rehype-mathjax（SVG 事前描画）、自前の特別ブロック・Shiki・Markdown 範囲の順に処理する。`renderMarkdownDocument` が HTML・diagnostics・blocks（1 始まり行範囲）を返す。
- Shiki（github-light / dark 両テーマ変数）、MathJax（mathjax-full を rehype-mathjax が SVG 化）、Mermaid、Leaflet / topojson-client、Three.js を npm 同梱し CDN 参照を出さない。Leaflet は外部タイルを加えずベクタのみの地図にし、端末外への取得を発生させない。Shiki の暗合は `[data-theme="dark"]` で切替える。
- sanitize は GitHub 既定に Alerts（div / p の種別 class と octicon svg / path）と脚注の整合（clobberPrefix を空にして `user-content-` の二重付与を止める）を足す。`javascript:`、on*、script、iframe は落とし、相対リンク・画像・details / summary / kbd / sub / sup / br は残す。MathJax と Shiki と特別ブロックの HTML は消毒後に信頼済みとして生成する。
- mermaid / math / geojson / topojson / stl は原文検証（括弧・波括弧対応、JSON 型、座標の有限数、solid / facet / endsolid、TopoJSON の objects / arcs）を行い、不正時は日本語エラーと原文 pre を残し diagnostics に記録する。正しい場合も原文は details に残す。未知の言語は強調なしの原文表示にする。描画器は入力文字列を変更しない。
- Mermaid / 地図 / 3D は `src/presentation/preview/hydrate.ts` が動的 import で水和する。失敗は当該ブロックの日本語表示に留め他を壊さない。STL は ASCII のみ（バイナリは対象外）、3D は静止画の一回描画とする。

## 結果・制約・確認方法

- Vitest（`src/domain/render/*.test.ts`）で GFM、5 Alerts、脚注リンク整合、Shiki、MathJax、不正・消毒・Markdown 保持・範囲・CDN 無しを検証する。Playwright（`tests/e2e/rendering.spec.ts`）で Chromium の実描画を検証する。画像は `test-results/screenshots/issue-6-rendering/` に出力され追跡対象外とする。`検証/GitHub記法.md` に fixture 全文を `?raw` 同梱した。
- 未実施として残す。各 OS の実 WebView における MathJax / Mermaid / Leaflet / Three.js の表示確認（Chromium の成功から推定しない）。macOS / Linux の native package での同梱量と起動の確認。バイナリ STL、外部タイル地図、数式の編集支援は対象外。
