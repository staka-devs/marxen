# Issue #6 描画基盤（GFM・数式・地図・3D）検証報告

- 日付: 2026-10-08
- 実装範囲: TypeScript / React の描画と編集器。Rust・IPC 契約は変更しない。

## 仕様

- 共通描画器 `src/lib/render/`: remark-parse、remark-gfm（表・タスク・取消線・自動リンク・脚注）、remark-math、remark-github-blockquote-alert（5 Alerts）、remark-rehype、rehype-raw、rehype-sanitize（拡張 GitHub 準拠）、rehype-mathjax（SVG 事前描画）、自前の特別ブロック・Shiki・原文範囲の順で処理する。`renderMarkdownDocument` が HTML・diagnostics・blocks（1 始まり行範囲）を返し、ライブ / 閲覧の両方が同じ木と `data-source-*` 範囲を使う。
- ローカル同梱: Shiki（github-light / dark 両テーマ変数、`[data-theme]` 切替）、MathJax（mathjax-full を SVG 化、CDN なし）、Mermaid、Leaflet / topojson-client（外部タイルなしのベクタのみ地図）、Three.js。`vite.config.ts` で `PACKAGE_VERSION` を注入し、mathjax-full の Node 専用 `eval('require')` 経路をブラウザ束から外した。
- 消毒: `javascript:`・`vbscript:`・`data:` 実行連結子・on*・script・iframe を落とし、相対リンク・画像（`data:` 画像含む）・details / summary / kbd / sub / sup / br・Alerts（種別 class と octicon svg / path）・脚注を残す。id / name には `marxen-` 接頭辞を付け、本文内断片を接頭辞先へ付け替える。MathJax / Shiki / 特別ブロックの HTML は消毒後に信頼済みとして生成する。
- 不正入力: mermaid / math / geojson / topojson / stl を原文検証し、不正時は日本語エラーと原文 pre を残し diagnostics に記録する。正しい場合も原文は details に残す。未知言語は強調なし原文表示。描画器は入力文字列を変更しない（全体再シリアライズなし）。
- 水和 `src/components/preview/hydrate.ts`: Mermaid / Leaflet / Three.js を動的 import で拡張し、AbortSignal と破棄（地図 `remove`、描画器・形状・材質破棄）で寿命を管理する。STL は ASCII のみ、3D は静止画の一回描画。
- 見本: `検証/GitHub記法.md` に `tests/fixtures/github-markdown.md` 全文を `?raw` 同梱した。
- 判断は `docs/adr/ADR-0060-共通ASTでGFMと数式と地図と3Dをローカル描画する.md` に記録した。

## 検証結果

環境は Windows x64、Node 22.23.2、npm 11.17.0、Chromium（Playwright 1.63.0）。

| 検証 | 結果と根拠 |
| --- | --- |
| `./node_modules/.bin/tsc --noEmit` | 成功 |
| `./node_modules/.bin/vitest run` | 成功。GFM・5 Alerts・脚注整合・Shiki・MathJax・消毒・断片・不正・原文保持・範囲・表ます目対応・代理対・CDN 無しを含む |
| 本番 E2E（`npm run test:e2e:product`、製品 build＋preview） | 成功 10 件（foundation 3、editor 5、rendering 2）。Mermaid SVG・地図 SVG・STL canvas・mjx-container・Shiki・Alerts・脚注の実描画を確認 |
| 現示 E2E（`npm run test:e2e:live`、開発 harness） | 成功 10 件。部品配置・範囲編集・重複部品の偏移・移動水和の破棄・連番 cursor・脚注・悪性 id |
| `npm run test:e2e`（本番→現示の順） | 成功。両構成に到達することを確認 |
| UI 画像 | `docs/reports/issue-6-rendering/` の 7 画像を E2E で生成し目視した |
| `npm run test:bundling` | 成功 |
| `npm run build` | 成功。chunk 肥大の警告のみ。`dist` に harness・CDN 参照なし |
| `npm run contracts:check` / `cargo test` / `cargo clippy` | 未実施。Rust と共有契約に変更がないため |

## 未実施・制約

- Windows WebView2、macOS WKWebView、Linux WebKitGTK における実表示と IME の確認は未実施。Chromium の成功から推定しない。
- macOS / Linux の native compile・package 操作、署名 / 公証は未実施。
- 地図は外部タイルを使わないベクタのみ表示。バイナリ STL、数式の編集支援は対象外。
- Shiki は全言語文法を遅延 chunk として同梱する（初期読込外、すべて本地）。KaTeX は Mermaid 経由の遅延 chunk としてのみ含まれ、描画には使わない。
- harness（`tests/live/`）は開発専用で配布物に載らない。
