# ADR-0146-Gitの変更をソース管理ビューで表示する

- 状態: 採用
- 日付: 2026-10-21
- 関連 Issue: #121
- 置換元: なし

## 背景

変更の Git 差分を確認できず不便だった。VS Code のソース管理ビューに相当する確認手段が求められている。

## 検討した選択肢

1. libgit2 等のライブラリを同梱する。依存とビルド時間が増え、利用者の Git 設定（改行・除外）と結果がずれうるため不採用。
2. 利用者がインストールした `git` CLI をシェルなしで実行する（採用）。結果は利用者の端末での `git status` / `git diff` と一致する。
3. 未保存のバッファとの差分も出す。正本は Neovim だが、Git が見ているのはディスクなので、今回は作業ツリー（保存済み）と HEAD の差分に限る。

## 決定と理由

- 活動バーに「ソース管理」を追加し、ワークスペースのルートごとにブランチと変更ファイル（変更・追加・削除・名前変更・競合・未追跡）を一覧する。行を開くとその差分を色分けして表示し、ファイルを開く操作も置く。
- 文書の保存（未保存フラグの変化）で一覧を読み直す。手動の再読み込みも置く。
- Rust: `domain/git`（porcelain 解析とパス検証）、`application/source_control`（`SourceControl` port と差分ユースケース）、`infrastructure/git`（`NativeGit`）、`presentation/source_control`（`git_status` / `git_diff`）。ルートは登録済みのワークスペースからだけ解決し、任意のフォルダーは照会しない。
- リポジトリ設定由来のプログラムを動かさない: `core.fsmonitor=false`、`--no-ext-diff`、`--no-textconv`、`GIT_LITERAL_PATHSPECS=1`、`GIT_OPTIONAL_LOCKS=0`。差分パスは `..`・絶対パス・ドライブ・バックスラッシュを拒否する。差分は 1MiB で打ち切る。
- 契約 `GitChange` / `GitStatus` を文書契約に追加し、生成器で TypeScript を更新する。

## 結果・制約

- `git` が PATH にない場合は案内文を表示する。Git 管理外のフォルダーは「Git リポジトリではありません。」と表示する。
- ステージ・コミット・破棄などの書き込み操作は持たない（表示のみ）。
- 未保存の変更は保存するまで一覧と差分に反映されない。

## 確認方法

- `cargo test`: `domain::git`（porcelain 解析・パス拒否）と `tests/source_control.rs`（実 Git の一時リポジトリで変更・未追跡の一覧と差分、管理外フォルダー）。Linux コンテナ（wslc）で実施。
- `npx vitest run src/presentation/workspace/SourceControlPanel.test.tsx`。
- `npm run contracts:check` 相当（生成結果と一致を確認）。Windows / macOS の実 Git・実デスクトップでの表示は未実施。
