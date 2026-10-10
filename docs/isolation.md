# AI 変更の隔離と差分承認

隔離コピーと差分承認の正本は Rust であり、エージェントは staging dir を cwd として起動し、live パスと未選択本文を受け取らない。JS が live パスを渡す経路はない。隔離はコピーであり OS サンドボックスではない。

## 基本契約

`isolation_create(contexts)` の contexts は `PromptContext` (document / revision / ranges / 抜粋) の配列。各文書は live revision との一致、範囲の昇順・非重複・サロゲート境界、抜粋と原文スライス連結の exact 一致を検証する。重複 context の revision 不一致と範囲重複は拒否する。空配列・16 件超は拒否する。戻り値は `{copyId, documents}` で、documents (文書・revision・範囲・全文条件) が正確な送信範囲である。

staging には選択抜粋のみを書く。範囲指定ファイルは `--- marxen-scope document=<id> range=[s, e) ---` の節形式 (ヘッダ + スライス + 改行 1 つ) とし、全文選択 (`[0, len)` の単一範囲) のみ原文ファイルをそのまま置く。staging に `manifest.json` は置かない。エージェント可視のメタデータは相対パス・範囲・コピー ID のみとし、workspace root の絶対パスは Rust 内部の登録に留める。

`isolation_diff(copyId)` は登録 scope 毎に基準スライスと staging 節を比較する読み取りのみで、live を変更しない。戻り値は `{documentId, path, range, baseRevision, liveRevision, drifted, changed, unified, stagingChars, liveChars}`。`drifted` は live が base から動いた (承認は要再同期) を示す。実行中の差分は古くなるため、実行完了後に取り直してから承認する。

`isolation_stage_proposal(copyId, proposal, mode)` は検証済み提案テキストを staging に取り込む。質問 (`ask`) は表示のみで拒否する。書き換え・生成は単一範囲の選択でのみ exact 置換する。workspace は `--- marxen-patch document=<id> range=[s, e) ---` の構造化 patch (scope との exact 一致、全文書では有効範囲、重複拒否) のみ受け付ける。不正・未知 ID・stale・範囲外は actionable な error で拒否する。patch 本文は行指向で、非空本文は 1 つの末尾改行を持つ。

`isolation_approve(copyId)` は全ファイルを native-ready preflight (`preflight_edits`: 入力待ち拒否・実ドリフト同期・revision と範囲の検証、本文と Undo は不変) で検証してから、登録 scope 内の置換のみを最小編集 (範囲毎・全文書は前後一致の単一編集) で Neovim actor に適用する。選択外バイト (BOM・CRLF・空白) を保ち、複数編集は一つの RPC で undojoin して文書毎に単一 Undo 段とする。未選択の staging 追加ファイルは無視する。承認は buffer への適用であり、ディスク書き込みは行わない。保存は共有の `save_document` / `:w` で行う。適用-phase の失敗は `ApproveResult` (文書毎の適用・revision・error・ロールバック有無と失敗) で返し、best-effort の native Undo ロールバックを行ってコピーを消費する。部分適用を all-or-nothing に見せない。

`isolation_reject` / `isolation_cancel` は staging 削除のみで、原文とディスクを変更しない。実行中 (pin 中) は拒否され、取消要求だけでは実行は完了しない。端末状態のコピーは忘却され、以降の解決は `not_found` となる。

## 送信の権威検証と実行固定

`ai_prompt_stream` は ACP と HTTP の両方で、生成・送信の副作用の前に staging 解決・`authorize_prompt`・pin を行う。`authorize_prompt` は現在の要求が登録コピーと完全一致すること (同一文書集合・同一 revision・同一範囲、抜粋 exact 照合) を求め、narrowing・文書の省略や追加・矛盾する重複は拒否する。選択の変更は新規コピーで行う。pin は子 reap・stream 完了の settlement 時にのみ release し、`ai_prompt_cancel` は触らない。資格情報と endpoint の準備は pin より先に行い、欠落時は pin せずに失敗する。`validate_prompt_request` は構造検証 (順序・件数・長さ) のみとし、原文超えの非ゼロオフセットも構造的には許容して権威検証に委ねる。

## コマンド

| TypeScript メソッド (`src/infrastructure/tauri/isolation-client.ts`) | Rust IPC | 引数・結果 |
| --- | --- | --- |
| createIsolatedCopy | isolation_create | contexts (`PromptContext[]`) → `IsolatedCopyInfo` |
| fetchIsolationDiff | isolation_diff | copyId (`string`) → `IsolationDiff[]` |
| stageProposal | isolation_stage_proposal | copyId, proposal (`ProposalText`), mode (`PromptMode`) → `StagedProposal` |
| approveIsolatedCopy | isolation_approve | copyId (`string`) → `ApproveResult` |
| rejectIsolatedCopy | isolation_reject | copyId (`string`) → void |
| cancelIsolatedCopy | isolation_cancel | copyId (`string`) → void |

