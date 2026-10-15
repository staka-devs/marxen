# 常設の書式操作と Vim 状態を検証する編集メニュー

- 状態: 採用
- 日付: 2026-10-13
- 関連: Issue #58、[GUI 入力の確定](ADR-0108-GUI入力を同一の文書内容に対して直列に確定する.md)

## 背景と選択肢

書式を追加操作のポップオーバーに置くと、編集時に操作を探す必要がある。WebView 標準メニューの履歴・選択・ショートカットは、文書の正本である Neovim と一致しない。GUI の見えているカーソルだけで Enter の前に空白を追加すると、直前の native 入力や IME の確定と順序が食い違う。

常設のコンパクトな書式ツールバーを採用し、隣に Markdown 改行の保存可能な切替を置く。Markdown の文章の行末で Insert-mode Enter を押した場合だけ、既存の空白を含めて最低 2 個の末尾空白を確保する。実行時の Neovim モード、revision、カーソル、Enter マッピングを直列キューで確認し、空白の範囲編集とそのカーソル報告が完了してから native Enter を送る。Normal/Replace の Enter、選択置換、IME 確定、行途中、空行、コード、構造ブロック、テキスト文書は既存の経路を保持する。

## 決定

編集メニューを右クリックと Menu/Shift+F10 から開く。Rust が revision と native 選択を検証し、実際の native 履歴と clipboard の操作を所有する。操作までに選択または revision が変わった場合は拒否し、古い選択へ再実行しない。active な global/buffer-local マッピングは lhs と実際の rhs の組として表示し、ブラウザのキー表記を提示しない。設定入力欄にはこのメニューを適用しない。

選択時の書式ポップアップは `g:marxen_selection_toolbar=1` の明示的な Vim 設定でのみ有効にする。管理ブロックの GUI もこの変数を保存する。ポップアップの表示ではフォーカスを移さず、キーのマッピングを追加しない。既定は無効で、管理領域外の設定のバイト列と fingerprint の検証を維持する。

表操作は選択セルの原文位置を使い、行の上下・列の左右追加、削除、列の配置を範囲編集で行う。ヘッダーと区切り行を保持し、最後の列の削除は表を削除する。escaped pipe と同じ長さの backtick によるコード区間のセル境界解析を、ライブ表示と編集で共有する。Insert の Tab/Shift+Tab は既存マッピングがない場合にセルへ移動し、表の端では通常の native キー経路へ戻る。文書全体の再シリアライズは行わない。

## 結果・制約と確認

UTF-16 の範囲、古い revision の拒否、GUI commit 内のカーソル順序を維持する。矩形選択と command-line/terminal の clipboard 操作は native メニューの対象外とし、Neovim 画面で扱う。表操作は妥当な最上位の Markdown 表を対象とする。

純粋な文章・セル境界規則、直列キューの revision/cursor/mapping 順序、表示操作・保存設定・翻訳を unit テストで確認する。実 Neovim で Unicode 選択、clipboard port、Undo/Redo、read-only、native mapping と opt-in、GUI cursor 報告後の Enter を確認する。ブラウザで表示幅・操作・IME イベントの維持を確認するが、実 OS WebView と物理 IME の成功を推定しない。
