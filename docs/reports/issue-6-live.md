# Issue #6  inline live と描画隔離の検証報告

- 日付: 2026-10-08
- ブランチ: staka625/issue-6-rendering
- 実装範囲: TypeScript / React のみ。shell / document-client・Rust 契約・IPC は変更しない（UI 担当と競合させない）。

## 実装した内容

- 行内現示 `src/components/editor/livePreview.ts`: StateField が共有 AST 行範囲（`src/lib/render/blocks.ts`、UTF-16 偏移）を置換装飾にし、選択のない区だけ部品描画、選択区は原文のままにする。`livePreview` 属性（既定で無効）を CodeMirror 区画に足し、根の live だけ有効にする配線は UI 担当に残す。
- 部品操作は既存範囲編集に流す。検査箱は直接切替え、表ます目は原文範囲を選択、リンクや画像や脚注は原文位置へカーソルを移す。部品内に文字入力を置かない。脚注定義は常に原文編集。
- 隔離の修正: id / name に `marxen-` 接頭辞を戻し、本文内 `#断片` を接頭辞先へ付け替え（脚注往復と利用者錨を保つ）。`href` の `data:`・`vbscript:`・`javascript:` を拒み、画像 `src` の `data:` だけ残す。MathJax 出力の実行連結子を消毒後に除き、Mermaid SVG は script・事象属性・実行連結子を除いて貼る。代理対の前後境界を編集範囲に含める。
- 水和の寿命: AbortSignal で中断後の DOM 書込みを止め、地図は `remove`、Three.js は描画器・形状・材質を破棄する。閲覧と部品の破棄時に呼ぶ。古い描画と古い水和は捨てる。
- 判断は `docs/adr/ADR-0060-共通ASTでGFMと数式と地図と3Dをローカル描画する.md`（0051 から改名、0060-0069 を描画に予約）、`ADR-0061-エディタ内にWYSIWYGのライブ描画を置く.md`、`ADR-0062-描画の隔離と水和の寿命を正す.md` に記録した。
- 契約の確認（UI 担当への回答）: `livePreview` は論理値の選択枝で既定は無効、根だけが live を有効にする。`ExternalCursor` は `{anchor, head, seq}` の連番照合で受け、改訂一致でも座標が変われば適用する。部品は `.cm-content` 内の StateField 置換装飾であり、編集器の下に閲覧を積まない。

## ローカル結果

環境は Windows x64、Node 22.23.2、npm 11.17.0、Chromium（Playwright 1.63.0）。

| 検証 | 結果と根拠 |
| --- | --- |
| `./node_modules/.bin/tsc --noEmit` | 成功 |
| `./node_modules/.bin/vitest run` | 成功。消毒・断片・実行連結子・SVG 検査・表ます目対応・代理対前後境界（絵文字回帰）・中断解決を含む |
| `./node_modules/.bin/playwright test --project chromium` | 成功。16 件（foundation 3、editor 5、rendering 2、live-widgets 6）。部品 6 件（`.cm-content` 内の部品・単一編集器・閲覧なし・現示区のみ原文・検査箱と表の範囲編集と隣接保存・古い結果破棄・不正 containment・脚注跳躍・悪性 id）を含む |
| `npm run build` | 成功。chunk 肥大の警告のみ。`dist` に CDN 参照なし（`https://cdn.`、`unpkg`、`fonts.`、`openstreetmap` を走査して該当なし） |

## 未実施・制約

- 根（shell）の live 配線は UI 担当の持分で、本実装に含めない。harness は開発専用で配布物に載らない。
- 各 OS の実 WebView での部品表示と IME、表ます目操作中の確定の実機確認は未実施。Chromium の成功から推定しない。
- 表ます目の直接入力は置かない方針に替えた（編集器の焦点と選択の奪い合いを避ける）。署名後の配布物での再確認は 4 native CI に任せる。