型は `src/contracts/isolation-contracts.ts` (`IsolatedCopyInfo` / `IsolatedCopyDoc` / `IsolationDiff` / `ApproveResult` / `ApproveDocOutcome` / `StagedProposal`)。エラーは既存 `WorkspaceError` を再利用する。未知コピーは `not_found`、非 Active は `invalid_path`、逸脱・symlink は `outside_workspace`、非 Markdown は `not_markdown`、revision 不一致は `contract(stale_revision)`、ディスク変化は `conflict`、範囲・抜粋・提案の不整合と実行中の承認・削除は `io` (detail 付き)。stale・conflict では最新 snapshot に再同期し、コピーを再作成 (resync) してから承認する。

## ReviewPanel props (UI #5 連携)

```tsx
interface ReviewPanelProps {
  copyId: string | null;
  diffs: IsolationDiff[];
  outcomes: ApproveDocOutcome[];
  busy: boolean;
  message: string | null;
  status: string | null;
  proposalText: string | null;
  onFetchDiff: () => void;
  onStageProposal: (() => void) | null;
  onApprove: () => void;
  onReject: () => void;
  onCancel: () => void;
}
```

全フロー: `AiPanel` の `onProposal?: (proposal: ProposalText, sent: ContextSummary[]) => void` → application の staging service → `stageProposal(copyId, proposal, mode)` → `ReviewPanel` (差分確認・承認・却下・取消)。差分レビューは専用面 `ReviewPanel` (`src/presentation/review-panel.tsx`) で行う。画面は注入された isolation port を使い、transport を直接参照しない。

## UI 連携: 取り込み・pin・完了順序の exact 仕様

- 取り込みコマンド (HTTP・ACP 共通): `stageProposal(copyId, proposal, mode)` → invoke `isolation_stage_proposal` (`{copyId: string, proposal: {text: string, baseContexts: [{documentId, revision}]}, mode: "rewrite" | "generate" | "workspace"}`) → `{copyId, updated: string[], chars}`。`mode: "ask"` は拒否される (質問は表示のみ)。
- HTTP の生成・書き換え完了時: 単一文書・単一範囲のコピーでのみ `proposal.text` がその scope に exact 置換される。複数 scope・文書のコピーでは actionable error になる (workspace patch 形式を使う)。
- ACP の workspace 修正: エージェントは staging (cwd) を直接編集するため取り込みは不要だが、テキスト提案を staging に反映したい場合は workspace patch 形式で同コマンドを使う。patch ブロック形式: `--- marxen-patch document=<id> range=[s, e) ---` + 置換本文 (非空本文は末尾改行 1 つ)。範囲は登録 scope との exact 一致が必要 (全文書コピーでは文書内の有効範囲)。
- Active-copy pin: 実行開始時に Rust が自動で pin し、子 reap・stream 完了の settlement 時にのみ release する。pin 中の承認・却下・取消は `io` error (実行中) で拒否され、差分は取得できるが古くなる。`ai_prompt_cancel` は pin を触らない。
- 端末イベントの完了順序: `started` と `chunk` は即時配信し、`done` / `cancelled` / `error` は settlement と pin release の後にちょうど一度だけ配信する。共通の settlement 処理 (`settle_production_run`: 子の kill/reap → pin release → 端末一度配信 → 登録解除) を ACP・HTTP 両経路とテストが共有し、panic 経路も子を刈ってから unpin する。`done` を受けたら `fetchIsolationDiff` で取り直してから `approveIsolatedCopy` / `rejectIsolatedCopy` / `cancelIsolatedCopy` を呼ぶ。承認結果は `outcomes` の文書毎に表示し、失敗時は新規コピーで再同期する。適用-phase 失敗の注入は manager の明示設定 (`inject_apply_failure_for_tests`) のみで行い、製品経路は触らない。

## 保存、外部変更、復旧との関係

承認済みの未保存内容は通常の dirty として扱い、`ensure_clean` によるワークスペース切替拒否、`poll` の snapshot 通知、復旧記録の対象となる。外部変更・削除は既存の `external_change` と `reloadDocument` の契約に従い、承認前に disk が動いた場合は `conflict` で拒否する。画像・リネーム・検索置換の契約は変更しない。

## 安全なパスと symlink

staging 解決は `guard_staging_path` (traversal・絶対・空 root の拒否) と各 prefix の `symlink_metadata` 検査 (symlink・junction の拒否、canonical containment、ADS 迂回の拒否) を行う。mock CLI と mock ACP も同じ検査を行い、逸脱を非ゼロ終了・error 応答で拒否する。staging root 自体が symlink の場合は起動時に拒否する。文書本文に節ヘッダと同形の行があっても、登録 scope と一致しなければ fail-closed で拒否する。
