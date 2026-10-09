# Issue #15 Rust バックエンド構造の監査

- 対象: `src-tauri/src` と関連する Rust テスト
- 基準: `556650dc846b798a279b7d6b922857808afcf89d`
- 日付: 2026-10-09
- 判断: デスクトップ接続の責務と隔離実行の準備を整理した。厳密な Clean Architecture と SOLID の全面準拠は未達。

## 修正した実証可能な問題

| 問題と証拠 | 変更と効果 |
| --- | --- |
| 基準版 `ai.rs::prepare_scoped_run` は Tauri State を受け取り、Workspace / IsolationManager のロックと `resolve` / `authorize_prompt` / `pin_for_run` を一緒に実装していた。認可・pin の組立てが desktop feature 内にあり、`tests/isolation.rs` の ACP 終了テストは同じ手順を独自に組み立てていた。 | [IsolationManager::prepare_prompt_run](../../src-tauri/src/isolation.rs) が具体型だけで解決 → 認可 → pin を実行する。[IPC アダプター](../../src-tauri/src/ipc/ai.rs) はロックとエラー変換を担当し、ACP 終了テストと新しい失敗・pin 寿命テストは同じ準備入口を呼ぶ。失敗前の pin や順序違いをテストできる。 |
| 基準版 `ai.rs` に Tauri コマンド、AppHandle による通知・共有状態取得・タスク起動が混在し、`isolation.rs` にデスクトップ状態とコマンドが置かれていた。 | 実装を [ipc/ai.rs](../../src-tauri/src/ipc/ai.rs) と [ipc/isolation.rs](../../src-tauri/src/ipc/isolation.rs) へ移す。AI transport・終了処理、隔離管理の実装には Tauri 操作を置かない。単なる巨大ファイルの均等分割ではなく、デスクトップ型と状態所有の境界に沿う。 |
| `StagingResolver` / `RejectingResolver` に本番 caller がなく、`tests/ai.rs::FixedResolver` と専用 assertion だけが使用していた。「production uses RejectingResolver」というコメントは現行の隔離経路と異なっていた。`ai::guard_staging_path` も本番 caller がなく、production の隔離ガードと重複していた。 | 使用されない trait / impl、重複する AI パスガードとそれだけの単体テスト、テスト専用実装を削除。[AI テスト](../../src-tauri/tests/ai.rs) の staging 準備は本番の `isolation::guard_staging_path` を使い、専用テストも traversal・絶対パス・未知コピーを実際のガード / IsolationManager で拒否する。 |

## 境界別の評価

