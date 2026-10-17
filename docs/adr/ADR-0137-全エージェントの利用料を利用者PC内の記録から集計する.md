# ADR-0137-全エージェントの利用料を利用者PC内の記録から集計する

- 状態: 採用
- 日付: 2026-10-17
- 関連 Issue: #59（Agent ごとの実測使用量ポップアップ）、#103（全AIプロバイダーのアカウント管理と使用量）

## 背景

使用量ポップアップは Codex の利用枠（公式 RPC）と ACP 通信中の報告だけを表示し、Claude / OpenCode / Copilot / Devin の実績は通信が報告しなければ現れない。利用者から「Codex しか出てこない」との指摘があった。Orca の実装（インストール済みアプリコードを読み取り専用で確認）では、各 CLI が利用者 PC に残すセッション記録（Codex rollout JSONL、Claude projects JSONL、opencode.db、Copilot session-state 等）を走査してトークンとコストを集計している。

## 検討した選択肢

1. 各プロバイダーの残量 API を増やす。Copilot の個人 quota 取得は公開手段がなく、素の OpenCode の使用量 API は文書化されていない。調査の結果、どちらも安定手段なしと確定したため不採用。
2. OpenCode に Cookie 欄を足して console 経由で取得する。`/console/api/go/status` は Go 契約専用の形状で、素の OpenCode 契約の値は返さないことが判明した。起動に使う auth.json と共存できない保管形式の問題もあり不採用。
3. 利用者 PC 内のセッション記録を読み取り専用で走査し、実測トークンとコストだけを集計する。残量・上限・課金額の推計はしない。 Orca と同じ方式であり、quota API の有無に依存しない。採用。

## 決定と理由

- セッション記録の走査は読み取り専用・上限付き（件数・バイト・行数）で行い、資格情報・本文・パスは IPC に出さない。集計するのは報告済みの数値（トークン数・コスト）のみで、本文からの推計はしない。
- 記録に対応する数値がない提供元（Copilot の events.jsonl 等）は「取得不可」として表示し、ゼロ埋めや推計をしない。Devin 等の保存形式が未確認の提供元は対象外として理由を示す。
- 対象は Codex（rollout JSONL の token_count 累積）、Claude（assistant 行の usage 合算）、OpenCode（opencode.db の session / session_v2 の tokens と cost）とする。`.zst` 圧縮物は展開せず対象外とする。
- 実接続の検証は行わない。利用者の実データでの確認は、設定画面と使用量ポップアップの表示で行う。

## 結果・制約

- AI IPC に transcript 集計の型と `ai_transcript_usage` 命令を追加する（AI スキーマ版を 7 から 8 に上げる）。
- 走査はローカル OS の既定保存先のみを対象にし、WSL や任意パスの指定は受け付けない。
- 未実施の検証として残るのは、各 OS の実保存先での集計結果の目視確認である。

## 確認方法

- 人工 fixture による Rust 単体検証（JSONL 行・SQLite 行の集計、上限、壊れた行の無視）。
- `npm run ai-contracts:check`、`npm run typecheck`、`npm run test:unit`、`npm run architecture:check` の成功。
- 実データでの表示確認は利用者が行い、結果を検証報告へ記載する。
