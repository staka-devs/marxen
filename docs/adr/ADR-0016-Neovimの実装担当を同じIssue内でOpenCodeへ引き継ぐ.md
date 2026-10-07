# Neovim の実装担当を同じ Issue 内で OpenCode へ引き継ぐ

- 状態: 採用
- 日付: 2026-10-07
- 関連 Issue: #3、#7
- 置換元: [ADR-0014](ADR-0014-開発担当のモデルと実装境界を確認して並行委任する.md) の Issue #3 実装担当のみ

## 背景と選択肢

Issue #3 の Codex は sandbox helper の起動失敗と反復する承認待ちにより、実装に着手できず、変更なしの終了報告を返した。実行方法の修正を続ける方法と、同じ Issue の実装を利用可能な OpenCode に引き継ぐ方法を比較した。

## 決定と理由

既存 Run・Task・Issue #3 子ワークスペースを保持し、終了済み Dispatch を明示した retry として OpenCode へ引き継ぐ。実効 MuseSpark1.3 Contributor / Xhigh を確認してから委任する。Codex は仕様管理、レビュー、統合を引き続き担当する。モデルの代替や Claude Code の利用は行わない。

実 Neovim の文書 actor、Rust が編集・保存を所有する境界、revision 付き範囲編集、原文保持、各 OS の実 WebView / IME 検証の要件は継続する。AI 接続の修正は Issue #7 の別担当で並行し、文書 actor の所有ファイルには触れない。

## 結果・制約と確認方法

元担当の終了報告、checkout が変更されていないこと、Orca の retry 受付と実効モデルの証拠を作業ログへ残す。旧端末がユーザー操作により retained と判定される場合は強制終了しない。通信・ネイティブ操作の成功は、実施した検証結果でのみ判断する。

ADR の番号は並行担当の予約帯と調整し、本記録は coordinator の 0010–0019 帯を使用する。
