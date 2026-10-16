# プロバイダーアカウント

設定 → AI 接続の「プロバイダーアカウント」でプロバイダーと認証スコープを選ぶ。「アカウントを追加」で名前・接続先・認証情報を保存し、「使用するアカウント」で選択する。保存だけでは現在のアカウントを変更しない。空の認証入力は既存の秘密値を維持する。秘密値を再表示する機能はない。削除確認後は対象アカウントの秘密値・私有ファイルを削除し、その選択をシステム既定へ戻す。

秘密値は Rust と OS 資格情報ストアで扱う。フロントエンドの localStorage、metadata JSON、使用量の応答、エラーには含めない。OS ストアを利用できない場合は保存失敗を表示し、平文保存へ切り替えない。「認証状態を確認」は存在確認であり、サーバーの認証検証ではない。

## 入力と対応範囲

| プロバイダー | 管理アカウントの入力 | 使用量取得 | 管理 CLI 起動 |
| --- | --- | --- | --- |
| Codex | `auth.json` JSON (`tokens.access_token` または `OPENAI_API_KEY`) | 既存の公式 `account/rateLimits/read` RPC。実測 quota window のみ | Unix / Windows 私有 `CODEX_HOME`、file credential store |
| Claude Code | `.credentials.json` JSON (`claudeAiOauth.accessToken`) | 固定 OAuth usage endpoint、five_hour / seven_day の utilization | Linux / Windows 私有 `CLAUDE_CONFIG_DIR`。macOS Keychain 未対応 |
| OpenCode | `auth.json` JSON | サービス横断のアカウント利用枠 API は未対応 | Unix / Windows 私有 HOME / XDG data/config/state/cache |
| Devin | 認証設定 JSON を保存可能 | CLI 利用枠 API は未対応 | 独立した CLI 認証 adapter 未対応 |
| Gemini CLI legacy | `oauth_creds.json` JSON (`access_token` / `refresh_token`)、任意 project ID | Google Code Assist の model 別 `remainingFraction` | この設定からの CLI 起動は未対応 |
| Antigravity | 認証設定 JSON を保存可能 | 安全な adapter 未対応。CLI に `/usage` prompt を送らない | 未対応 |
| OpenCode Go | Go API key | 固定 Go endpoint の rolling / weekly / monthly percent | 使用量設定のみ |
| MiniMax | Subscription Key（Token Plan / M Plan） | 固定 token_plan endpoint の model 別 remaining percent | 使用量設定のみ |
| Grok | JSON (`accessToken`、任意 `userId`) | 固定 CLI billing endpoint の `creditUsagePercent` | 使用量設定のみ |
| Cursor | `WorkosCursorSessionToken=...` を含む Cookie header 値 | 固定 usage-summary endpoint の plan / onDemand | 使用量設定のみ |
| GLM Coding Plan | Coding Plan API key | 固定 monitor endpoint の reported limits | 使用量設定のみ |

システム既定の資格情報 reader は Codex、Claude のファイル方式、OpenCode、OpenCode Go、Gemini legacy の既知のファイルを対象にする。その他の方式・macOS の Claude Keychain を「認証なし」と断定しない。対応する保存先に資格情報がなければ、他方式は未確認であると表示する。CLI の通常のシステム既定起動は環境を変更しない。Devin のシステム既定起動は可能だが、この設定画面からの独立した認証・使用量確認は未対応である。

WSL は distribution ごとに metadata・選択を分ける。現在は WSL bridge がないため認証確認・使用量取得・起動は拒否し、ローカル OS の資格情報を流用しない。Windows の管理 CLI 私有ファイル起動も未対応である。資格情報の保存と HTTP adapter は、この起動制約とは別である。

Gemini の refresh は保存 JSON に `client_id` / `client_secret` がある場合だけ、`https://oauth2.googleapis.com/token` へ送る。取得した access token はその使用量取得内だけで使用し、既定ファイル・保存秘密値を書き換えない。失効や token rotation で継続できなければ再ログインする。project がなければ既知の loadCodeAssist 応答から取得し、取得できなければ利用者へ project ID を求める。Google API key / Vertex AI の消費を Google ログインの利用枠へ換算しない。

MiniMax はグローバル `www.minimax.io` / 中国 `www.minimaxi.com`、GLM は `api.z.ai` / `open.bigmodel.cn` / `dev.bigmodel.cn` を明示的に選べる。接続先は保存されるが、任意 URL・port・query・embedded credentials を追加することはできない。Cookie/Token のリクエストは redirect を追跡しない。

