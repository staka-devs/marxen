# ADR-0001: 実Neovimのバッファを文書の正本とする

- 状態: 採用（IME と表示座標の実機検証は技術検証 Issue #3 で追跡）
- 日付: 2026-10-07
- 関連: Issue #1, #3, #5

## 背景

GUI による Markdown 範囲編集とユーザーの Vim mapping、text object、macro、Undo を共存させる必要がある。ブラウザ側の Vim エミュレーションでは実 Neovim の設定と操作体系を再現できない。

## 決定

同梱した実 Neovim を embed RPC で起動し、Neovim バッファを文書の正本とする。CodeMirror 6 はスナップショットを表示し、範囲編集を Rust へ送信する。ライブ、原文、閲覧と分割表示は同じ文書 ID を参照し、モード切替でバッファや Undo 履歴を作り直さない。

既定は専用設定と原文基準の Vim 操作とする。利用者が選んだ vimrc / _vimrc / init.vim / init.lua は明示的に読み込み、設定エラーを表示する。画面座標に依存する plugin は Neovim 原文 UI で扱う。表示基準の移動はユーザー mapping を優先し、単語、text object、macro は原文基準を維持する。

## 結果

実 Neovim を各 OS の配布物へ含める必要がある。日本語 IME、絵文字、mapping、表示座標、GUI 編集と Vim Undo の共存を先に検証する。未検証の OS / WebView の挙動は検証済みと記載しない。
