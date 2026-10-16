# ADR-0131: Vim設定を全文テキストと実Neovimの入力表示に統一する

- 状態: 採用（[ADR-0113](ADR-0113-設定画面からvimrcの管理ブロックを編集する.md)を置換）
- 日付: 2026-10-16
- 関連: #102、#55、#70

## 背景と選択肢

GUIで管理ブロックを再生成すると、Vimscriptの関数や通常の`noremap`がGUIの制限と混同される。設定ファイルの保存と適用が別経路で、新規文書が孤立設定に戻っていた。アプリ独自のキー横取りも利用者のマッピングを妨げていた。

構造化GUIを拡張する案と、設定全文を実Neovimへ渡す案を比較し、後者を採用する。

## 決定

- Vim設定は全文テキストで編集し、指紋を使った競合検出を維持する。既存管理ブロックを自動変換・削除しない。
- 保存後は既存の文書へ適用する。選択した設定パスをRustが保持し、新規文書と再起動後にも使用する。専用vimrcを既定とし、利用者のグローバル設定を勝手に上書きしない。
- Space Leaderは`let mapleader = " "`に相当する実文字を既定とし、利用者設定で変更できる。`noremap`、関数、Luaは独自解析器で実行せず実Neovimで解釈する。
- `ext_cmdline` / `ext_messages`の実イベントを使い、Ex・検索・関数定義の入力とカーソル、出力、エラーを共通画面に表示する。
- エディターでのキー入力はNeovimへ渡す。Ctrl / CmdとShiftを区別し、利用者マッピングをアプリ既定より優先する。
- `:Marxen {command-id}`で既存のアプリ操作を呼び出せる。既存コマンドの可否・所有権検証を共通で使う。

## 結果と確認方法

例:

```vim
let mapleader = " "
function! MarxenSave()
  Marxen file-save
endfunction
noremap <Leader>w :call MarxenSave()<CR>
nnoremap <Leader>a <Cmd>Marxen palette-ai<CR>
```

設定適用時は本文とrevisionを保持し、NeovimのUndoとモードを初期化する。画面依存プラグインの独自UIはNeovim画面を使用する。実Neovimの一文字ごとの入力、関数・Leader・マッピング優先、設定パスの再読込と、表示・キューの単体検証で確認する。実OSのIME確認は別途必要。
