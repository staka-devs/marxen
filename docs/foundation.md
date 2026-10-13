# デスクトップ基盤と IPC 契約

## 実装範囲

Rust / Tauri v2、React / TypeScript / Vite / Tailwind v4、Radix、shadcn/ui 形式のコンポーネント、CodeMirror 6 を使用する。文書は Rust が所有する実 Neovim のバッファを正本にする。実エンジンの接続状態と IPC エラーを表示し、未接続時に編集・保存の成功を模擬しない。

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

ワークスペースのエントリーは `WorkspaceEntry.directory` でフォルダーを識別し、ファイルは `kind` の `markdown` / `text` / `image` で区別する。Markdown と UTF-8 テキストだけが Neovim の文書 buffer を持ち、画像は byte 資源として扱う。テキストに見せかけたバイナリは `not_text` で拒否する。

| コマンド | 意味 |
| --- | --- |
| `open_text_file` | Rust の workspace 内にある UTF-8 テキストを Neovim で開く |
| `load_workspace_image` | 対応画像を workspace 内から読む。画像タブは document ID を作らない |
| `insert_workspace_image` | 既存画像の相対リンクを指定文書の revision 付き範囲へ挿入する |
| `import_external_image` | 外部 PNG / JPEG / GIF / WebP を workspace へコピーし、revision 付き範囲へ挿入する |

画像は拡張子と実データを検証し、1 枚 20 MiB、ドロップ 1 回 16 枚を上限とする。workspace の包含、symlink、revision を確認し、既存の同名ファイルを上書きしない。GUI は相対リンクを URL エンコードして扱う。

AI 契約は独立した schema version 2 を持ち、履歴は最大 32 メッセージ・20,000 文字に制限する。文書・AI・隔離の 3 種類をそれぞれ生成して CI で照合する。

数値は JSON に安全な u32 に限定し、負数・小数・オーバーフローは Rust の deserialize で拒否する。最大 revision は revision_exhausted エラーとする。

## 位置と範囲編集

位置は表示列や grapheme 数ではなく原文の位置である。範囲は半開区間 [start, end)。a😀日本語 の絵文字は UTF-16 [1,3)、UTF-8 [1,5) に対応する。CRLF は 2 units と数え、結合文字 / ZWJ を正規化しない。

validation.rs は surrogate pair の中間、UTF-8 scalar の中間、範囲外、逆転範囲を拒否する。grapheme 境界は強制しない。全編集は同じ base snapshot の昇順・非重複範囲である。隣接範囲は許容し、同じ開始位置の複数編集 / 挿入、空配列は拒否する。

validate_edit は検証済み UTF-8 バイト範囲を返し snapshot を変更しない。文書 actor は入力を直列化して revision を再確認し、末尾から実 Neovim に適用して新 snapshot を発行する。save / cursor / mode も対象 ID と exact revision を検証する。cursor / mode は内容 revision を増やさない。stale_revision では最新 snapshot に再同期する。

## 同梱と検証の境界

scripts/neovim-manifest.json は公式 0.11.5 の archive と 4 target の SHA-256 を固定する。cache も検証し、archive 全体を src-tauri/resources/neovim/ に展開する。Windows DLL、runtime、archive 内ライセンスを保持する。バイナリ / cache は Git に含めない。

配布は tauri.bundle.conf.json の resources mapping で neovim/ を同梱する。文書 actor は Tauri の app.path().resource_dir() 以下の neovim/bin/nvim(.exe) と neovim/share/nvim/runtime を解決し、VIMRUNTIME を渡す。開発・実 Neovim 統合テストには bundle:neovim を実行するか、同じ対象の検証済み資源を用意する。実行ファイルだけの externalBin は DLL / runtime が欠落するため使わない。

verify-neovim.mjs は native OS / CPU で実 Neovim を headless 起動し、固定版、Markdown runtime、日本語・絵文字 buffer を検証する。RPC actor、mapping、Undo、IME、WebView は検証しない。

Linux devcontainer は x64 用で Node 22.23.2、Rust 1.99.0、GTK / WebKitGTK 4.1、固定 runtime を用意する。OS パッケージは Debian repository の更新に従う。

Rust tests は共通 fixture、ID、revision、Unicode、範囲、save / cursor / mode、wire shape を検証する。Vitest は接続状態・IPC エラー・transport、Playwright は実 Chromium の日本語 UI・読み取り専用動作・狭い画面を検証する。4 native CI に package build と実 Neovim smoke を設定する。ブラウザ E2E は WebView / IME の代替ではない。

文書の正本と所有権は ADR-0001 / ADR-0002、devcontainer は ADR-0003 に従う。基盤の判断は [ADR-0010](adr/ADR-0010-Rustの型から共通IPC契約を生成する.md)、[ADR-0012](adr/ADR-0012-固定ハッシュのNeovim実行環境を丸ごと同梱する.md)、[ADR-0013](adr/ADR-0013-四つのネイティブCIとブラウザ検証を分ける.md) に記録する。