| 境界 | 具体的な根拠 | 評価・残る制約 |
| --- | --- | --- |
| [contracts](../../src-tauri/src/contracts.rs) / [ai_contracts](../../src-tauri/src/ai_contracts.rs) / [validation](../../src-tauri/src/validation.rs) | `validate_edit` は文書 ID・base revision・UTF-16 範囲・重複を検証し、バイト範囲を返す。保存・RPC・OS・HTTP 呼出しはない。 | 純粋な検証と境界データは分離できている。ただし契約型が serde / ts-rs とアプリケーション内のモデルを兼ねており、独立したドメイン層ではない。 |
| [DocumentActor](../../src-tauri/src/document/mod.rs) | `ActorState` が Mutex 内に NeovimSession を所有する。`apply_edits` は同期後に revision / 範囲を検証し、末尾から `nvim_buf_set_text` を行い、同じ RPC 内の `undojoin` と再読出しで単一 revision / Undo を保つ。 | 正本と直列化の責務は明確。具体的な NeovimSession、rmpv の RPC 形式、保存・復元・rename と UI/grid/cursor を同じ actor が扱うため、厳密な SRP / DIP は未達。単一の本番 Neovim 実装を抽象化するための port は追加しない。 |
| 文書の保存 / [storage](../../src-tauri/src/storage.rs) | GUI 保存の `save` と `marxen:save-requested` 通知処理は同じ `save_locked` → `storage::atomic_write` へ入る。保存は disk fingerprint を再確認し、Neovim の acknowledgement 後に dirty と recovery を清算する。 | GUI と `:w` の二重の本番保存経路はない。storage は OS / fs アダプターとして機能するが、DocumentActor が concrete module を直接呼ぶ。既存の save / Undo / recovery の動作は変更していない。 |
| [Workspace](../../src-tauri/src/workspace.rs) | BTreeMap の DocumentActor 登録、`open_text_file` の disk 読出しと fingerprint 競合確認、一覧・検索・画像・recovery・poll を具体的に扱う。Tauri 型は使わない。 | アプリケーション側の組立てとファイルシステム操作を兼ねる。厳密な層分離や SRP の単一責務とは言えない。今回、登録・保存契約を再設計する根拠はなく、具体的な責務集中を残す。 |
| [AI transport](../../src-tauri/src/ai.rs) / OS 資格情報 | `run_acp_prompt` は argv で子プロセスを起動し、`run_http_prompt` は reqwest の stream を処理する。`AgentKeyring` に OsKeyring / MemoryKeyring の実装があり、`resolve_http_request` が HTTP 接続先と資格情報を pin より前に解決する。 | transport、validation、SSE / NDJSON parser、registry、keyring が一つのモジュールに残る。AgentKeyring は実装とテストの差替えに利用される既存の小さい interface。transport の全面的な DIP / SRP は未達。 |
| [IsolationManager](../../src-tauri/src/isolation.rs) | `create_copy` は文書の snapshot と登録範囲だけを使う。`authorize_prompt` は文書・revision・excerpt・範囲の完全一致を検証する。`approve` は全 actor を native preflight してから範囲適用し、部分失敗 / native Undo rollback の結果を返す。 | コピー管理、パスガード、diff / proposal、承認処理、契約型と fs の責務が集中している。Workspace / DocumentActor / storage に直接依存する。範囲認可・実 Neovim 正本・pin 契約を保つ具体的なアプリケーション境界とする。 |
| Tauri / [lib](../../src-tauri/src/lib.rs) / [ipc](../../src-tauri/src/ipc.rs) | lib が plugin / state / resource directory / invoke handler とイベント poll を構成する。IPC が Tauri State・AppHandle・ロック・画面通知を扱う。 | composition と adapter の配置は妥当。旧 `ai::*` / `isolation::*` 経路は互換 re-export で IPC を参照するので、ソース依存の向きが完全に内側へ統一されたわけではない。 |

## 原則別の結論

- **Clean Architecture:** 副作用のない validation、OS / RPC 実装、デスクトップ接続の境界は確認できる。アプリケーションは具体的な Neovim / storage / fs / reqwest に依存し、互換 facade は外側を参照するため、依存規則の全面準拠とは言えない。
- **YAGNI:** 使用されない staging resolver interface とテスト用実装を除去した。本番 caller のない AI 側の重複パスガードも除去し、隔離側の逸脱拒否を維持した。新しい port、汎用 DI、plugin framework、別の文書正本を導入していない。
- **DRY:** 隔離実行の準備は本番 IPC と ACP 終了テストで同じ入口を使う。保存は同じ production flow。本番 caller のない AI パスガードを除去して、production の isolation ガードに確認を集約した。残る重複として actor の初期化 / configure の Neovim 設定と複数の ID 検証がある。初期化の差異やエラー契約を確認せず機械的に統合しない。

| SOLID の原則 | 判定・根拠 |
| --- | --- |
| SRP | IPC の画面接続と隔離実行の準備を分離した。ただし DocumentActor、Workspace、AI transport、IsolationManager は上表の複数の責務を持つため、全面的には未達 |
| OCP | provider は明示的な enum / match で扱い、接続先追加には validation と adapter の分岐変更が必要。全面的には未達。未要求の plugin framework は追加しない |
| LSP | `AgentKeyring` の Memory / OS 実装は資格情報長の検証、未登録時の `None`、未登録の削除成功という同じ契約を持つ。mock の呼出しとエラー処理は回帰確認したが、今回の既定テストは全 OS の実ストアを操作せず、全面的な置換可能性の実証にはならない |
| ISP | 資格情報 interface は get / set / delete / has の利用する操作に限定。文書・AI・隔離の IPC 型を分離。一方 Workspace / DocumentActor の具体的な大きい API を利用側が参照するため、全面的な interface 分離は未達 |
| DIP | 資格情報は既存の `AgentKeyring` を介して差し替えられる。文書・隔離ユースケースは具体的な Neovim / storage / fs に依存し、互換 facade は外側の IPC を参照するため、全面的には未達 |

