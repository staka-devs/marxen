# ADR-0080-AI変更の隔離コピーと差分承認をNeovim正本で行う

- 状態: 採用
- 日付: 2026-10-08
- 関連 Issue: #8、Epic #1
- 関連: ADR-0001 (実 Neovim 正本)、ADR-0002 (Rust 直列化)、ADR-0040 (保存競合と復旧)、ADR-0070 / ADR-0071 (AI 送信と ACP 境界)

## 背景

CLI AI (Codex / OpenCode / カスタム ACP) に原文ファイルを見せず、隔離コピーだけを cwd として渡し、モデル出力の反映は差分レビューを経て承認した範囲パッチのみとする。送信範囲の記録、却下・取消の無変更保証、base revision とディスク fingerprint の競合検出、安全なパスと symlink 扱いを Rust が所有する。

## 検討した選択肢

1. 隔離場所をワークスペース直下にする / OS 一時領域とアプリデータに置く。原文と混ざらないよう OS temp (`marxen-staging`) を既定とし、コピー毎に `copy_<hex>_<連番>` の専用ディレクトリを作る。デスクトップは単一の `IsolationManager` が全ワークスペースのコピーを保持し、各コピーが workspace root を記録して照合する。
2. エージェント出力をそのままファイルコピーで戻す / Neovim 範囲パッチで戻す。原文の正本は実 Neovim (ADR-0001) のため、承認は `DocumentActor::apply_edits` (`EditSource::Ai`) の単一全置換パッチで行い、共有の `validate_edit` で exact revision を検証する。ディスク書き込みは行わず、保存は既存の共有保存契約 (`save_document` / `:w`) に委ねる。
3. 承認前に原文を変更する / 承認まで原文とディスクを一切触らない。作成・差分は読み取りのみとし、却下・取消は staging 削除のみで actor に触れない。テストで原文・ディスクの exact 一致を検証する。
4. パス検証を workspace と別にする / 共有する。staging 解決は `guard_staging_path` (traversal・絶対・空 root の拒否) と symlink 検査 (各 prefix の `symlink_metadata` と canonical  containment) を行い、`storage::read_disk` の symlink 拒否と `storage::disk_fingerprint` の競合検出を再利用する。未知コピーは `NotFound`、非 Active は `InvalidPath`、逸脱は `OutsideWorkspace`、revision 不一致は `Contract(StaleRevision)`、ディスク変化は `Conflict` で拒否する。
5. 差分形式を外部 crate にする / 自前最小表示にする。依存を増やさず、行単位の prefix/suffix 共通部を除いた -/+ ブロックの unified 表示を行う。承認可否の判断に必要な changed / drifted (live revision が base と異なる) と文字数を付ける。

## 決定

- `src-tauri/src/isolation.rs` に `IsolationManager` を置く。`create_copy` は contexts の文書集合を重複排除し、各文書の live revision と要求 revision の一致を検証してから live buffer text を staging に書き、`manifest.json` に送信範囲 (document / revision / path) を残す。空 contexts は拒否する。
- `resolve` は Active なコピーのみを staging dir として返し、ACP の cwd (`ai_prompt_stream`) に渡す。`ai_prompt_stream` は `IsolationState` から解決し、未知は `staging_unresolved`、逸脱は `live_target_rejected` に写像する。JS が live パスを渡す経路はない。
- `diff` は staging と live buffer の比較のみで、live を変更しない。`approve` は全ファイルを事前検証 (revision 一致・disk fingerprint 一致) してから各変更ファイルを Ai 範囲パッチで適用し、成功後に staging を削除して Approved とする。部分適用は行わない。却下・取消は staging 削除のみで原文・ディスクを保持する。
- IPC は `isolation_create` / `isolation_diff` / `isolation_approve` / `isolation_reject` / `isolation_cancel` の 5 件とし、型は `src/shared/isolation-contracts.ts` を `ts-rs` で生成する (`isolation-contracts:generate` / `:check`)。エラーは既存 `WorkspaceError` を再利用し、新しい error enum を増やさない。
- AI パネル (`src/components/ai-panel.tsx`) に差分レビュー節を追加し、差分確認・承認・却下・取消を `src/lib/isolation.ts` 経由で呼ぶ。承認後は保存が別操作である旨を表示する。
- mock CLI (`mock-isolation-agent`) は staging 内のみに書き込み、traversal・絶対パス・symlink を拒否する。integration は実 Neovim actor と実 subprocess 経路で検証する。

## 結果・制約

- 原文の更新は承認済み範囲パッチ経由のみとなり、却下・取消・stale・disk 競合では原文とディスクが exact に残る。stale は再作成 (resync) で復帰する。
- 承認は buffer への適用であり、ディスクへの保存は共有保存契約が別途行う。workspace 切替時は `ensure_clean` により未保存の承認済み内容があると拒否される。
- staging root が symlink の場合や canonical containment に失敗した場合は `OutsideWorkspace` で停止する。最終置換直前の race や電源断時の保証は ADR-0040 の制約を引き継ぐ。
- 実 WebView / IME / 署名 / 配布 package、macOS / Linux native、実 CLI との prompt 送信は未実施であり、成功と記載しない。

## 確認方法

- `cargo test --test isolation` (9 件): staging 変更の live 非反映、却下・取消の exact 保持、承認の Ai パッチと共有保存、stale 拒否と resync、disk 競合、traversal・絶対・symlink 拒否、送信範囲不一致の stale、mock CLI subprocess 経路。
- `cargo test --no-default-features` の unit、Vitest (isolation 3 件 + AI パネル差分 2 件を含む 50 件)、`contracts:check` / `ai-contracts:check` / `isolation-contracts:check`、`typecheck`、`cargo fmt --check`、`cargo clippy -- -D warnings`。
- 未実施: 各 OS 実 WebView / IME、実 CLI との workspace prompt 送信、署名・公証・配布後の runtime 配置確認。
