# Marxen 初期版の実装契約

ユーザー指定: Rust / Tauri v2、React / TypeScript / Vite / Tailwind / shadcn/ui、CodeMirror 6、同梱した実 Neovim を文書の正本にする。日本語 UI、ライブプレビュー、原文基準 Vim 操作を既定とする。

## 作業と担当

| 作業 | 担当 | 依存 |
| --- | --- | --- |
| Tauri 基盤・IPC・3 OS CI・devcontainer | Codex | なし |
| Neovim・IME・表示座標の技術検証 | OpenCode（Codex がレビュー・統合） | 基盤 |
| ワークスペース・保存・復元 | Codex | IPC |
| UI・ライブプレビュー・GUI 編集 | OpenCode | 技術検証 |
| GitHub 記法・地図・3D | OpenCode | 描画基盤 |
| ACP・直接 API・AI パネル | OpenCode | IPC |
| AI 変更の隔離・差分適用 | Codex | 保存 |
| 統合・回帰・配布 | Codex / OpenCode | 全機能 |

Orca で Issue ごとの子ワークスペースとブランチを管理し、依存順に統合する。OpenCode は **MuseSpark1.3 Contributor / Xhigh** の実効設定を確認してから起動する。指定モデルが利用できなければ OpenCode の担当は停止して報告し、別モデルへ自動変更しない。Claude Code を起動・委任・接続検証しない。Anthropic Messages API は独立した接続先として利用者の認証設定後に有効化する。

## 文書契約

Rust が Neovim RPC、保存、AI プロセス、HTTP を所有する。文書 ID・リビジョン付き snapshot、edit、save、cursor / mode 更新を共通契約とする。GUI / Neovim / AI の変更を直列化し、古い revision を拒否して再同期する。UTF-8 バイト位置と UTF-16 位置は明示的に変換する。`:w` を Rust 保存経路へ統一する。範囲編集で Markdown 原文を保持し、全体の再シリアライズを避ける。

## 受入条件

- 日本語 IME、絵文字、mapping 優先、モード切替、表示座標、GUI 編集と Vim Undo の共存を実 Neovim で検証する。
- ライブ / 原文 / 閲覧と分割表示で cursor / scroll / Undo を維持する。表示基準の縦移動・行頭末・選択、原文基準の単語・text object・macro を扱う。
- vimrc / _vimrc / init.vim / init.lua を選択でき、エラーを表示する。専用設定が既定。画面依存 plugin 操作は Neovim 原文ビューで扱う。
- tree、tabs、quick open、全文検索置換、outline、command palette、テーマ、相対画像、画像貼付、外部変更、保存競合、クラッシュ復元。
- 共通 remark / rehype 基盤で GFM、highlight、5 Alerts、脚注、MathJax、Mermaid、HTML sanitize、GeoJSON / TopoJSON / ASCII STL。Shiki、MathJax、Mermaid、Leaflet / TopoJSON、Three.js はローカル配布。
- ACP (Codex / OpenCode / 任意コマンド)、OpenAI 互換 Chat Completions、Anthropic Messages、stream / cancel / test / error、OS 資格情報ストア。
- AI 送信対象の表示、質問 / 生成 / 選択 rewrite / workspace 修正、隔離コピーと diff 承認、revision 競合・却下・取消。
- Rust / TypeScript / Vitest / Playwright CI。AI モック、認証済みのみ実接続。Windows x64、macOS arm64 / x64、Linux x64 package と操作説明。
- 各 OS 実 WebView / IME の確認結果を区別する。未実施を成功と記載しない。署名 / 公証は資格情報がある場合のみ。

Wiki link、graph、cloud sync、extension market、GitHub 固有のユーザー参照 / 添付管理は後続。

## 再現可能な開発環境

Linux 用 devcontainer に Rust / Node / WebKitGTK / GTK / Neovim を用意する。Windows の WebView2、macOS の WebKit / IME は各 OS で検証する。
