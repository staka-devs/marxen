# Marxen の実装契約

Rust / Tauri v2、React / TypeScript / Vite / Tailwind / shadcn/ui、CodeMirror 6 を使い、同梱した実 Neovim を文書の正本にする。初回の表示言語はホストの主言語から日本語または英語を選び、設定で言語と地域表現を変更できる。ライブプレビュー、Vim 操作を既定とする。

## 作業と担当

| 作業 | 担当 | 依存 |
| --- | --- | --- |
| Tauri 基盤・IPC・3 OS CI・devcontainer | Codex | なし |
| Neovim・IME・表示座標 | OpenCode（Codex がレビュー・統合） | 基盤 |
| ワークスペース・保存・復元 | Codex | IPC |
| UI・ライブプレビュー・GUI 編集 | OpenCode | 文書 IPC |
| GitHub 記法・地図・3D | OpenCode | 描画基盤 |
| ACP・直接 API・AI パネル | OpenCode | IPC |
| AI 変更の隔離・差分適用 | OpenCode（Codex がレビュー・統合） | 保存・AI 接続 |
| 統合・回帰・配布 | Codex / OpenCode | 全機能 |
| ヤンク後の形式別コピー・画像入りリッチテキスト (#11) | Codex | 編集・描画 |
| ファイル一覧・画像操作・カーソル・設定 (#12) | Codex | 保存・UI |
| インラインチャット・Agent 会話履歴 (#13) | OpenCode（Codex がレビュー・統合） | AI・隔離・UI |
| 編集画面・チャットの UI 整理 (#17) | Codex / OpenCode | UI・チャット |
| 文字組み・ファイル検索・チャット・設定の再設計 (#20) | Codex / OpenCode | UI・チャット |
| Rust の五層分離・port・メソッド文書 (#18) | Codex | 文書・保存・AI・隔離 |
| TypeScript の五層分離・Shell 責務・メソッド文書 (#19) | OpenCode（Codex がレビュー・統合） | 編集・チャット・UI |
| GUI 入力後の改行・ライブ表示のカーソル (#21) | Codex（独立レビュー付き） | 編集・Neovim |
| AI 接続先・モデル・推論強度と設定ダイアログ (#22) | Codex / OpenCode | AI・チャット |
| 最新安定版の依存・ビルド容量と CI (#50 / #51) | Codex / OpenCode | 描画・配布 |
| 通知トースト・文書操作ダイアログ (#52) | Codex | 保存・復元 |
| ファイル別の検索結果・検索条件・置換 (#53) | OpenCode（Codex がレビュー・統合） | ワークスペース・文書 IPC |
| Windows ACP 実行ファイル探索・接続 (#54) | OpenCode（Codex がレビュー・統合） | AI 通信 |
| Vim 設定ファイルの全文テキスト編集 (#55 / #102) | OpenCode（Codex がレビュー・統合） | 設定ファイル・Neovim |
| 右側チャット・モデル選択・会話履歴 (#56) | Codex | AI・UI |
| 上部メニュー・フォルダー操作・複数ルート設計 (#57) | Codex | ワークスペース・文書操作 |
| 書式操作・選択ツールバーの Vim 設定 (#58) | Codex | GUI 編集・Vim 設定 |
| Agent ごとの実測使用量ポップアップ (#59) | Codex / OpenCode | ACP 通信・チャット |
| 言語切替・英語・日本語・地域表現 (#60) | Codex | 設定・UI |
| Vim入力・設定反映・Hot Exit・ACP・API形式・v0.1.1配布 (#102) | Codex | 編集・保存・AI・配布 |
| 全AIプロバイダーのアカウント管理と使用量 (#103) | Codex | AI・資格情報ストア |

Orca で Issue ごとの子ワークスペースとブランチを管理し、依存順に統合する。OpenCode は **MuseSpark1.3 Contributor / Xhigh** の実効設定を確認してから起動する。指定モデルが利用できなければ OpenCode の担当は停止して報告し、別モデルへ自動変更しない。Claude Code を起動・委任・接続検証しない。Anthropic Messages API は独立した接続先として利用者の認証設定後に有効化する。

## 文書契約

製品コードは `domain / application / contracts / infrastructure / presentation` の五層に分ける。副作用のない共有型を `contracts`、純粋な規則を `domain`、ユースケースと利用する port を `application` に置く。OS・通信・保存の実装は `infrastructure`、画面・Tauri コマンドは `presentation` が扱い、composition root から具体実装を注入する。SOLID / YAGNI / DRY を守り、すべての手書きの名前付き関数・メソッド・trait 操作に Rustdoc / JSDoc を付ける。

Rust が Neovim RPC、保存、AI プロセス、HTTP を所有する。文書 ID・リビジョン付き snapshot、edit、save、cursor / mode 更新を共通契約とする。GUI / Neovim / AI の変更を直列化し、古い revision を拒否して再同期する。UTF-8 バイト位置と UTF-16 位置は明示的に変換する。`:w` を Rust 保存経路へ統一する。範囲編集で Markdownを保持し、全体の再シリアライズを避ける。

## 受入条件

- 日本語 IME、絵文字、mapping 優先、モード切替、表示座標、GUI 編集と Vim Undo の共存を実 Neovim で検証する。
- ライブ表示は本文内の非アクティブな Markdown ブロックを描画し、編集中のブロックでは記法とカーソルを表示する。ライブ / Markdown / 閲覧と左右の分割表示で cursor / scroll / Undo を維持する。分割幅を変更でき、折り返し行に沿う移動と実 Neovim の単語・text object・macro を扱う。
- Obsidian / VSCode を参考に、細いアクティビティバー、用途を切り替えるサイドバー、コンパクトなタブ、広い本文、最小限のステータスバーを使う。表示切替・書式・AI設定はメニューやパネルに収め、常時表示の操作欄を減らす。本文とパネルを独立してスクロールする。
- .vimrc / vimrc / _vimrc / init.vim / init.lua を選択でき、エラーを表示する。専用設定が既定。設定は全文テキストで編集し、保存後は既存・新規文書と再起動後に反映する。GUIの設定項目によるVimscript再生成は行わない。画面依存 plugin 操作は Neovim 画面で扱う。
- 標準のヤンク完了後に Markdown / 装飾なし / リッチテキスト / HTML ソースを選んでコピーできる。形式キーは vimrc で変更・無効化でき、既存マッピングを優先する。相対画像を HTML と画像入り RTF に埋め込んで外部アプリへ渡す。
- フォルダー・Markdown・テキスト・対応画像を種類別アイコンで表示する。テキスト編集、画像タブのフィット・実サイズ・拡大縮小、内部画像と外部画像の本文へのドラッグを扱う。
- tabs、quick open、全文検索置換、outline、command palette、相対画像、画像貼付、外部変更、保存競合、クラッシュ復元。設定は外観・エディター・Vim・コピー・AI に分け、文字サイズ・行間・折り返し・行番号・行強調を保持する。
- 共通 remark / rehype 基盤で GFM、highlight、5 Alerts、脚注、MathJax、Mermaid、HTML sanitize、GeoJSON / TopoJSON / ASCII STL。Shiki、MathJax、Mermaid、Leaflet / TopoJSON、Three.js はローカル配布。
- ACP (Codex / OpenCode / GitHub Copilot / Claude Codeアダプター / 任意コマンド)、OpenAI Chat Completions、OpenAI Responses、Anthropic Messages、stream / cancel / test / error、OS 資格情報ストア。
- Agent / インラインの入力欄で接続先・モデル・推論強度を選び、ACP の公開候補と送信前の設定応答を検証する。Windows の接続でコンソール窓を表示しない。
- AI 送信対象の表示、質問 / 生成 / 選択 rewrite / workspace 修正、隔離コピーと diff 承認、revision 競合・却下・取消。
- Agent チャットは複数ターン、会話の切替、新規、再試行、取消、非表示中の保持に対応する。履歴は完了した会話だけを送り、接続先の変更で分離する。インラインチャットは選択または段落を対象に Ctrl+Shift+I / Cmd+Shift+I で開き、Vim の Ctrl+I と共存する。回答は共通 Markdown 描画を使う。
- Agent の使用量は通信で確認できたコンテキスト、トークン、費用、利用枠を区別して表示し、課金やクレジットを推計しない。取得できない値は取得不可として表示する。
- en-US / ja-JP と任意選択の ja-JP-x-kansai / ja-JP-x-tokushima に対応する。阿波弁は徳島県全域を対象とし、特定の市周辺に限定しない。言語切替は文書・選択・未保存状態・実行中の AI を保持する。表現と検証の方針は [言語と地域の表現](localization.md) に従う。
- Rust / TypeScript / Vitest / Playwright CI。AI モック、認証済みのみ実接続。Windows x64、macOS arm64 / x64、Linux x64 package と操作説明。
- 各 OS 実 WebView / IME の確認結果を区別する。未実施を成功と記載しない。署名 / 公証は資格情報がある場合のみ。

Wiki link、graph、cloud sync、extension market、GitHub 固有のユーザー参照 / 添付管理は後続。

## 再現可能な開発環境

Linux 用 devcontainer に Rust / Node / WebKitGTK / GTK / Neovim を用意する。Windows の WebView2、macOS の WebKit / IME は各 OS で検証する。
