# ADR-0093: Vim ヤンク後の複数クリップボード方式

- 状態: 採用
- 日付: 2026-10-08
- 関連 Issue: #11 / #9

## 背景と選択肢

ヤンクした Markdown をMarkdown、装飾なし、リッチテキスト、HTML ソースで外部アプリへ渡す。通常の Vim 操作との衝突を減らし、vimrc でキーを変更できる必要がある。`y` に既定マッピングを追加する案はモーション・ユーザーマッピングと衝突するため採用しない。OS clipboard の書き込みは非同期の描画後にも行うため、WebView の一時的なユーザー操作権限に依存する Clipboard API を使わない。

## 決定と理由

- 標準の `yy` / `yw` / `yiw` / Visual の `y` を Neovim にそのまま渡す。`TextYankPost` の operator が `y` のイベントから、改行・Unicode・矩形を含む実際のヤンク内容を取得する。レジスタの内容が変わったかで判定せず、同じ内容の繰り返しヤンクにも対応する。
- ヤンク後の **次の 1 キー** が `<F6>` = Markdown、`<F7>` = 装飾なしテキスト、`<F8>` = リッチテキスト、`<F9>` = HTML ソースの場合にコピーする。待機の時間制限は設けない。別のキー・カーソル操作・本文変更は待機を解除し、通常の Vim に渡す。
- Rust の文書 actor 内で入力と形式選択を直列化する。Neovim の pending input またはユーザーの Normal / buffer マッピングが選択キーを使用する場合は Neovim を優先する。F キーは既定のモーション・演算子と衝突しない。
- `g:marxen_copy_markdown_key`、`g:marxen_copy_text_key`、`g:marxen_copy_rich_key`、`g:marxen_copy_html_key` は Neovim のキー表記を使う。空文字で個別に無効化できる。文字キーに変更する場合は、ヤンク直後のその文字が形式選択になる。
- 装飾なしテキストは共通の Markdown parser と HTML sanitize を通す。コード・数式の内容、表のセル順、タスク状態を保持する。リッチテキストと HTML は共通の描画基盤を使用する。
- 相対画像は文書 ID に対応する Rust の画像 loader で読み込み、HTML の data URI と RTF の `pict` に実データを埋め込む。PNG / JPEG は元の画像を保持し、GIF / WebP は RTF 用に静止 PNG に変換する。画像読み込み失敗はコピーを失敗として表示し、欠落した画像を成功として扱わない。
- Windows は 1 回の native clipboard transaction で画像入り RTF、CF_HTML、Unicode text を公開する。macOS は NSPasteboard の RTF / HTML / text を公開する。Linux は保持した native clipboard に HTML / text を公開する。形式選択は受け取りアプリに委ねる。

## 結果・制約と確認方法

`yy` の後に F8 を押す操作で、テキストと画像を外部アプリへ渡せる。Word / メールアプリごとの対応形式は異なるため、HTML と RTF を提供しても各アプリの実貼り付け検証は別に記録する。外部 URL の画像は HTML の参照を保ち、自動ダウンロードしない。Linux の RTF、GIF / WebP のアニメーション、図の対話操作はコピー対象に含めない。コピー失敗は本文・revision・Vim register を変更しない。

実 Neovim の pending motion・繰り返し・named register・Visual / 矩形・マッピング優先・設定の検証、HTML / RTF の画像埋め込み、入力キューとコピー完了の順序を回帰テストする。各 OS の実クリップボードと外部貼り付けの実施範囲は検証報告へ記載する。
