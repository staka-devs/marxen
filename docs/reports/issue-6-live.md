# Issue #6 inline live と描画隔離の検証報告

- 日付: 2026-10-08
- 実装範囲: TypeScript / React の描画と編集器。Rust・IPC 契約は変更しない。

## 仕様

- 行内現示 `src/components/editor/livePreview.ts`: StateField が共有 AST 行範囲（`src/lib/render/blocks.ts`、UTF-16 偏移）を置換装飾にし、選択のない区だけ部品描画、選択区は原文のままにする。`livePreview` 属性は既定で無効。部品は `.cm-content` 内にだけ置き、編集器の下に閲覧を積まない。
- 部品操作は既存範囲編集に流す。検査箱は直接切替え、表ます目は原文範囲を選択、リンクや画像や脚注は原文位置へカーソルを移す。部品内に文字入力を置かない。脚注定義は常に原文編集。
- 隔離: id / name に `marxen-` 接頭辞を付け、本文内 `#断片` を接頭辞先へ付け替える（脚注往復と利用者錨を保つ）。`href` の `data:`・`vbscript:`・`javascript:` を拒み、画像 `src` の `data:` だけ残す。MathJax 出力の実行連結子を消毒後に除き、Mermaid SVG は script・事象属性・実行連結子を除いて貼る。代理対の前後境界を編集範囲に含める。
- 水和の寿命: AbortSignal で中断後の DOM 書込みを止め（中断済みは導入読込前に同期復帰）、地図は `remove`、Three.js は描画器・形状・材質を破棄する。閲覧と部品の破棄時に呼ぶ。古い描画と古い水和は捨てる。
- 相対画像は原文のまま残し、共通呼び出し `(src, signal) => Promise<string | null>` で表示用取得だけ後付けする（UI 側が文書単位の Rust 読込器を裏に置く契約）。非 ASCII 参照は復号して渡し、戻り値は bytes 系と自前系だけ受け付ける。
- 外部 cursor は `{anchor, head, seq}` の連番照合で受け、改訂一致でも座標が変われば適用する。同一連番の再送は捨てる。
- 判断は `docs/adr/ADR-0060-共通ASTでGFMと数式と地図と3Dをローカル描画する.md`、`ADR-0061-エディタ内にWYSIWYGのライブ描画を置く.md`、`ADR-0062-描画の隔離と水和の寿命を正す.md` に記録した。

## 検証結果

環境は Windows x64、Node 22.23.2、npm 11.17.0、Chromium（Playwright 1.63.0）。

| 検証 | 結果と根拠 |
| --- | --- |
| `./node_modules/.bin/tsc --noEmit` | 成功 |
| `./node_modules/.bin/vitest run` | 成功 141 件。消毒・断片・実行連結子・SVG 検査・画像判定と復号と許可系・表ます目対応・代理対前後境界（絵文字回帰）・中断解決・重複区の偏移を含む |
| 本番 E2E（`npm run test:e2e:product`、製品 build＋preview） | 成功 10 件（foundation 3、editor 5、rendering 2） |
| 現示 E2E（`npm run test:e2e:live`、開発 harness） | 成功 11 件。部品配置・単一編集器・現示区のみ原文・検査箱と表の範囲編集と隣接保存・挿入前後の重複部品の偏移・重複表の単独現示・移動水和の破棄・画像置換と遅着破棄・古い結果破棄・不正 containment・連番 cursor・脚注跳躍・悪性 id |
| `npm run test:e2e`（本番→現示の順） | 成功。両構成に到達することを確認 |
| `npm run build` | 成功。chunk 肥大の警告のみ。`dist` に harness 参照なし・CDN 参照なし（`live.html`、`harness`、`https://cdn.`、`unpkg`、`openstreetmap` を走査して該当なし） |

## 未実施・制約

- Windows WebView2、macOS WKWebView、Linux WebKitGTK における実表示と IME の確認は未実施。Chromium の成功から推定しない。
- macOS / Linux の native compile・package 操作、署名 / 公証は未実施。
- 地図は外部タイルを使わないベクタのみ表示。バイナリ STL、数式の編集支援は対象外。
- harness（`tests/live/`）は開発専用で配布物に載らない。
