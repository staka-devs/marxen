# Marxen 統合検証・Windows 配布確認

検証日: 2026-10-09。UI・配布物のソースは `8150fa1`。Windows x64、Node 22.23.2、Rust 1.99.0 MSVC、Tauri 2.12、WebView2 / Edge 154、Neovim 0.11.5。Rust 検証ソース `8eccced` と配布対象の `src-tauri/` は一致する。

## 自動検証

| 検証 | 結果 |
| --- | --- |
| TypeScript `typecheck` / production `build` | 成功 |
| Vitest | 38 ファイル / 239 件成功 |
| 配布資源スクリプト | Node 3 件成功 |
| Windows native Rust | 162 件成功。実 Neovim の編集・保存・復元・隔離、ローカル HTTP / ACP の AI 回帰を含む |
| Rust fmt / Clippy | fmt と全 target の `-D warnings` 成功 |
| 生成 IPC 契約 | 文書・AI・隔離の 3 種類すべて一致 |
| 製品 E2E | Chromium 12 件成功 |
| ライブ編集器 E2E | Chromium 17 件成功 |
| 実 Neovim smoke | 同梱資源と配布物の両方で、版・Markdown runtime・日本語・絵文字 buffer が成功 |
| Linux の frontend | `8150fa1` の typecheck / build、38 ファイル / 239 件、資源スクリプト 3 件、製品 E2E 12 件・ライブ E2E 17 件成功 |
| Linux native Rust / 契約 / Clippy / package | 開発依存不足で assertion 前に停止。fmt は成功。deb / AppImage は未生成 |

実行したコマンドと workflow との差は [手動 CI](manual-ci.md) / [Linux 手動検証](issue-16-linux-manual-ci.md) に記載する。Rust の 162 件には、既定では早期 return する実資格情報ストアと実 ACP 接続の opt-in テスト各 1 件を含む。認証済み AI の生成成功を意味しない。専用 entry を使った Windows の保存・再取得・削除は別ソースで確認済み。利用者の API 資格情報は使っていない。

## Windows 実アプリ

`8150fa1` の NSIS を展開した実配布アプリで、ライブ・ツリー・タブ・左右分割・設定・Agent・インラインを確認した。画面と検証項目は [UI 検証](issue-17-ui.md) に保存する。Agent は二つの会話を切り替えて履歴を保持し、質問前後で本文不変。インラインは提案受信後も承認前は本文不変で、製品 UI の承認により最初の見出しだけを変更した。一回の UI Undo で Neovim と画面を元の本文・保存済みに復元し、ディスクの本文も一致した。

[Agent](issue-17-ui/windows-agent.png)、[インライン](issue-17-ui/windows-inline.png)、[左右分割](issue-17-ui/windows-split.png)、[設定](issue-17-ui/windows-settings.png) は今回の配布アプリの実画面。

以下の表は `afdef80` と当時の開発アプリ・配布物で実施した結果。今回の UI ソースでの再実施とは区別する。実 WebView2 と Rust の文書 snapshot、revision、ファイルを読み戻して判定した。キー・ドラッグは Windows への合成入力であり、ハードウェアによる押下ではない。

| 操作 | 確認した結果 |
| --- | --- |
| 文書・設定 | フォルダー読込、Markdown 描画、保存、Neovim Undo、設定適用、ユーザーマッピング |
| 日本語 IME | Markdown / ライブの未確定・変換中は文書不変。確定は一回の変更。一回の Undo で復元。Esc 取消と Normal モードは文書不変 |
| エクスプローラー | フォルダー・Markdown・テキスト・画像の種類別アイコン。非対応ファイルは非表示。ルートはフォルダー名、完全パスは tooltip |
| テキスト・画像 | テキストは Neovim の文書。画像は buffer を作らず Blob URL で表示し、フィット・実サイズ・125% 拡大 |
| 内部画像ドラッグ | 日本語名を URL エンコードした相対リンクを一回だけ挿入。一回の Undo で復元 |
| 外部画像ドラッグ | Windows OLE FileDrop → Tauri → Rust で PNG をコピーして挿入。コピー元・コピー先の SHA-256 が一致。一回の Undo で文書復元 |
| Agent チャット | 実 Rust → ローカル ACP fixture → WebView2 で回答。非表示・再表示、新規会話・以前の会話への切替で履歴保持。質問は文書不変 |
| インラインチャット | Ctrl+Shift+I でカーソルの近くに開き、Agent パネルは閉じたまま。差分確認、対象範囲だけの適用、一回の Undo |
| AI 取消 | 途中の応答を取消し、提案を作らず文書を保持 |
| 画像入りリッチコピー | Windows Word の通常の貼り付けで二つの PNG、見出し、表、日本語・絵文字を保持。HTML / RTF の両方に画像を含む。元のクリップボードを復元 |

