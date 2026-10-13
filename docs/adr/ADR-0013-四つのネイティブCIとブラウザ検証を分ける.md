# 四つのネイティブ CI とブラウザ検証を分ける

- 状態: 採用
- 日付: 2026-10-07
- 関連: Issue #2、ADR-0003

## 背景と選択肢

Linux container で全 OS 成功を扱う案、クロスコンパイルのみ、各 native OS / CPU を検討した。WebKitGTK / WebView2 / macOS WebKit と配布形式は異なり、container / Chromium は native WebView / IME の代替ではない。

## 決定と理由

Windows x64、macOS arm64・x64、Linux x64 の native runner で Rust test / check / clippy、型生成、TypeScript、Vitest、Playwright、実 Neovim smoke、未署名 package build を行う。Node 22.23.2 / Rust 1.99.0 と lock を使用する。Chromium E2E と native WebView / IME は分ける。desktop feature を外した契約 test は native test の代替ではない。devcontainer に GTK / WebKitGTK / Node / Rust / Neovim を用意し、package は CI artifacts に残して自動公開しない。

## 結果と制約

各 runner の実行と依存取得が必要。CI 設定の追加と CI 成功を区別する。未実施の実機・インストーラー・署名・公証・IME を成功としない。AI 認証は基盤に含めない。

## 確認方法

ローカルの結果 / 件数と未実施を報告に分ける。CI run / artifact の結果と、各 OS の実 WebView / IME の操作確認を別々に記録する。[runner labels](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) の CPU 区分も確認する。
