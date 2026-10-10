# Rust バックエンドの設計レビュー

対象: `src-tauri/src/` と Rust の試験・生成補助。検証日: 2026-10-10。対象コミットと実行結果は [手動 CI](manual-ci.md) に記載する。

| 層 | 責務と実装 |
| --- | --- |
| `contracts` | 文書・AI・隔離の共有 DTO と TypeScript 型生成。副作用や OS 依存を持たない |
| `domain` | 文書 identity/revision/UTF-16、範囲の検証、ディスク fingerprint、対象ファイル規則、AI 設定・ACP envelope・SSE・提案・隔離 scope の純粋な規則 |
| `application` | [DocumentActor](../../src-tauri/src/application/document/mod.rs)、Workspace、IsolationManager、AiService。直列化、保存・Undo、scope 認可、pin、取消・終了通知を所有し、[port](../../src-tauri/src/application/ports.rs) と AI の port を利用する |
| `infrastructure` | 実 Neovim embed/RPC、原子的なファイル保存・回復・画像・staging guard、OS clipboard/keyring、ACP process、HTTP、task spawner。presentation を参照しない |
| `presentation` | Tauri command と状態。引数を共有型へ変換し application を呼び、結果・イベントを WebView へ返す。infrastructure を参照しない |

[lib.rs](../../src-tauri/src/lib.rs) が具体的 adapter と desktop state を組み立てる。旧 module 名の転送は置かず、試験と generator も canonical path を使う。

## SOLID・YAGNI・DRY

| 原則 | 確認した設計 |
| --- | --- |
| SRP | actor は正本と revision の直列化、buffer adapter は Neovim protocol、storage adapter は OS ファイル操作を所有する。AI use case は scope/credential/取消/終了順、transport は provider の通信を所有する |
| OCP | buffer、filesystem、credentials、transport、task spawner を composition で注入する。内側は具体的な Tauri・NeovimSession・reqwest client・OS keyring を参照しない。新しい provider 種別には共有契約と対応する protocol 分岐の変更が必要 |
| LSP | port はエラー・missing file・disk fingerprint・native Undo・process reap の契約を明記する。実 buffer、loopback HTTP、独立した ACP fixture と MemoryKeyring を使う回帰で確認する |
| ISP | FileReader、DocumentStorage、DirectoryStorage、WorkspaceStorage、StagingStorage に必要な操作を分ける。staging に live document の原子的保存操作を与えない。Buffer は actor が実際に利用する意味単位の操作で、汎用 RPC/Lua 呼出しを露出しない |
| DIP | domain/application の OS・Tauri・具体的 UI/adapter 参照と infrastructure/presentation の相互参照を自動検査する。path の存在確認も注入された filesystem port を通す |
| YAGNI | 未使用の resolver・shutdown helper・legacy facade と unused import を置かない。fixture 用 Ex command は `dev-tools` に限定し配布アプリに公開しない |
| DRY | GUI 保存と `:w` は同じ conflict-aware atomic saver を使う。scope 認可と pin の準備、terminal settlement、UTF-16 検証、共有契約を本番と試験で共有する |

## 維持する契約と検証

実 Neovim のバッファが正本であり、range edit は現在の revision と surrogate-safe な UTF-16 範囲を検証してから row/UTF-8 byte 座標に変換する。複数範囲は末尾から一つの native Undo entry として適用する。保存はディスク baseline と workspace containment を再確認し、成功後だけ dirty/recovery を清算する。

AI は captured scope を認可してから staging copy を pin する。credential/target の準備失敗では pin しない。取消は実行中 process を停止・reap し、pin 解放後に一度だけ terminal event を届ける。OS credential の service namespace は `dev.staka.marxen` を保ち、値を IPC・通知へ返さない。

接続テストと生成 stream の URL を区別する。AiService → NativeAiTransport の loopback 回帰は OpenAI の `GET /v1/models`、opt-in Anthropic の `POST /v1/messages`、通信なしの readiness と秘密値非公開を確認する。利用者アカウントや実 provider の認証は使わない。

手書きの公開・非公開・trait 操作・test helper・generator・build entry に Rustdoc を付け、依存・コメント検査と `cargo doc --document-private-items` の warning 拒否を行う。165 件の Windows Rust 回帰、fmt、check、Clippy、三つの生成契約照合で確認する。既定で早期 return する実 credentials / 実 ACP の opt-in テストは実接続の成功とは扱わない。

actor と Workspace は一つの authoritative registry の複数操作を協調する。層分離や port だけで SOLID の全面的な証明にはならないため、追加変更では revision・lock order・取消・保存の契約と実際に使われる境界をレビューする。
