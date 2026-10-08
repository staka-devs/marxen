# Marxen

Markdown のMarkdownを保ち、実 Neovim と GUI で編集する Rust / Tauri デスクトップアプリです。Rust が編集・保存・AI 通信を所有し、GUI と AI は revision 付きの範囲編集を行います。

## デスクトップでの操作

1. 「フォルダーを開く」で作業フォルダーを選び、ファイルツリーから Markdown を開きます。タブ、クイックオープン、検索・置換、アウトライン、コマンドパレットも使用できます。
2. 本文は「ライブ」「Markdown」「閲覧」「分割」で切り替えます。ライブは本文内の非アクティブなブロックを描画し、編集中のブロックはコードを表示します。表示切替では本文・cursor・Undo を保持します。
3. Vim の移動の Vim 操作では実 Neovim が `i` / `Esc`、移動、text object、macro、`u` / `Ctrl+r` を処理します。「表示基準」は折り返し行の上下・行頭末を扱います。画面依存の plugin 操作にはメニューの「Neovim 画面」を使用します。
4. 「保存」または Vim の `:w` で Rust の保存経路を使います。外部変更や保存競合は通知されます。「再読込（未保存を破棄）」は編集中の内容を破棄する操作です。未保存のタブを閉じると選択肢が表示され、次回起動時にはクラッシュ復元の候補を表示します。
5. 設定ではテーマと Neovim 設定ファイルを選べます。既定は専用設定で、`.vimrc` / `vimrc` / `_vimrc` / `init.vim` / `init.lua` に対応します。「設定を適用して再起動する」は本文・revision・未保存状態を保持し、Undo とモードを初期化します。設定のエラーは画面に表示します。

`yy` / `yw` / `yiw` / 選択して `y` の直後に、次の形式キーを押すと OS のクリップボードへコピーします。別のキーを押すと通常の Vim 操作になります。既存のユーザーマッピングがあるキーはそのマッピングを優先します。

| キー | コピー形式 |
| --- | --- |
| F6 | Markdown |
| F7 | 装飾なしテキスト |
| F8 | リッチテキスト（HTML と通常テキスト、Windows / macOS は画像入り RTF も提供） |
| F9 | HTML ソース |

リッチテキストの相対画像は埋め込みデータにして渡します。PNG / JPEG は画像を保持し、RTF 用の GIF / WebP は静止画になります。外部 URL の画像は HTML の参照を保持します。貼り付け先が使う形式はアプリにより異なります。

vimrc の例（1 キーの Neovim 表記を指定、空文字で無効化）:

```vim
let g:marxen_copy_markdown_key = '<F6>'
let g:marxen_copy_text_key = '<F7>'
let g:marxen_copy_rich_key = '<F8>'
let g:marxen_copy_html_key = '<F9>'
```

GFM の表・task list・Alerts・脚注、highlight、数式、Mermaid、sanitized HTML、GeoJSON / TopoJSON、ASCII STL を描画します。描画ライブラリは同梱します。相対画像と画像貼付はワークスペースの資源として扱います。

## AI 接続と変更の承認

AI パネルの接続設定で、Codex ACP (`codex-acp`)、OpenCode ACP (`opencode acp`)、任意の argv、OpenAI 互換 Chat Completions、Anthropic Messages を登録します。ACP adapter は利用者が導入します。Anthropic は利用者の明示設定で有効にします。API 資格情報は OS ストアに保存します。

送信前に対象文書・選択範囲・抜粋を確認し、質問・生成・選択 rewrite・workspace 修正を選びます。ACP には登録した範囲だけを隔離コピーとして渡します。取消は処理の終了が確認されてから確定します。提案は差分を確認して承認・却下・取消を選び、承認後もファイル保存は別操作です。revision やディスクの競合がある場合は範囲を再登録してください。隔離コピーは同一マシンの staging であり、OS sandbox ではありません。

