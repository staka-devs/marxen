# UIとGUI範囲編集をNeovim正本で実装する

- 状態: 採用
- 日付: 2026-10-07
- 関連 Issue: #5

## 背景・選択肢

日本語の VSCode 風操作（tree、tabs、quick open、全文検索、outline、command palette、テーマ）と、ライブ / 原文 / 閲覧 / 分割での cursor / scroll 維持が必要になった。GUI からの表・チェック・装飾・リンク・画像編集を全体再シリアライズなしに実 Neovim へ送る方法と、画面依存プラグインの扱い、IME 未確定文の扱いを決める必要があった。CodeMirror 側で Vim を再実装する方法と、Neovim を正本として範囲パッチだけを送る方法を比較した。

## 決定と理由

- React / CodeMirror 6 のシェルに tree、tabs、quick open、検索、outline、palette、テーマ、設定画面を日本語で実装し、文書操作を Rust のレジストリへ接続する。
- live / source / read / split は主エディタを維持して scroll / cursor を保つ。分割右は同一 snapshot の第二ビューで独立スクロールとする。Undo の共有は実 Neovim の履歴に任せ、ブラウザ見本では Undo 成功を表示しない。
- 表・チェック・太字・斜体・取消線・コード・リンク・画像は純粋関数が UTF-16 の範囲だけを返し、デスクトップでのみ `apply_gui_edits` で送る。全体再シリアライズをしない。IPC が無いブラウザ表示は読み取り専用とし、保存成功を模擬しない。
- 表示基準の上下・行頭末・選択は CodeMirror 既定（折り返し考慮）に任せ、自前の上書きをしない。通常モードで IME 確定キーを移動として横取りしない。単語・テキストオブジェクト・マクロなど原文基準操作は実 Neovim が所有する。画面依存プラグインは Neovim 原文ビューで扱い、ブラウザでは正本テキストの読み取り専用表示とする。
- IME は未確定の間は送信を抑止し、確定だけを単一範囲編集として送る。未確定 preedit を正本へ送らない。
- プレビューは共通 AST で GFM・Alerts・脚注・数式・Mermaid・地図・3D を描画する。原文オフセットを保ち、HTML の実行や危険な URL を拒否する。不正な入力でも編集を継続できるようにする。

## 結果・制約・確認方法

- Vitest で範囲編集・UTF-16 境界・改訂・IME 確定・outline・検索・grid 解析・プレビュー消毒を検証する。不正 fixture（`tests/fixtures/malformed-markdown.md`、`unsafe-html.md`）は消毒と編集継続の対象とし、実行しない。Playwright では読み取り専用の表示・無効化・モード維持・原文保持と UI 画像を検証し、保存成功や Neovim 履歴の共有は主張しない。Rust は契約不変と実 Neovim 統合で検証する。
- 各 OS の実 WebView / IME、ネイティブビルド、配布物の操作はそれぞれ確認し、結果と未検証の範囲を検証報告に記載する。
