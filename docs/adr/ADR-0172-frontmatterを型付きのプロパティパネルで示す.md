# ADR-0172-frontmatterを型付きのプロパティパネルで示す

- 状態: 採用
- 日付: 2026-11-23
- 関連: ADR-0165（プロパティ表）を補う

## 決定

- frontmatter は「プロパティ」という見出しの付いた枠で表示し、本文と区別する。
- 値の形から型を決め、型のアイコンと編集方法を変える（`propertyType`）。
  - `true` / `false`: チェックボックス。切り替えると `true` / `false` を書き込む。
  - `YYYY-MM-DD`: 日付入力。
  - `[a, b]` と `- a` の並び: チップで表示する。読み取り専用で、クリックすると Vim でその値の位置へ移動する。
  - 数値と文字列: 従来どおり入力欄。
- カーソルが frontmatter に入り生の YAML を編集するときも、全編集モードで YAML の行に背景を付け、キーを強調する（`frontmatterLines`）。
- 値の変更はすべて従来どおり、値の範囲だけを置き換える revision 付きの範囲編集として送る。

## 確認方法

- `npx vitest run src/domain/frontmatter.test.ts src/domain/render/pipeline.test.ts`。
- `tests/live/harness/editor.html` で、チェックボックスの切り替えが `done: true` として本文に入ることを確認した。
- 実アプリの日付入力の見た目と IME 入力は未確認。
