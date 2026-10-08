# ADR-0092: 同梱シンタックスハイライト用の WebAssembly を CSP で許可する

- 状態: 採用
- 日付: 2026-10-08
- 関連 Issue: #6 / #9

## 背景と選択肢

[Shiki の標準エンジン](https://shiki.style/guide/regex-engines)は同梱した Oniguruma の WebAssembly を使用する。配布版の CSP はローカルの script を許可するが、WebAssembly のコンパイルは別に許可する必要がある。JavaScript エンジンへの変更も可能だが、標準エンジンの構文互換性を維持する。

## 決定と理由

配布版の CSP は `script-src 'self' 'wasm-unsafe-eval'` とする。[CSP の WebAssembly 規則](https://www.w3.org/TR/CSP/#wasm-unsafe-eval)により WebAssembly のコンパイルを許可する。JavaScript の `eval` / `Function` と外部 script の実行は許可しない。構文・テーマ・エンジンはすべてローカルに同梱する。

## 結果・制約と確認方法

製品ビルドに実際の CSP を HTTP header として適用し、Shiki・Mermaid・数式の描画と JavaScript の動的コード実行の拒否を E2E で確認する。実配布アプリでは各 OS の WebView を別途確認する。Chromium の成功を他 OS の WebView の成功とは扱わない。
