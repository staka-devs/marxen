# Issue #6 描画基盤（GFM・数式・地図・3D）検証報告

- 日付: 2026-10-08
- ブランチ: staka625/issue-6-rendering
- 実装範囲: TypeScript / React のフロントエンドのみ。Rust 契約・アクター・IPC は変更しない。Issue #4 が Rust IPC 全体を所有するため、新規 Tauri コマンドを追加しない。

## 実装した内容

- 共通描画器 `src/lib/render/`（`pipeline.ts`、`validate.ts`、`sanitize-schema.ts`、`shiki.ts`、`types.ts`）: remark-parse、remark-gfm（表・タスク・取消線・自動リンク・脚注）、remark-math、remark-github-blockquote-alert（5 Alerts）、remark-rehype、rehype-raw、rehype-sanitize（拡張 GitHub 準拠）、rehype-mathjax（SVG 事前描画）、自前の特別ブロック・Shiki・原文範囲の順で処理する。`renderMarkdownDocument` が HTML・diagnostics・blocks（1 始まり行範囲）を返し、ライブ / 閲覧の両方が同じ木と `data-source-*` 範囲を使う。
- ローカル同梱: Shiki（github-light / dark 両テーマ変数、`[data-theme]` 切替）、MathJax（mathjax-full を SVG 化、CDN なし）、Mermaid、Leaflet / topojson-client（外部タイルなしのベクタのみ地図）、Three.js。`vite.config.ts` で `PACKAGE_VERSION` を注入し、mathjax-full の Node 専用 `eval('require')` 経路をブラウザ束から外した。
- 消毒: `javascript:`、on*、script、iframe を落とし、相対リンク・画像・details / summary / kbd / sub / sup / br・Alerts（種別 class と octicon svg / path）・脚注を残す。`clobberPrefix` を空にして `user-content-` 二重付与による脚注リンク断線を止めた。MathJax / Shiki / 特別ブロックの HTML は消毒後に信頼済みとして生成する。
- 不正入力: mermaid / math / geojson / topojson / stl を原文検証し、不正時は日本語エラーと原文 pre を残し diagnostics に記録する。正しい場合も原文は details に残す。未知言語は強調なし原文表示。描画器は入力文字列を変更しない（全体再シリアライズなし）。
- 水和 `src/components/preview/hydrate.ts`: Mermaid / Leaflet / Three.js を動的 import で拡張する。失敗は当該ブロックに留める。STL は ASCII のみ、3D は静止画の一回描画。
- 見本: `検証/GitHub記法.md` に `tests/fixtures/github-markdown.md` 全文を `?raw` 同梱した。不正・ unsafe の短い抜粋は Issue #5 の文言のまま残した。
- 判断は `docs/adr/ADR-0051-共通ASTでGFMと数式と地図と3Dをローカル描画する.md` に記録した。

## ローカル結果

環境は Windows x64、Node 22.23.2、npm 11.17.0、Chromium（Playwright 1.63.0）。

| 検証 | 結果と根拠 |
| --- | --- |
| `./node_modules/.bin/tsc --noEmit` | 成功 |
| `./node_modules/.bin/vitest run` | 成功。12 ファイル 49 件（描画 21 件: GFM・5 Alerts・脚注整合・Shiki・MathJax・消毒・不正・原文保持・範囲・CDN 無し、不正 fixture 実物読み込みを含む） |
| `./node_modules/.bin/playwright test --project chromium` | 成功。10 件（foundation 3、editor 5、rendering 2）。Mermaid SVG・地図 SVG・STL canvas・mjx-container・Shiki・Alerts・脚注の実描画を確認 |
| UI 画像 | 成功。`docs/reports/issue-6-rendering/live-github.png`、`read-github.png`、`alerts.png`、`mermaid-math.png`、`map-3d.png`、`stl.png`、`malformed.png` を E2E で生成し目視した |
| `npm run test:bundling` | 成功。3 tests |
| `npm run build` | 成功。`dist` に CDN 参照なし（`https://cdn.`、`unpkg`、`fonts.`、`openstreetmap` を走査して該当なし）。chunk 肥大の警告のみ |
| `npm run contracts:check` / `cargo test` / `cargo clippy` | 未実施。Rust と `src/shared/contracts.ts` に変更がないため。4 native CI で確認する |

## 未実施・制約

- Windows WebView2、macOS WKWebView、Linux WebKitGTK における MathJax / Mermaid / Leaflet / Three.js の実表示は未実施。Chromium の E2E 成功から推定しない。
- macOS arm64 / x64 と Linux x64 の native compile・package 操作、署名 / 公証は未実施。4 native CI は Issue #2 の workflow を用いる。
- 地図は外部タイルを使わないベクタのみ表示（端末外への取得なし）。バイナリ STL、数式の編集支援は対象外。
- Shiki は全言語文法を遅延 chunk として同梱する（初期読込外、すべて本地）。KaTeX は Mermaid 経由の遅延 chunk としてのみ含まれ、描画には使わない。
- Issue #5 の最小描画（`src/lib/preview.ts`）は残し、UI は新描画器を使う。旧描画器の単体検証は維持する。
