# Issue #5 UI 最終操作の検証報告

- 日付: 2026-10-08
- ブランチ: staka625/issue-5-ui
- 実装範囲: フロントエンドと Tauri 実ダイアログ配線のみ。Rust 契約・アクター・IPC・AI・描画の実装は変更しない（`contracts:check` と `ai-contracts:check` で差分なし）。Issue #4 が Rust IPC 全体を、Issue #7 が AI パネル本体を、Issue #6 が描画管路を所有する。
- 実効モデル: MuseSpark1.3 Contributor / Xhigh（`opencode.jsonc` の build 設定と models API の `active` + `xhigh` 変種で確認、代替なし）。

## 実装した内容

- 実ダイアログ: `tauri-plugin-dialog` を登録し、権限は `dialog:allow-open` のみに絞った。フォルダー選択と Neovim 設定ファイル選択は OS ダイアログで行い、手入力欄も残してどちらも同じレジストリ呼び出しに入る。ブラウザ表示にはダイアログを出さない。
- AI 支援の搭載: サイドバーに AI パネルを載せ、送信範囲は操作中文書の正確な文書 ID・改訂・選択範囲とする。接続先・モデル・カスタム起動引数などの非秘密だけを保存し、秘密は OS ストアだけに置く。提案受け渡し口（`onProposal`）を追加し、提案は原文を変えずに表示して却下できる。適用は #8 の差分レビューに任せ、#8 の API が無いため受け渡し口だけを用意した。
- ライブ表示の配線: ライブでは編集面に描画を統合し、原文・分割は装飾なしの編集面のままとする。描画の装飾・水和・管路には触れない。
- Vim 経路の点検: 原文基準の単語・テキストオブジェクト・マクロ動作を保ち、表示基準の上下・行頭末・選択は編集面に任せる。IME の未確定文は送らず、確定だけを送る。通常モードの IME キーを移動として扱わず、GUI 変更とキー入力の二重適用をしない。
- 操作面の整理:  activity rail（エクスプローラー・AI・設定）、タブ、抑えたツールバー、読みやすい編集幅、ライト・ダーク・コントラストの共通化、状態表示と誤り表示をそろえた。

## ローカル結果

環境は Windows x64、Node 22.23.2、npm 11.17.0、Rust 1.99.0 MSVC、束ねた実 Neovim 0.11.5、Chromium（Playwright 1.63.0）。

| 検証 | 結果と根拠 |
| --- | --- |
| `./node_modules/.bin/tsc --noEmit` | 成功 |
| `./node_modules/.bin/vitest run` | 成功。実ダイアログ呼び出し、AI 送信範囲、非秘密保存、提案受け渡し、キー経路、文書 ID・改訂の直送、直列化、stale 再同期、範囲置換、読み取り専用拒否（模擬 IPC）、範囲編集・UTF-16 境界・IME 確定・outline・検索・grid 解析・プレビュー消毒 |
| `./node_modules/.bin/playwright test --project chromium` | 成功。foundation 3（未接続の真実表示・読み取り専用・狭幅）と editor 5（モード維持・不正入力の安全表示・tree/tabs/quick-open/search/outline/palette/theme・原文ビュー・保存成功の非模擬） |
| UI 画像 | 成功。`docs/reports/issue-5-ui/` の 6 画像を最終コードの E2E で生成 |
| `npm run contracts:check` / `npm run ai-contracts:check` | 成功。生成 TypeScript に差分なし |
| `npm run test:bundling` | 成功 |
| `cargo test --no-default-features --locked` | 成功（lib・contracts・実 Neovim・workspace・AI・資格情報を含む） |
| `cargo clippy --locked --no-default-features --all-targets -- -D warnings` | 成功 |
| `cargo check --locked`（desktop 既定） | 成功（dialog プラグイン登録を含む） |
| `cargo fmt -- --check` | 成功 |
| `npm run build` | 成功 |

## 未検証

- Windows WebView2 + TSF、macOS WKWebView + NSTextInput、Linux WebKitGTK + IBus/Fcitx における実 IME のキー・確定・表示。各 OS の実 WebView 確認は別途行う。
- macOS arm64 / x64 と Linux x64 の native compile・Neovim smoke・package 操作、署名 / 公証。
- 実ダイアログと実フォルダーの実機操作。AI パネルの実接続と #8 差分レビュー。

## 決定記録

判断は `docs/adr/ADR-0052-実ダイアログとAI提案受け渡しで最終操作を繋ぐ.md` に記録した。
