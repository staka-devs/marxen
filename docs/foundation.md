# Issue #2 基盤の契約

## 実装範囲

Rust / Tauri v2、React / TypeScript / Vite / Tailwind v4、shadcn/ui 形式の Button / Card、Radix Slot、CodeMirror 6 の起動基盤を提供する。日本語 UI は読み取り専用サンプルを明示する。Rust の get_runtime_status は現在 disconnected を返す。ブラウザ起動は desktop 未接続を表示し、IPC エラーは取得失敗として表示する。

actor、RPC、権威ある文書の生成、ワークスペース、保存、ライブプレビュー、AI は未実装。edit / save / cursor / mode は後続実装が使用する型と純粋な検証関数を定義する。登録する Tauri コマンドは get_runtime_status のみで、成功した編集・保存・Vim を模擬しない。

## 共通 IPC 型

正本は src-tauri/src/contracts.rs。ts-rs で src/shared/contracts.ts に生成し、contracts:check で差分を検出する。JSON field は camelCase、enum 値は snake_case。契約版は 1。

| 型 | 意味 |
| --- | --- |
| DocumentId | パスと独立した不透明 ID。1〜128 ASCII 文字、英数字・_・- のみ |
| Revision | 内容の世代。非負 u32。初期値 0、内容変更で 1 増加 |
| Utf16Offset | 原文全体の先頭からの UTF-16 code unit 数。0 起点 |
| Utf8ByteOffset | 原文全体の先頭からの UTF-8 バイト数 |
| DocumentSnapshot | documentId / revision / 原文 text / dirty |
| EditRequest | documentId / baseRevision / source (gui, neovim, ai) / 範囲編集配列 |
| SaveRequest | documentId / baseRevision。保存先は Rust が所有 |
| SaveResult | documentId / 保存 revision / dirty。保存だけでは内容 revision を増やさない |
| CursorUpdate | documentId / revision / anchor / head。逆方向選択を許容 |
| ModeUpdate | documentId / revision / 実 Neovim の VimMode |
| DocumentEvent | type / payload による snapshot / saved / cursor / mode の判別 union |
| RuntimeStatus | contractVersion / 実エンジンの connection / detail |
| ContractError | code による判別 union。stale_revision は expected / received を含む |

数値は JSON に安全な u32 に限定し、負数・小数・オーバーフローは Rust の deserialize で拒否する。最大 revision は revision_exhausted とし、後続 actor が新 ID / snapshot に移行する。

## 位置と範囲編集

位置は表示列や grapheme 数ではなく原文の位置である。範囲は半開区間 [start, end)。a😀日本語 の絵文字は UTF-16 [1,3)、UTF-8 [1,5) に対応する。CRLF は 2 units と数え、結合文字 / ZWJ を正規化しない。

validation.rs は surrogate pair の中間、UTF-8 scalar の中間、範囲外、逆転範囲を拒否する。grapheme 境界は強制しない。全編集は同じ base snapshot の昇順・非重複範囲である。隣接範囲は許容し、同じ開始位置の複数編集 / 挿入、空配列は拒否する。

validate_edit は検証済み UTF-8 バイト範囲を返し snapshot を変更しない。後続 actor は入力を直列化して revision を再確認し、末尾から実 Neovim に適用して新 snapshot を発行する。save / cursor / mode も対象 ID と exact revision を検証する。cursor / mode は内容 revision を増やさない。stale_revision では最新 snapshot に再同期する。現在は適用経路や再同期コマンドを実装しない。

## 同梱と検証の境界

scripts/neovim-manifest.json は公式 0.11.5 の archive と 4 target の SHA-256 を固定する。cache も検証し、archive 全体を src-tauri/resources/neovim/ に展開する。Windows DLL、runtime、archive 内ライセンスを保持する。バイナリ / cache は Git に含めない。

通常の dev / Rust test はダウンロード不要。配布は tauri.bundle.conf.json の resources mapping で neovim/ を同梱する。後続 actor は Tauri の app.path().resource_dir() 以下の neovim/bin/nvim(.exe) と neovim/share/nvim/runtime を解決し、VIMRUNTIME を渡す。実行ファイルだけの externalBin は DLL / runtime が欠落するため使わない。

verify-neovim.mjs は native OS / CPU で実 Neovim を headless 起動し、固定版、Markdown runtime、日本語・絵文字 buffer を検証する。RPC actor、mapping、Undo、IME、WebView は検証しない。

Linux devcontainer は x64 用で Node 22.23.2、Rust 1.99.0、GTK / WebKitGTK 4.1、固定 runtime を用意する。OS パッケージは Debian repository の更新に従う。

Rust tests は共通 fixture、ID、revision、Unicode、範囲、save / cursor / mode、wire shape を検証する。Vitest は接続状態・IPC エラー・transport、Playwright は実 Chromium の日本語 UI・読み取り専用動作・狭い画面を検証する。4 native CI に package build と実 Neovim smoke を設定する。ブラウザ E2E は WebView / IME の代替ではない。

文書の正本と所有権は ADR-0001 / ADR-0002、devcontainer は ADR-0003 に従う。基盤の判断は [ADR-0010](adr/ADR-0010-Rustの型から共通IPC契約を生成する.md)、[ADR-0012](adr/ADR-0012-固定ハッシュのNeovim実行環境を丸ごと同梱する.md)、[ADR-0013](adr/ADR-0013-四つのネイティブCIとブラウザ検証を分ける.md) に記録する。
