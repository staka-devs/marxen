# ADR-0144-Altドラッグの矩形選択を矩形Visualにする

- 状態: 採用
- 日付: 2026-10-21
- 関連 Issue: なし（利用者要望）
- 置換元: ADR-0026 の「矩形選択は連続範囲として受け付けない」を部分的に置換

## 背景

マウスで選んだ範囲を Vim の Visual として扱いたい、特に矩形で選んだら矩形 Visual（Ctrl-V）にしたいという要望があった。通常のドラッグは既に文字単位の Visual として実 Neovim に設定されている。

## 検討した選択肢

1. すべてのドラッグを矩形にする。通常の文章選択が使いにくくなるため不採用。
2. Insert 中のドラッグでも Visual に切り替える。要望の主眼ではないため見送り。
3. Alt+ドラッグ（VS Code の列選択と同じ操作）を矩形 Visual にする（採用）。

## 決定と理由

- CodeMirror の `rectangularSelection` と `crosshairCursor` を有効にし、複数範囲は Alt+ドラッグの矩形だけで作る（Ctrl+クリックの複数カーソルは無効）。
- 矩形は先頭行の始点と最終行の終点を角として `report_cursor` の `block: true` で送り、Rust の `set_block_cursor` が実 Neovim に Ctrl-V で設定する。GUI の列は半開区間なので、inclusive では右端を1文字戻す。
- 矩形 Visual 中の通常ドラッグは文字単位 Visual に切り替える（従来はエラー）。
- カーソル報告は矩形中も連続範囲にしない。AI の送信範囲を矩形の外へ広げないという不変条件を維持する。矩形の表示は GUI 側の選択がそのまま担う。

## 結果・制約

- 角は先頭行・最終行の範囲から取るため、先頭行や最終行が短いと矩形の幅が狭まる（コードに `shortcut:` として記録）。
- Neovim 側で Ctrl-V により作った矩形は従来通り GUI に描画しない。

## 確認方法

- `cargo test --test vim_input gui_block_selection_installs_native_visual_block`（矩形 Visual の設定、`d` で矩形だけ削除、通常ドラッグで文字 Visual へ戻る）。
- `npx vitest run src/presentation/editor`（矩形を角2点と `block` で報告）。
- 実デスクトップでの Alt+ドラッグの目視は未実施。
