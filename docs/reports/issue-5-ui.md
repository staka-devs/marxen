# UI・Vim 操作・範囲編集の検証

環境は Windows x64、Node 22.23.2、Playwright 1.63.0、WebView2 / Edge 154、同梱 Neovim 0.11.5。

細いアクティビティバー、用途を切り替えるサイドバー、コンパクトなタブ、独立した本文スクロールを使う。分割表示は Markdown 編集と描画を左右に配置し、境界のドラッグで幅を調整する。フォルダー名と種類別アイコンを表示し、テキストと対応画像以外のファイルを一覧から除く。外観・エディター・Vim・コピー・AI の設定を分ける。

| 検証 | 結果 |
| --- | --- |
| 模擬 IPC の回帰 | 入力順、遅延応答、ユーザーマッピング優先、選択置換、revision 競合、貼り付けの単一性、画像、AI 適用結果を確認 |
| 製品・ライブ E2E | 表示切替、幅の変更、狭い画面、テーマ、カーソル、操作メニュー、文書保持、Composition の確定・取消を確認 |
| Windows 実アプリ | フォルダー読込、Markdown 描画、保存、Neovim Undo、.vimrc 設定と再起動を確認 |
| 実マッピング | nnoremap <F6> gg を読み込み、Windows SendKeys の F6 で 15:1→1:1、revision 不変 |
| Windows 実 IME | Markdown / ライブで未確定・変換中は文書不変。確定で一度だけ revision が進み、一回の Neovim Undo で復元。Esc 取消と Normal モードの IME 入力は文書不変 |
| テキスト・画像 | テキストは Neovim で編集し、Markdown 表示操作を無効化。画像は文書 buffer を作らず専用タブで表示、フィット・実サイズ・125% 拡大を確認 |
| 画像ドラッグ | 内部画像の相対リンク挿入、Windows OLE FileDrop による外部 PNG のコピーと一回の挿入を確認。読み戻した文書と画像ハッシュを照合し、一回の Undo で文書復元 |
| Windows 実クリップボード | 日本語・絵文字と PNG の貼り付けを確認。本文は一度だけ編集され、Undo・保存後のハッシュが元と一致。検証後にクリップボードを復元 |
| Windows Word | 通常の貼り付けで二つの PNG、見出し、表、日本語・絵文字を保持。HTML / RTF にも二つの画像が存在 |

Windows のキーとドラッグは OS への合成入力であり、文書・revision・ファイルの読み戻しで効果を判定した。ブラウザの Composition テストは別の検証として扱う。

[1493×1047](issue-5-ui/clean-1493.png)、[1280×800](issue-5-ui/clean-1280.png)、[分割](issue-5-ui/split.png)、[設定](issue-5-ui/settings-dark.png) は製品 E2E の画像。

最終件数と展開した配布アプリの確認は [統合検証報告](issue-9-integration.md) を参照する。メールアプリへの画像入り貼り付け、macOS / Linux の実 WebView / IME、認証済み AI 生成は未確認。
