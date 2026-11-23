# ADR-0173-PDFをpandocで書き出し引数を設定で変える

- 状態: 採用
- 日付: 2026-11-23

## 決定

- ファイル → 「PDF に書き出す」で、開いている Markdown を pandoc で PDF にする。保存先は OS の保存ダイアログで選ぶ。
- 変換するのは Neovim バッファの現在の内容で、未保存でも書き出せる。本文は pandoc の標準入力へ渡し、作業フォルダーを文書のフォルダーにして相対パスの画像を解決する。
- 設定「pandoc のパス」（既定 `pandoc`）と「pandoc の引数」（既定 `--pdf-engine=lualatex -V documentclass=ltjsarticle`）で変更できる。引数はシェルの引用規則で分割するが、展開や実行はしない（`splitArguments`）。Marxen は `-o <出力先>` だけを足す。
- 実行できるのはファイル名が `pandoc`（`pandoc.exe`）のプログラムだけに限る。設定経由で任意のコマンドを起動させないため。出力先は絶対パスの `.pdf` に限る。
- pandoc はレジストリのロックを外してから実行する。LaTeX の変換に時間がかかっても他の文書操作を止めない。失敗時は標準エラーの末尾 8 行を通知に出す。
- 変換処理は `PdfConverter` port（application）と `PandocConverter`（infrastructure）に分け、composition root で注入する。

## 確認方法

- `cargo test --features dev-tools --lib application::workspace::pdf`（pandoc 以外の拒否、相対パスと `.pdf` 以外の拒否）。
- `npx vitest run src/domain/pdf-export.test.ts`（引数の分割、既定のファイル名）。
- 実際の pandoc / LaTeX での PDF 生成は未確認。
