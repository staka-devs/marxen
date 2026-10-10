# ADR-0099: AI と隔離のデスクトップ接続を IPC 境界へ置く

- 状態: 採用
- 日付: 2026-10-09
- 関連 Issue: #15、#7、#8

## 背景

AI 通信と隔離管理のモジュールに Tauri のコマンド、共有状態の取得、ロック、タスク起動、画面へのイベント通知が混在していた。隔離コピーの解決・送信範囲の認可・実行中の pin はデスクトップ専用関数で組み立てられ、隔離テストは同じ手順を別々に呼んでいた。使用されない `StagingResolver` / `RejectingResolver` とテスト用の実装もあり、実際の認可入口を表していなかった。

## 検討した選択肢

1. 現在の配置を維持する。画面接続と実行規則の境界が曖昧なままになる。
2. Neovim、保存、HTTP、プロセスごとに新しい port と実装を設ける。単一の本番実装に対して型と配線が増え、文書正本や実行終了順序を変更する範囲が広い。
3. 既存の具体型を使い、デスクトップ接続を IPC へ置き、隔離実行の準備だけを共通入口にする。

## 決定と理由

選択肢 3 を採る。Tauri の AI・隔離コマンドと `IsolationState` は `ipc::ai` / `ipc::isolation` に置く。従来の `ai::*` / `isolation::*` のデスクトップ公開経路は re-export で維持し、IPC 名・引数・返却型・イベント名を変えない。

`IsolationManager::prepare_prompt_run` が隔離コピーの解決、登録した範囲と revision の認可、pin の取得を順に行う。解決または認可に失敗した時は pin を取得しない。IPC は Workspace、IsolationManager の順にロックし、この入口を呼ぶ。HTTP の接続先・資格情報の準備は pin の取得より前に行う。

実行の取消と終了を区別し、ACP 子プロセスの回収または HTTP stream の終了、pin 解放、終端イベント通知の順序を維持する。AI 出力は隔離コピーと承認済みの revision 付き範囲編集を通し、実 Neovim の文書正本を直接置き換えない。使用されない staging resolver の trait と実装、AI 側の重複パスガードは削除し、テストは実際の隔離ガードと管理入口を確認する。

## 結果と制約

画面接続の変更と隔離実行の規則を別の場所で扱い、本番とテストが同じ準備入口を使える。新しい port、汎用フレームワーク、Cargo 依存は加えない。

厳密な Clean Architecture の依存規則を全面的に満たす決定ではない。DocumentActor は具体的な NeovimSession と保存処理に依存し、Workspace と IsolationManager はファイルシステム処理を含み、AI transport は reqwest・OS keyring・プロセス管理に依存する。互換 re-export も外側の IPC を参照する。単一の実装と文書・保存・終了順序の契約を維持するため、この具体的な境界を採用する。

## 確認方法

Rust fmt、デスクトップ既定機能での AI・隔離・ライブラリの対象テスト、範囲不一致や異なる Workspace や存在しない隔離ディレクトリが pin を残さない回帰テスト、pin 解放前の承認・却下・取消拒否、遅延する子プロセスと HTTP の終了順序を確認する。実施結果は [検証報告](../reports/issue-15-backend-architecture.md) に記載する。各 OS の実 WebView / IME と認証済み接続の結果を、この検証から推定しない。
