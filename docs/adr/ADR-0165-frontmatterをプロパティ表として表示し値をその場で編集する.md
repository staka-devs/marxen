# ADR-0165-frontmatterをプロパティ表として表示し値をその場で編集する

- 状態: 採用
- 日付: 2026-11-10

## 決定

- 文書先頭の YAML frontmatter（`---` で囲んだ部分）を、ライブプレビューと読み取り表示でプロパティ表として描画する。従来は区切り線と見出しとして誤って描画されていた。
- 解析の前に frontmatter を同じ長さの空白で置き換える（`maskFrontmatter`）。改行は残すので、ブロックの UTF-16 位置と行番号は変わらない。
- 平らな `key: value` の値は、ライブプレビューで入力欄になる。確定（Enter、フォーカス外し）すると、その値の範囲だけを置き換える revision 付きの GUI 範囲編集として送る。必要なときだけ YAML の引用符で囲む。Escape で元に戻す。
- リストや入れ子の値は読み取り専用で表示する。カーソルが frontmatter に入ると、従来どおり生の YAML として Vim で編集できる。
- database ブロックのフォルダー表示（ADR-0163）と同じく、平らなプロパティだけを扱う。

## 確認方法

- `npx vitest run src/domain/frontmatter.test.ts src/domain/render/pipeline.test.ts src/presentation/editor/liveTypography.test.tsx`。
- 実アプリでの見た目、IME 入力中の挙動は未確認。
