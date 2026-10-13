# 固定ハッシュの Neovim 実行環境を丸ごと同梱する

- 状態: 採用
- 日付: 2026-10-07
- 関連: Issue #2、ADR-0001 / ADR-0003

## 背景と選択肢

ホスト PATH、実行ファイルだけの sidecar、公式 runtime 全体の同梱を検討した。PATH は版 / 設定が環境で変わり、実行ファイルだけでは runtime / DLL が欠落する。

## 決定と理由

[公式 Neovim 0.11.5](https://github.com/neovim/neovim/releases/tag/v0.11.5) の archive と release asset の SHA-256 を固定し、4 target の runtime 全体を同梱する。Node 標準 API / OS の tar を使い、cache も展開前に検証する。cleanup は作業ディレクトリの子に限定する。Rust が Tauri resources mapping の neovim/ を解決する。純粋な契約テストはダウンロード不要だが、Neovim 統合テストには配布資源を準備する。版更新では manifest / hash / native smoke を一緒に更新する。

## 結果と制約

DLL / runtime / archive 内ライセンスを保持するため容量は増える。初回はネットワークが必要、検証済み cache は再取得しない。Linux / devcontainer は x64 のみ。署名 / 公証には別途資格情報が必要。

## 確認方法

Node tests で hash 不一致、OS 解決、cleanup 制限を確認する。native smoke は実 Neovim を起動し固定版、Markdown runtime、日本語・絵文字 buffer を確認する。package / 実機起動は別途確認し、未実施を成功としない。