実 API への要求や CLI の prompt 送信には利用者の接続設定・認証が必要です。通常の回帰テストはローカル mock を使います。Claude Code の preset は提供しません。

## 開発環境と検証

CI / Linux x64 devcontainer は Node 22.23.2 と Rust 1.99.0 を使用します。Windows の MSVC / WebView2、macOS の Xcode Command Line Tools、Linux の WebKitGTK 4.1 など、[Tauri の前提環境](https://v2.tauri.app/start/prerequisites/)を用意してください。Windows の Rust コマンドは x64 Developer PowerShell から実行できます。

```sh
npm ci
npm run bundle:neovim
npm run verify:neovim
npm run desktop:dev     # 実 Neovim を使うデスクトップアプリ
npm run dev             # 読み取り専用のブラウザ表示
npm run typecheck
npm test
npm run test:bundling
npm run contracts:check
npm run ai-contracts:check
npm run isolation-contracts:check
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml --locked
cargo check --manifest-path src-tauri/Cargo.toml --locked
cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings
npx playwright install chromium
npm run test:e2e
npm run build
```

Rust 型の変更後は対応する `contracts:generate` / `ai-contracts:generate` / `isolation-contracts:generate` を実行します。GUI 依存のない環境では `cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --locked` を使用できます。実 Neovim はこの場合も必要です。Rust の lint は clippy、TypeScript は typecheck を実行します。独立した TypeScript lint の設定はありません。

Playwright は製品用 production build と、配布に含まれないライブ描画 harness の2系統を実行します。既存サーバーは再利用しません。競合する場合は `MARXEN_E2E_PORT` / `MARXEN_E2E_LIVE_PORT` を変更できます。Chromium の成功は OS 固有の WebView・IME の成功を意味しません。

実 OS 資格情報ストアの検証は opt-in です。使い捨ての専用 entry を保存・再取得・削除し、利用者の API 資格情報は使いません。

```powershell
$env:MARXEN_NATIVE_KEYRING_TEST = '1'
cargo test --manifest-path src-tauri/Cargo.toml --locked --test credentials_native
Remove-Item Env:MARXEN_NATIVE_KEYRING_TEST
```

## 配布

```sh
npm run desktop:build
# Windows の NSIS に限定する場合
npm run desktop:build -- --bundles nsis
```

公式 Neovim 0.11.5 archive を固定 SHA-256 で検証し、実行ファイル・DLL・runtime 全体を取り込みます。別 target の取得は `npm run bundle:neovim -- --target <Rust target>`、runtime smoke は対応 OS / CPU で実行します。package は `src-tauri/target/release/bundle/` に生成します。CI の明示 target build は `src-tauri/target/<Rust target>/release/bundle/` に生成します。

展開した package の Neovim 資源は `MARXEN_VERIFY_NVIM_ROOT` にその `neovim` ディレクトリを指定して `npm run verify:neovim` で検証できます。この検証先指定は同梱確認スクリプトだけに適用されます。

CI は Windows x64 (NSIS)、macOS arm64 / x64 (app / DMG)、Linux x64 (deb / AppImage) の native build、3種類の IPC 契約、Rust / TypeScript / unit / E2E を設定します。配布版は未署名です。署名・公証は対応する資格情報のある環境で別途実施します。

実施済みの回帰・Windows 配布確認と、未実施の OS・WebView・日本語 IME・署名の範囲は [Issue #9 統合検証報告](docs/reports/issue-9-integration.md) に記載します。他 OS の package 操作、実 WebView / IME、署名・公証をブラウザや Windows の成功から推定しません。devcontainer の GUI にはホストの表示サーバーが必要です。

[実装契約](docs/implementation.md)、[文書 IPC](docs/foundation.md)、[AI 接続の検証](docs/reports/issue-7-ai.md)、[隔離・承認](docs/isolation.md)、[AnyDR](docs/adr/README.md) を参照してください。