Claude / Gemini internal / OpenCode Go / Grok / Cursor / GLM の quota API は、公式の安定した公開 API として保証しない。既知の応答形式だけを読む adapter であり、変化すれば明確な取得失敗・未対応を返す。MiniMax は公式 FAQ にある token_plan endpoint を使うが、未確認の count 名から残量を推定しない。Codex の credit balance は percentage quota に変換しない。

## ACP 組込み API

Rust の composition root `provider_account_service()` が作る `ProviderAccountService` と同じインスタンスを使う。

```rust
let environment = accounts.launch_environment(provider, &host)?;
// Include environment.identity in the conversation/session key.
for key in &environment.remove { command.env_remove(key); }
command.envs(&environment.set);
```

`AccountLaunchEnvironment` は非 Serialize であり、値を IPC・ログ・エラーへ出さない。システム既定は空の set/remove と provider/host の identity、管理アカウントは ID/revision を含む identity を返す。保存 revision が古い更新、存在しない ID、異なる provider/host の選択、秘密値のない管理アカウントを拒否する。元の session の環境を後から変更しない。

IPC は `provider_accounts_snapshot/save/select/delete/credential_present/usage/open_setup`。公式ページのリンクは desktop では固定 provider enum を Rust へ送り、OS の既定ブラウザーで開く。任意 URL や shell コマンドは受け付けない。TypeScript の port は `src/application/ai/provider-account-ports.ts`、具体 adapter は `src/infrastructure/tauri/provider-accounts.ts`。契約は `export-provider-account-contracts` で Rust から生成する。

## 参照先

- [Codex authentication](https://developers.openai.com/codex/auth/) と [app-server](https://developers.openai.com/codex/app-server/)
- [Claude settings と CLAUDE_CONFIG_DIR](https://code.claude.com/docs/en/settings)、[authentication](https://code.claude.com/docs/en/authentication)
- [OpenCode providers](https://opencode.ai/docs/providers/)、[Go](https://opencode.ai/docs/go/)
- [Devin CLI](https://docs.devin.ai/work-with-devin/devin-cli)
- [Gemini CLI Code Assist request implementation](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/code_assist/server.ts)、[quota response types](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/code_assist/types.ts)
- [Antigravity](https://antigravity.google/docs/home)
- [MiniMax FAQ と token_plan endpoint](https://platform.minimax.io/docs/token-plan/faq)
- [Grok](https://grok.com/)、[Cursor usage dashboard](https://cursor.com/dashboard)
- [GLM Coding Plan](https://docs.z.ai/devpack/overview)

公式リンクは利用者の設定・サービスの仕様の参照先であり、未公開 endpoint の安定性や今回の実接続成功を示すものではない。未公開 adapter の応答形式はインストール済み Orca のアプリケーションコードを読み取り専用で確認し、人工 fixture へ転記した形式だけを対象にする。

## 検証

`tests/fixtures/provider-accounts/usage.json` は人工データであり、実アカウントの保存データではない。Rust テストは全 provider の登録・選択・削除、secret/metadata 失敗時の整合性、host/provider 境界、revision、既定ファイルの保護、私有ファイル権限と symlink 拒否、quota parser を検証する。loopback HTTP fixture は token/cookie の固定接続先、header injection、redirect 拒否、応答上限、エラー本文の非公開を検証する。UI fixture は全 11 provider の入力・保存・選択・削除・存在確認・対応する使用量操作、WSL、秘密値の消去、古い応答の破棄と非対応表示を検証する。

実アカウント通信、各 OS の実 WebView / OS ストア、Windows ACL / WSL bridge、macOS の Claude Keychain、実 CLI による独立アカウント起動は未検証である。Claude Code、その ACP adapter、OpenCode の起動・実接続検証は行わない。

### 実施結果

- `npm run typecheck`: 成功。
- `npm run architecture:check` / `npm run localization:check`: 違反なし。
- `npm run test:unit`: 90 files / 713 tests 成功。その後に更新した account UI/IPC は targeted 17 tests で再検証。
- no-desktop Rust: library 117 tests、AI integration 26 tests、AI service 4 tests 成功。最終 account integration は 13 tests、固定 URL / 応答境界と browser launcher は 3 tests 成功。実 OpenCode handshake は明示的に除外。
- account contract generator の `--check`: 成功。
- no-desktop 全体テストは既存 `tests/contracts.rs:228` が desktop-gated `presentation::runtime` を参照してコンパイルできず、上記の対象を個別指定した。
- desktop `cargo check` は環境に `glib-2.0.pc` がないため未完了。実 WebView / ネイティブブラウザー・OS ストア / 実接続の成功を示すものではない。
