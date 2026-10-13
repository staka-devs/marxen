# Rust の型から共通 IPC 契約を生成する

- 状態: 採用
- 日付: 2026-10-07
- 関連: Issue #2、ADR-0001 / ADR-0002

## 背景と選択肢

両言語の手書き型、別正本の JSON Schema、Rust からの生成を検討した。手書きは enum / revision のずれを生み、別 schema は二重管理を増やす。

## 決定と理由

serde / ts-rs の Rust 型から TypeScript を生成する。ID はパスと独立した ASCII ID、revision / offset は JSON に安全な u32。原文全体の UTF-16 code unit と UTF-8 byte を別型にして明示的に変換する。範囲は半開区間、編集は同一 snapshot の昇順・非重複とする。古い revision、surrogate 中間、範囲外、同一位置の挿入を拒否する。save / cursor / mode も exact revision を使い、検証は純粋関数とする。

## 結果と制約

型変更時の生成とコミットが必要。revision 最大値はエラーとして扱う。原文の offset と表示列 / grapheme は分け、CRLF / 結合文字を正規化しない。IME / 表示座標は実 Neovim と各 OS の WebView で検証する。

## 確認方法

Rust tests と共通 JSON fixture で ID、revision、wire shape、Unicode、編集順序、save / cursor / mode を確認する。contracts:check、TypeScript、Vitest で生成型の整合性を検証する。