## 維持する契約

Tauri コマンド名、引数、返却型、`ai-stream` イベント、`ai::*` / `isolation::*` のデスクトップ公開経路を維持する。本番 caller のない StagingResolver / RejectingResolver / ai::guard_staging_path の Rust API は除去した。外部からこの未使用 API を直接使う場合は移行が必要で、全 Rust API の無変更を主張しない。IPC 契約型や Cargo 依存・設定、フロントエンドは変更していない。

実 Neovim を正本とする revision 付き範囲編集、GUI と Vim の共有 Undo、Rust 所有の保存と recovery、隔離された選択範囲、HTTP readiness を pin より前に確認する順序を維持する。`settle_production_run` は子プロセス回収 → pin 解放 → 終端イベント生成、adapter はその後に画面通知し registry を除去する。取消要求だけでは pin を解放しない。資格情報は Rust の OS keyring で扱い、画面へ返す `CredentialRef` は保有状態だけを含む。

設計判断は [ADR-0099](../adr/ADR-0099-AIと隔離のデスクトップ接続をIPC境界へ置く.md) に記録した。

## 実施した検証

Windows x64 の native Rust、既定の `desktop` feature、`CARGO_BUILD_JOBS=1` と `-j 1` で検証した。隔離テストは同梱対象の実 Neovim 0.11.5 (`x86_64-pc-windows-msvc`) を使用する。

| コマンド / 確認 | 最終結果 |
| --- | --- |
| `cargo fmt --manifest-path src-tauri/Cargo.toml` と `cargo fmt --manifest-path src-tauri/Cargo.toml --check` | 成功 |
| `cargo test --manifest-path src-tauri/Cargo.toml --test isolation --test ai --lib -j 1` | exit 0。library 47、AI integration 21、isolation integration 28、計 96 件が Cargo 上で成功、失敗 0 |
| `git diff --check` | 成功 |
| `rg` による staging resolver / 重複ガードの本番参照確認と、移動したコマンドの差分レビュー | resolver / AI 重複ガードを除去。production のガード、IPC 名・イベント名、送信 readiness と終了順序を維持 |

`MARXEN_REAL_ACP_BIN` は未設定。AI integration の実 ACP probe 1 件はテスト本体内の早期 return による成功であり、実接続の成功を意味しない。HTTP は loopback の mock、ACP は mock 子プロセス、資格情報は MemoryKeyring / mock 値を使用する。default desktop のコンパイルで従来の `ai::*` / `isolation::*` 経由の Tauri invoke 登録も型検査されるが、実 WebView の IPC 呼出しまで確認したわけではない。

新しい 2 件の隔離テストは、範囲を広げた要求・異なる Workspace・存在しない staging が pin を残さないこと、成功後の承認・却下・取消が実際の pin 解放まで拒否されることを確認する。既存の native Neovim による範囲適用・Undo・disk/revision 競合・部分 rollback・遅延した子プロセス・HTTP 終了・panic 時の回収テストも通過した。

## 統合検証と未確認の範囲

統合した `8eccced` で Windows native Rust 全 162 件、Clippy `-D warnings`、3 種類の TypeScript 契約出力比較、NSIS 生成を確認した。UI ソース `8150fa1` の Rust / Tauri ソースは `8eccced` と同じ。実 Windows WebView2 → Rust → ACP fixture の回答、範囲承認、実 Neovim の Undo も確認した。コマンドと実行対象は [手動 CI](manual-ci.md)、GUI と配布の証拠は [統合検証](issue-9-integration.md) / [UI 検証](issue-17-ui.md) に記載する。

認証済みの実 AI 生成、今回の実 OS 資格情報ストア / IME の再検証、macOS の native 回帰、macOS / Linux の実 WebView / IME は未実施。Linux の native コマンドは開発依存不足で assertion 前に停止した。native Neovim / mock transport の成功からこれらの成功を推定しない。
