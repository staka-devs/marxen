# ワークスペース保存・復旧の検証

証拠の種類を区別する。native CLI / Neovim は実バイナリと実ファイルでの実行、browser fixture は Chromium 上の production shell と模擬 transport による表示・操作の確認、actual WebView / 物理 IME は各 OS の実表示・実入力での確認である。Chromium の成功を実 WebView・IME の成功としない。

## 履歴: 2026-10-07 の保存・復旧検証

この節は履歴として保持する。記録された commit が現行 main と同一である証拠がないため、現行 main の成功証拠として扱わない。

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

## 現行系列の複数フォルダー検証

対象は PR95 の `a17cabe` で、PR95 の 4 環境 CI (`38819531129`) は成功した。squash 後の main `ff10a908` は tree `dcd591100581964a34570b68eb58d52bee80869c` が同一であり、本節の `a17cabe` の証拠を現行 main の系列証拠として扱う。複数のフォルダー・同名文書と画像の分離・追加と削除の保存/破棄/取消・配置復元・ファイルメニューとツリー操作の範囲を含む。

| 検証 | 結果 |
| --- | --- |
| `npm run typecheck` | 成功 |
| `npm run architecture:check` | 340 files、2866 / 2866 named operations documented、0 violations |
| `npm run localization:check` | 811 complete base keys、61 presentation files、0 violations |
| `contracts:check` / `ai-contracts` / `isolation-contracts` / `vim-settings-contracts` | 成功（4 種） |
| `npm run test:bundling` | 成功（19 tests） |
| `npm run build` | 成功 |
| `cargo fmt -- --check` | 成功 |
| `cargo check`（desktop 条件） | 成功 |
| `cargo clippy --locked --features dev-tools --all-targets -- -D warnings` | 成功 |
| `cargo doc --locked --features dev-tools --no-deps --document-private-items` | 成功 |
| `npm run verify:neovim` | 成功（同梱 Neovim 0.11.5 runtime と日本語/emoji buffer smoke） |
| focused Vitest 16 files / 149 tests + 修正後焦点 20 tests、`typecheck`、`git diff --check` | 成功（full suite の成功を意味しない） |
| native `multi_root` 6 tests（Windows 実一時フォルダー + 同梱実 Neovim、同名文書と異なる同名 PNG、片方のみ編集・保存・検索、取消、保存失敗時保持、選択ルートのみ保存・破棄、canonicalize による重複・親子・junction 拒否） | 成功（Unix symlink は Windows 実行に含まない） |
| native `workspace` 29 tests、`isolation` 32 tests | 成功 |
| browser `multi-root` 2 tests + `workbench` 1 test（production shell + simulated transport、390px、en-US / ja-JP / 関西・徳島、削除ダイアログ境界表明） | 成功（実 Neovim・実 WebView・物理 IME の証拠にしない） |

browser fixture の 3 tests は実ファイル・実 Neovim の代替ではない。確認内容は同名文書と画像タブ、追加時の未保存内容・選択保持、ルート付き作成・クイックオープン・検索置換、取消・保存失敗の保持、削除後の遅延 open / poll 応答の無効化、再起動相当の復元、見つからないルート・タブと未対応メタデータの保持、所有者別 rename、既存 AI 機能の回帰である。

下図は Chromium の simulated-native fixture による狭幅表示例であり、実 OS のスクリーンショットではない。削除確認が 390px 幅に収まることを示す。

![狭幅でのフォルダー削除確認](images/remove-dialog-narrow.png)

*390px・ja-JP、Escape 前の削除確認。bounds とはみ出しなしは live 表明で確認した。旧 narrow 捕獲が閉止後の画面であった旨の訂正を維持する。*

未実施の CI 相当: 全 Vitest（focused 以外）、Chromium product / live の全 suites、デスクトップ配布物のビルド（Issue #9 の combined-main で扱う）。

## OS 受入の未完了と制限

| 対象 | 状態 |
| --- | --- |
| Windows 実 WebView2 / 物理 IME・実機操作 | 未検証（現行 main では未実施）。別系列 PR94 先端 `154c5c6` の実 WebView2 修正確認は履歴として保持するが、現行 main `ff10a908` の成功証拠としない。PR94 は未 merge で利用者回答待ちである |
| 混在改行入力の白画面（Issue #92） | 未解決として開いたままにする。特定入力条件の制限であり、検証が必要な箇所では事実として開示する |
| Linux 実機 | Docker 準備は `6c8e8a4` で Node 22.23.2 / Rust 1.99 / Neovim 0.11.5 として成功。`a17cabe` の手動 JS ゲートは成功（`npm ci` 411 packages / 0 vulns、`bundle:neovim` + `verify:neovim`、architecture / localization / typecheck、contracts 4 種、bundling、Vitest 88 files / 696 tests 全 PASS、frontend build、cargo fmt）。Rust tests / check / clippy / doc / Playwright / deb / AppImage は実行中または未完了のため pending / not verified とし、成功を推定しない |
| macOS 実機（実 WebView / IME / install） | 実機がなく未検証。4 環境 CI の build 成功を実機成功としない |
| 署名・公証・配布 package 操作 | 未実施。ブラウザや Windows の成功から推定しない |

古い実 GUI 証拠は元の系列（例: PR94 `154c5c6`）を明記したまま保持し、最新 main の証拠へ繰り上げない。
