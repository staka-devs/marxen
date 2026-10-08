# Issue #8 隔離コピーと差分承認 検証報告

## 検証対象の振る舞い

- 隔離コピーは選択抜粋のみを節形式で staging に置く (全文は `[0, len)` 単一選択のみ原文形式)。`manifest.json` は置かず、エージェント可視のメタデータは相対パス・範囲・コピー ID のみである。
- 送信要求は登録コピーとの完全一致 (同一文書集合・同一 revision・同一範囲・抜粋 exact 照合) を満たさない限り、ACP・HTTP とも副作用の前に拒否される。資格情報と endpoint の準備は pin より先に行い、欠落時は pin せずに失敗する。
- 実行端末イベント (`done` / `cancelled` / `error`) は settlement と pin release の後にちょうど一度だけ配信され、`started` と `chunk` は即時配信される。pin 中の承認・却下・取消は拒否され、取消要求だけでは実行は完了しない。
- 提案テキストの取り込みは質問を拒否し、単一範囲の書き換え・生成は exact 置換、workspace は構造化 patch (登録 scope との exact 一致) のみ受け付ける。
- 承認は native-ready preflight (`preflight_edits`: 入力待ち拒否・実ドリフト同期・revision と範囲の検証、本文と Undo は不変) を全件に行ってから適用し、適用-phase の失敗は文書毎の結果 (`ApproveResult`) と native Undo の best-effort ロールバックで報告してコピーを消費する。適用失敗の回帰検証は manager の明示設定 (`inject_apply_failure_for_tests`) で行い、preflight の厳格さは保つ。承認は buffer のみで、保存は共有保存契約が別途行う。
- 判断記録は `docs/adr/` の ADR-0080〜ADR-0084、仕様は `docs/isolation.md`。

## 実際に検証した範囲 (Windows x64、実 Neovim 0.11.5)

| 検証 | 結果 |
| --- | --- |
| cargo test --lib | 48 件成功 (終端イベントのゲート・構造検証を含む) |
| cargo test --test contracts | 11 件成功 |
| cargo test --test workspace | 21 件成功 |
| cargo test --test isolation | 26 件成功 (選択限定・鍛造拒否・全文条件・提案取り込み・最小適用と単一 Undo・BOM/CRLF 保持・未選択ファイル無視・隠れドリフトの preflight 拒否・明示設定の注入による適用失敗と部分結果・ロールバック・死 actor・pin と settlement 順序・遅延書き込み・panic 時の刈り取り先行・HTTP 遅延端末・準備失敗の非 pin・stale と disk 競合・OS 共通の相対パス、traversal と symlink・scope 完全一致) |
| cargo test --test ai | 21 件成功 (巨大行は Done 提案にならないことを、`Err` または `Ok`＋Error イベントあり＋Done なしのいずれかで判定) |
| cargo test --test vim_input | 9 件成功 |
| cargo clippy --all-targets -- -D warnings | 成功 |
| cargo fmt -- --check | 成功 |
| npm run contracts:check / ai-contracts:check / isolation-contracts:check | 成功 |
| npm run typecheck | 成功 |
| npm run test (Vitest) | UI・IPC の回帰が成功。全体の最終件数は統合検証報告を参照 |
| npm run build | 成功 (chunk size 警告あり) |
| npm run test:bundling | 3 tests 成功 |

## 未実施の範囲 (成功と記載しない)

- 各 OS の native CI と配布確認は [統合検証報告](issue-9-integration.md) に記載する。
- 実 CLI (Codex / OpenCode) との workspace prompt 送信。mock ACP 子プロセスと 127.0.0.1 の mock HTTP のみで検証した。
- 各 OS の実 WebView からの認証済み AI 生成。Windows のローカル ACP fixture による差分承認・適用・Undo は確認済みだが、実 provider の生成からは検証していない。
- 署名・公証。Windows の配布後 runtime 配置確認は統合検証報告を参照。
- `credentials_native` は環境変数指定時のみ実行する opt-in であり、既定では何も検証せずに通過する。Windows の実 OS ストアでは使い捨て entry を保存・再取得・削除した。利用者の API 資格情報は使っていない。
- 実電源断・ディスク容量不足、最終置換直前の競合、OS の部分失敗時の保証。staging は同一マシン上のコピーであり OS サンドボックスではない。
