# ワークスペース保存・復旧の検証

実施日: 2026-10-07。Windows x64、Rust stable MSVC、同梱 Neovim 0.11.5。
実 Neovim embed を使い、ファイルシステムは Windows の一時ディレクトリで検証した。

| 実施コマンド | 結果 |
| --- | --- |
| `npm run verify:neovim` | 固定版の runtime、実 Neovim、日本語/絵文字のバッファ smoke 成功 |
| `cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --offline` | 49 件成功、失敗 0。workspace は 21 件 |
| `cargo check --manifest-path src-tauri/Cargo.toml --offline` | desktop の IPC 登録を含め成功 |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --offline --all-targets -- -D warnings` | 成功 |
| `npm run contracts:check` | Rust と生成 TypeScript 契約が一致 |
| `npm run typecheck` | 成功 |
| `npm run build` | Vite production build 成功 (chunk size の警告あり) |
| `npm run test -- --reporter=dot` | 3 ファイル、5 件成功 |

workspace テストの実施範囲:

- BOM、CRLF/LF 混在、末尾改行、空ファイルの exact bytes 保存と UTF-16 の範囲編集。
- 内容 fingerprint の競合、外部変更/削除イベントの重複抑制、明示的再読込。
- readonly と Windows ファイルロックによる保存失敗時の元ファイル・未保存状態・復旧記録保持。
- Windows protected DACL の権限と保護状態、名前付きストリームの保存。
- 未保存終了の cancel/save/discard と保存失敗時の close 中止。
- 別プロセスの強制終了後の復旧、外部変更を伴う復元、実 Neovim の終了。
- traversal、絶対パス、ADS、予約名、外部 junction、開いた後の親ディレクトリ差替え拒否。
- 文書レジストリ、同じファイルの重複 open、create/rename、別文書の本文・Undo 分離。
- 実 Vim の `:w` と GUI が同じ保存処理を使うこと、保存競合時の拒否。
- GUI 複数範囲を一つの Undo で戻すこと、別 gesture の Undo/Redo と初期本文の Undo 下限。
- cursor、raw grid、キー入力 revision、設定再起動と設定評価エラー。
- 未保存本文の検索、絵文字を含む UTF-16 範囲、相対画像とエンコードされた日本語名、画像貼付の revision 検証。

未実施: Linux/macOS のネイティブファイルシステム動作、各 OS の実 WebView/日本語 IME、
GUI のツリー/タブ/復旧ダイアログとの統合操作、実電源断・ディスク容量不足、
Windows ReplaceFileW の稀な OS 部分失敗、協調しない外部プロセスの最終置換直前 race、
アプリ署名・公証・配布パッケージ。Rust/ブラウザの成功からこれらの成功を推定していない。

