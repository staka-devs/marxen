# Marxen 統合検証・Windows 配布確認

検証日: 2026-10-10。配布ソース: `4e9ffcfe0fa191fcf422abedd969a10f4c5edcf5`。Windows x64 / MSVC、Node 22.23.2、Rust 1.99.0、Tauri 2.12、WebView2、Neovim 0.11.5。

## 検証結果

| 検証 | 結果 |
| --- | --- |
| TypeScript / architecture / production build | 成功。五層の依存と 1633/1633 操作の文書を検査、違反 0 |
| Vitest / Node | 40 ファイル / 243 件、Node 19 件成功 |
| Windows native Rust | 165 件成功。実 Neovim、保存、復元、隔離、loopback HTTP / ACP の回帰 |
| Rust fmt / check / Clippy / Rustdoc | 成功。Clippy と非公開操作を含む Rustdoc は warning 拒否 |
| 生成契約 | 文書・AI・隔離すべて一致 |
| Chromium E2E | 製品 12 件 / ライブ 17 件成功 |
| 実 Windows アプリ | NSIS 展開先から起動。編集・分割・設定・Agent・インライン・承認・一回の UI Undo を確認 |
| Word の通常貼付 | 実 Neovim のヤンク / F8 → OS clipboard → Word 16.0。画像二枚、表、日本語・絵文字を確認。以前の clipboard を復元、文書は保存しない |
| Linux frontend | 型・依存・文書・243 件・Node 19 件・build・E2E 29 件成功。native は開発依存不足 |

コマンドとソースの区別は [手動 CI](manual-ci.md) / [Linux](issue-16-linux-manual-ci.md)、画面と操作は [UI 検証](issue-17-ui.md)。Rust の 165 件には実 credentials / ACP の opt-in テスト各一件を含み、既定の早期 return を実認証成功に含めない。AI の実アプリ検証はローカル fixture で、外部アカウントの生成ではない。

## Windows 配布物

Word と Rust を確認したこの配布物は `.local/releases/windows/archive/Marxen_0.1.0_x64-setup-4e9ffcf.exe` に保存する。未署名 NSIS をインストールせず展開して確認した。最新 UI の配布物・画面・検証は [Issue #20 の検証](issue-20-ui.md) を参照する。

| 項目 | 値 |
| --- | --- |
| インストーラーサイズ | 15,806,088 bytes |
| インストーラー SHA-256 | `3e891addd3e7bdb672183fa2c5b9ddd5cfef10f9fe4f15dcdb8c0a51085f47cf` |
| 展開アプリ SHA-256 | `ff8ec048add1a982b600e1c962facdcbbc0c3ad18c25ebada0e04467a68b0c00` |
| Neovim 資源 | 2067 ファイル。ファイル集合・全 SHA-256 が配布元と一致 |
| 開発用バイナリー | 契約出力三種・ACP / 隔離 mock 二種を含まない |

展開アプリは build 出力と NSIS 識別子の三 bytes を除いて一致する。実プロセスの親子関係から、展開先の `neovim/bin/nvim.exe` を使うことを確認した。検証用文書には未保存の変更を残さない。

## 各 OS と未確認範囲

[Actions](https://github.com/staka-devs/marxen/actions/runs/38027095455) は四 target とも step 数 0。注釈はアカウントの支払い失敗または利用上限を示す。手動確認と Actions の成功を区別する。

この配布ソースの Windows 実 IME・OS キー注入によるショートカットは未確認。実 WebView のキーイベント・composition fixture の成功を OS IME の成功に置き換えない。メールへの画像入り貼付、Windows WebView2 の地図・3D、外部 AI provider の実認証・生成、macOS / Linux の実 WebView / IME、macOS native 回帰、Linux native 回帰・deb / AppImage、NSIS の実インストール・アンインストール、署名・公証、devcontainer build は未確認。

五層と SOLID・YAGNI・DRY のレビューは [TypeScript](issue-14-frontend-architecture.md) / [Rust](issue-15-backend-architecture.md)。静的な依存・文書検査と、設計原則の全面的な証明を区別する。
