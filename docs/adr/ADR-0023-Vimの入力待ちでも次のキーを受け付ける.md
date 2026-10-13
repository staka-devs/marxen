# Vim の入力待ちでも次のキーを受け付ける

- 状態: 採用
- 日付: 2026-10-08
- 関連: Issue #3、Issue #5、ADR-0020

## 背景

`gg`、`diw`、mapping、macro、plugin の入力待ちは一つのキーでは完結しない。キーごとに同期の本文読み取りを待つと、次のキーを届けられなくなる。

## 決定と理由

UI attach 後のモード確認には `nvim_get_mode()` を使用する。入力待ちでも応答する fast API であり、`blocking` が真なら deferred API の本文・カーソル読み取りを行わない。[Neovim API の実行規則](https://neovim.io/doc/user/api/#api-fast)

`blocking` が真なら最後に確認した本文・revision・カーソルを返し、次のキーを同じアクターへ送れるようにする。入力が完結したら正本から読み戻し、本文が変わった場合だけ revision を増やす。API 読み取りが可能な operator 待ちは `state('moS')` で区別する。GUI・AI の範囲編集、保存、設定変更は、進行中の Vim 操作やコマンドライン入力があるなら即座に拒否する。待ちを解消するために勝手に Esc を送らない。

表示基準の操作でも、global と buffer-local の mapping・その先頭キー、および進行中の Vim 入力は Neovim を優先する。特殊キーは Neovim の termcode で比較する。原文基準の操作は実 Neovim の入力経路を使用する。

## 制約と確認方法

入力待ち中の表示は最後に確認した snapshot であり、未完結の入力による途中状態を編集の基準にしない。`src-tauri/tests/vim_input.rs` でキーを個別に送り、operator・mapping・macro・plugin 入力待ち・コマンドライン保存・拒否後の継続を同梱 Neovim で確認する。実 WebView のキー配送と IME は別に確認する。
