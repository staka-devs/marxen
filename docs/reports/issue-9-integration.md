# Marxen 統合検証・Windows 配布確認

検証日: 2026-10-09。環境: Windows x64、Node 22.23.2、Rust 1.99.0 MSVC、Tauri 2.12、WebView2 / Edge 154、Neovim 0.11.5。

## 自動検証

| 検証 | 結果 |
| --- | --- |
| TypeScript `typecheck` / production `build` | 成功 |
| Vitest | 36 ファイル / 231 件成功 |
| 配布資源スクリプト | Node 3 件成功 |
| Windows native Rust | 161 件成功。実 Neovim の編集・保存・復元・隔離、ローカル HTTP / ACP の AI 回帰を含む |
| Rust fmt / Clippy | fmt と全 target の `-D warnings` 成功 |
| 生成 IPC 契約 | 文書・AI・隔離の 3 種類すべて一致 |
| 製品 E2E | Chromium 12 件成功 |
| ライブ編集器 E2E | Chromium 17 件成功 |
| 実 Neovim smoke | 同梱資源と配布物の両方で、版・Markdown runtime・日本語・絵文字 buffer が成功 |
| Docker devcontainer build | 未完了。OS 依存パッケージの展開中に Docker のビルド接続が切断された。Linux コンテナーの回帰は未実施 |

資格情報ストアのテストは opt-in で、既定の Rust テストでは実ストアを操作しない。専用 entry を使った Windows の保存・再取得・削除は別途確認済み。利用者の API 資格情報は使っていない。

## Windows 実アプリ

実 WebView2 と Rust の文書 snapshot、revision、ファイルを読み戻して判定した。キー・ドラッグは Windows への合成入力であり、ハードウェアによる押下ではない。

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

配布版から開いた [インラインチャット](issue-9-integration/windows-inline.png)、[Agent チャット](issue-9-integration/windows-agent.png)、[画像タブ](issue-9-integration/windows-image.png)。製品 E2E の [分割](issue-5-ui/split.png)、[設定](issue-5-ui/settings-dark.png) も参照。

GUI の AI 回答・提案・取消はローカル検証用 ACP プロセスを使用した。認証済み provider への生成成功は意味しない。インラインの差分適用・Undo と画像ドラッグは同じ Rust / WebView2 の開発アプリで検証し、配布版では起動、画像表示、チャット、IME と資源配置を確認した。

## Windows 配布物

アプリソースは `afdef80`。未署名 NSIS `Marxen_0.1.0_x64-setup.exe` を生成し、インストールせず作業ディレクトリへ展開して起動した。

| 項目 | 値 |
| --- | --- |
| インストーラーのサイズ | 16,261,272 bytes |
| インストーラー SHA-256 | `5bda7e4685626b3d3b4d685a917429a0a4e818c5ec7159f0bc31b04cf9e51105` |
| 展開したアプリ SHA-256 | `5c0389dd446fc2eaee8271e6aebbb0964f4b081386a82c566b60ba4a818a5f8f` |
| Neovim 資源 | 2,067 ファイル。配布元とのファイル集合・各 SHA-256 がすべて一致 |

展開したアプリと build 出力の差分は Tauri の NSIS 識別子 3 bytes のみ。実プロセスの親子関係から、展開先の `neovim/bin/nvim.exe` を起動したことも確認した。検証用画面に開いた文書は未保存変更を残さず閉じた。

## OS ごとの確認範囲

CI は Windows x64 (NSIS)、macOS arm64 / x64 (app / DMG)、Linux x64 (deb / AppImage) で native テスト・IPC・E2E・package build を実行する設定。`7faaba1` の [実行](https://github.com/staka-devs/marxen/actions/runs/37860020737) は 4 target ともステップ開始前に停止した。GitHub の注釈はアカウントの支払い失敗または利用上限の制限を示し、テストログと配布成果物は生成されていない。ローカル Windows の成功と区別する。

対象コミットの最新結果と成果物は [PR #10 の checks](https://github.com/staka-devs/marxen/pull/10/checks) を参照する。古いコミットの結果を現在の確認結果に流用しない。

以下は未確認。

- macOS / Linux の実 WebView、日本語 IME、OS 資格情報ストア、配布後の対話操作。
- Windows 実 WebView2 での地図・3D 描画。Chromium では確認済み。
- 認証済み Codex / OpenCode / HTTP provider への生成要求。実 OpenCode 接続は initialize / session/new まで。
- メールアプリへの画像入りリッチテキスト貼り付け。
- NSIS による実インストール・アンインストール、署名・公証、Docker devcontainer build の完了。

ブラウザ E2E、headless Neovim、package build の成功から実 GUI / IME の成功を推定しない。
