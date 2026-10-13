# ADR-0003: Linux開発環境をdevcontainerで再現する

- 状態: 採用
- 日付: 2026-10-07
- 関連: Issue #2, #9

## 背景

Tauri v2 の Linux ビルドは WebKitGTK / GTK 等の OS 依存パッケージを必要とする。ローカル環境と CI で Rust、Node、実 Neovim を同じ手順で準備できる必要がある。

## 決定

Linux 用 devcontainer に Rust、Node、WebKitGTK / GTK、Neovim と検証ツールを用意し、README に起動手順を記載する。依存ロックファイルと CI のプラットフォーム別ビルドで再現性を確認する。

Windows の WebView2 / IME、macOS の WebKit / IME は実 OS で別途検証する。コンテナのテスト成功を各 OS の実 WebView / IME の成功へ読み替えない。

## 結果

Linux のセットアップを再現できる。Windows / macOS 固有の検証と署名 / 公証は専用 runner と資格情報が必要で、実施状況を配布記録へ残す。