旧画面の [インライン](issue-9-integration/windows-inline.png)、[Agent](issue-9-integration/windows-agent.png)、[画像タブ](issue-9-integration/windows-image.png) は `afdef80` の配布版。製品 E2E の [分割](issue-5-ui/split.png)、[設定](issue-5-ui/settings-dark.png) は Chromium の画面であり、実 WebView2 と区別する。

GUI の AI 回答・提案・取消はローカル検証用 ACP プロセスを使用した。認証済み provider への生成成功は意味しない。上表の画像ドラッグは当時の Rust / WebView2 開発アプリで検証し、IME・画像表示・チャット・資源配置は当時の配布版でも確認した。今回の配布版で確認した差分適用と Undo は前述の通り。

## Windows 配布物

アプリソースは `8150fa1fb0dd67d0a1169f7af07e533eca0740ce`。未署名 NSIS `Marxen_0.1.0_x64-setup.exe` を生成し、インストールせず作業ディレクトリへ展開して起動した。

| 項目 | 値 |
| --- | --- |
| インストーラーのサイズ | 15,791,028 bytes |
| インストーラー SHA-256 | `f6639e5fc3c50b3b2c3b187ebb74f1a372956494b2e17b9a147b998e287dd1f5` |
| 展開したアプリ SHA-256 | `335c8ac3f16255608d384d79f3c9fd3b3c3a56882eb3d1c878580a2ad08f3b93` |
| Neovim 資源 | 2,067 ファイル。配布元とのファイル集合・各 SHA-256 がすべて一致 |
| 開発用バイナリー | 契約出力 3 種類と ACP / 隔離 mock 2 種類を含まない |

展開したアプリと build 出力の差分は Tauri の NSIS 識別子 3 bytes のみ。実プロセスの親子関係から、展開先の `neovim/bin/nvim.exe` を起動したことも確認した。検証用画面に開いた文書は未保存変更を残さず閉じた。

## OS ごとの確認範囲

CI は Windows x64 (NSIS)、macOS arm64 / x64 (app / DMG)、Linux x64 (deb / AppImage) で native テスト・IPC・E2E・package build を実行する設定。`8150fa1` の [実行](https://github.com/staka-devs/marxen/actions/runs/37926614016) は 4 target とも step 数 0。GitHub の注釈はアカウントの支払い失敗または利用上限の制限を示し、テストログと配布成果物は生成されていない。手動検証の成功と区別する。

対象コミットの最新結果と成果物は [PR #10 の checks](https://github.com/staka-devs/marxen/pull/10/checks) を参照する。古いコミットの結果を現在の確認結果に流用しない。

Clean Architecture / YAGNI / DRY / SOLID のレビュー結果と未達箇所は [フロントエンド](issue-14-frontend-architecture.md) / [Rust](issue-15-backend-architecture.md) に記載する。Shell の責務集中と具体的な adapter への依存が残り、厳密な完全準拠とは判定しない。

以下は未確認。

- macOS / Linux の実 WebView、日本語 IME、OS 資格情報ストア、配布後の対話操作。
- macOS の手動 native 回帰、Linux の native テスト・契約・Clippy・deb / AppImage。
- 今回の UI ソースでの Windows 実 IME・Word 貼り付けの再検証。
- Windows 実 WebView2 での地図・3D 描画。Chromium では確認済み。
- 認証済み Codex / OpenCode / HTTP provider への生成要求。実 OpenCode 接続は initialize / session/new まで。
- メールアプリへの画像入りリッチテキスト貼り付け。
- NSIS による実インストール・アンインストール、署名・公証、Docker devcontainer build の完了。

ブラウザ E2E、headless Neovim、package build の成功から実 GUI / IME の成功を推定しない。
