# プロバイダーアカウント

設定 → AI 接続の「プロバイダーアカウント」でプロバイダーと認証スコープを選ぶ。「アカウントを追加」で名前・接続先・認証情報を保存し、「使用するアカウント」で選択する。保存だけでは現在のアカウントを変更しない。空の認証入力は既存の秘密値を維持する。MiniMax / OpenCode Go は API キーと Cookie を独立して入力し、保存済みの欄を削除する checkbox を明示的に選べる。API キーが優先され、その失敗時に Cookie へ自動切替しない。秘密値を再表示する機能はない。削除確認後は対象アカウントの秘密値・私有ファイルを削除し、その選択をシステム既定へ戻す。

秘密値は Rust と OS 資格情報ストアで扱う。フロントエンドの localStorage、metadata JSON、使用量の応答、エラーには含めない。OS ストアを利用できない場合は保存失敗を表示し、平文保存へ切り替えない。「認証状態を確認」は存在確認であり、サーバーの認証検証ではない。

## 入力と対応範囲

| プロバイダー | 管理アカウントの入力 | 使用量取得 | 管理 CLI 起動 |
| --- | --- | --- | --- |
| Codex | `auth.json` JSON (`tokens.access_token` または `OPENAI_API_KEY`) | 既存の公式 `account/rateLimits/read` RPC。実測 quota window のみ | Unix / Windows 私有 `CODEX_HOME`、file credential store |
| Claude Code | `.credentials.json` JSON (`claudeAiOauth.accessToken`) | 固定 OAuth usage endpoint、five_hour / seven_day の utilization | Linux / Windows 私有 `CLAUDE_CONFIG_DIR`。macOS Keychain 未対応 |
| OpenCode | `auth.json` JSON | サービス横断のアカウント利用枠 API は未対応 | Unix / Windows 私有 HOME / XDG data/config/state/cache |
| Devin | 公式 `credentials.toml` の内容 | CLI 利用枠 API は未対応 | 私有 HOME / XDG data、Windows は私有 APPDATA |
| Gemini CLI legacy | `oauth_creds.json` JSON (`access_token` / `refresh_token`)、任意 project ID | Google Code Assist の model 別 `remainingFraction` | この設定からの CLI 起動は未対応 |
| Antigravity | 認証設定 JSON を保存可能 | 安全な adapter 未対応。CLI に `/usage` prompt を送らない | 未対応 |
| OpenCode Go | API key と完全な console Cookie ヘッダー。workspace ID は空欄で検出 | API key の usage endpoint、または console go/status の比率 | 使用量設定のみ |
| MiniMax | API キー（Subscription Key）と完全な Cookie ヘッダーを別々に入力。region / group ID / models も保存 | key は token_plan、Cookie は regional coding_plan endpoint の model 別 remaining percent | 使用量設定のみ |
| Grok | 既存 `~/.grok/auth.json` を読取り、または同じ issuer entry の JSON を管理保存 | 固定 CLI billing endpoint の `creditUsagePercent` | 使用量設定のみ |
| Cursor | 既存 CLI / IDE ログインを読取り。管理アカウントには手動 Cookie も保存可能 | 固定 usage-summary endpoint の plan / onDemand | 使用量設定のみ |
| GLM Coding Plan | Coding Plan API key | 固定 monitor endpoint の reported limits | 使用量設定のみ |

システム既定の資格情報 reader は Codex、Claude のファイル方式、OpenCode、OpenCode Go、Gemini legacy、Grok の既知のファイルと Cursor の検証済み CLI / IDE 保存先を対象にする。その他の方式・macOS の Claude Keychain を「認証なし」と断定しない。対応する保存先に資格情報がなければ、他方式は未確認であると表示する。CLI の通常のシステム既定起動は環境を変更しない。Devin は公式の既定 credentials.toml の存在を確認でき、管理ファイルも独立した子プロセスで使用する。使用量取得は未対応である。Devin のシステム既定起動は可能だが、この設定画面からの独立した認証・使用量確認は未対応である。

WSL は distribution ごとに metadata・選択を分ける。現在は WSL bridge がないため認証確認・使用量取得・起動は拒否し、ローカル OS の資格情報を流用しない。Windows の管理 CLI 私有ファイル起動も未対応である。資格情報の保存と HTTP adapter は、この起動制約とは別である。

Gemini の refresh は保存 JSON に `client_id` / `client_secret` がある場合だけ、`https://oauth2.googleapis.com/token` へ送る。取得した access token はその使用量取得内だけで使用し、既定ファイル・保存秘密値を書き換えない。失効や token rotation で継続できなければ再ログインする。project がなければ既知の loadCodeAssist 応答から取得し、取得できなければ利用者へ project ID を求める。Google API key / Vertex AI の消費を Google ログインの利用枠へ換算しない。

MiniMax はグローバル `www.minimax.io` / 中国 `www.minimaxi.com` を選択する。Cookie 経路はそれぞれ `platform.minimax.io/v1/api/openplatform/coding_plan/remains` / `www.minimaxi.com/v1/api/openplatform/coding_plan/remains` へ送る。group ID は Cookie 経路の `X-Group-Id` に使用し、models は返された `model_name` の完全一致 filter とする。GLM は `api.z.ai` / `open.bigmodel.cn` / `dev.bigmodel.cn` を明示的に選べる。接続先は保存されるが、任意 URL・port・query・embedded credentials を追加することはできない。Cookie/Token のリクエストは redirect を追跡しない。

Claude / Gemini internal / OpenCode Go / Grok / Cursor / GLM の quota API は、公式の安定した公開 API として保証しない。既知の応答形式だけを読む adapter であり、変化すれば明確な取得失敗・未対応を返す。MiniMax の API-key 経路は公式 FAQ にある token_plan endpoint を使い、Cookie 経路は既知の regional console endpoint を使う。どちらも未確認の count 名から残量を推定しない。Codex の credit balance は percentage quota に変換しない。

## Cookie と既存ログイン

OpenCode Go の Cookie は、`auth` / `__Host-auth` / `__Host-console_session` の少なくとも一つを含む完全な Cookie header 値を入力する。`Cookie:` というヘッダー名の部分だけを除去し、それ以外の Cookie 名・値は維持する。特に `__Host-console_session=...` を `auth=...` へ書き換えない。API key が保存されている間は Cookie を送らない。

workspace を指定した場合は `GET https://opencode.ai/console/api/go/status` に `x-org-id` を付ける。空欄の場合は認証付き `GET https://opencode.ai/console` の SSR records / workspace links、または同一 origin の workspace redirect から ID を検出する。redirect 自体は追跡せず、外部 origin へ Cookie を送らない。検出候補は最大 8、usage の試行は最大 4、全体 15 秒以内である。console が JavaScript 側だけで workspace を取得するなど、応答に ID がない場合は明示 ID を求める。build 固有 `_server` function hash は固定しない。採用した workspace ID を使用量欄に表示し、複数 workspace の meter を合算しない。

Grok は `~/.grok/auth.json` の `https://auth.x.ai` またはその client scope の `key` / `user_id` を読む。first-party 以外の issuer の token や API-key auth の保存値を CLI session と見なさない。元ファイルの書込み、CLI 起動、token refresh を行わず、失効時は利用者自身の再ログインが必要である。

Cursor は次の保存先を読む。CLI file が存在する場合はそれを優先し、無効・失効している場合は IDE の別ログインへ自動切替しない。CLI file がない場合だけ IDE の固定 key を読む。macOS は両方にない場合に既知の Keychain service `cursor-access-token` / account `cursor-user` を読み取る。

| OS | CLI | IDE SQLite |
| --- | --- | --- |
| Linux | `$XDG_CONFIG_HOME/cursor/auth.json`、未指定なら `~/.config/cursor/auth.json` | 同じ config root の `Cursor/User/globalStorage/state.vscdb` |
| macOS | `~/.cursor/auth.json` | `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` |
| Windows | `%APPDATA%/Cursor/auth.json` | `%APPDATA%/Cursor/User/globalStorage/state.vscdb` |

CLI の `accessToken` または SQLite の `cursorAuth/accessToken` の JWT payload から、既知の subject と token を使って `WorkosCursorSessionToken` を形成する。署名検証や認証成功とは表示しない。SQLite は read-only で固定 SELECT だけを実行し、DB を作らず、ログイン状態を変更しない。ブラウザーの Cookie DB、refresh token、任意の認証 URL は扱わない。

管理資格情報は型付き `AccountCredentialPatch` の `secret`（上記 web provider 以外）、`apiKey` / `cookie`（MiniMax / OpenCode Go）のいずれかを送る。省略欄は維持、空文字は明示削除である。旧 raw API-key 格納形式の自動変換や、別名の保存 API は提供しない。

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
- [OpenCode providers](https://opencode.ai/docs/providers/)、[Go](https://opencode.ai/docs/go/)、[公式 console の workspace records](https://github.com/anomalyco/opencode/blob/v1.2.27/packages/console/app/src/routes/workspace-picker.tsx)、[公式 repository の go/status meter 説明](https://github.com/anomalyco/opencode/issues/50912)
- [Devin CLI](https://docs.devin.ai/work-with-devin/devin-cli)
- [Gemini CLI Code Assist request implementation](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/code_assist/server.ts)、[quota response types](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/code_assist/types.ts)
- [Antigravity](https://antigravity.google/docs/home)
- [MiniMax FAQ と token_plan endpoint](https://platform.minimax.io/docs/token-plan/faq)
- [Grok CLI authentication](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/02-authentication.md)、[Grok credential fields](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-login/src/model.rs)、[Grok storage](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-login/src/storage.rs)
- [Cursor CLI authentication](https://cursor.com/docs/cli/reference/authentication)、[Cursor usage dashboard](https://cursor.com/dashboard)、[rusqlite read-only flags](https://docs.rs/rusqlite/0.37.0/rusqlite/struct.OpenFlags.html)
- [GLM Coding Plan](https://docs.z.ai/devpack/overview)

公式リンクは利用者の設定・サービスの仕様の参照先であり、未公開 endpoint の安定性や今回の実接続成功を示すものではない。未公開 adapter の応答形式・完全な console Cookie / x-org-id header・Cursor の platform path / SQLite key はインストール済み Orca のアプリケーションコードを読み取り専用で確認し、人工 fixture へ転記した形式だけを対象にする。公式 console source は workspace record の形式、公式 OpenCode issue は現行 status route と meter の比率の裏付けであり、現行 console UI の SSR 安定性を保証しない。

## 検証

`tests/fixtures/provider-accounts/usage.json` は人工データであり、実アカウントの保存データではない。Rust テストは全 provider の登録・選択・削除、secret/metadata 失敗時の整合性、host/provider 境界、revision、既定ファイルの保護、私有ファイル権限と symlink 拒否、quota parser を検証する。loopback HTTP fixture は token/cookie の固定接続先、header injection、redirect 拒否、応答上限、エラー本文の非公開を検証する。UI fixture は全 11 provider の入力・保存・選択・削除・存在確認・対応する使用量操作、WSL、秘密値の消去、古い応答の破棄と非対応表示を検証する。

実アカウント通信、各 OS の実 WebView / OS ストア、Windows ACL / WSL bridge、macOS の Claude Keychain、実 CLI による独立アカウント起動は未検証である。Claude Code、その ACP adapter、OpenCode の起動・実接続検証は行わない。

### 初期実装の実施結果

- `npm run typecheck`: 成功。
- `npm run architecture:check` / `npm run localization:check`: 違反なし。
- `npm run test:unit`: 90 files / 713 tests 成功。その後に更新した account UI/IPC は targeted 17 tests で再検証。
- no-desktop Rust: library 117 tests、AI integration 26 tests、AI service 4 tests 成功。最終 account integration は 13 tests、固定 URL / 応答境界と browser launcher は 3 tests 成功。実 OpenCode handshake は明示的に除外。
- account contract generator の `--check`: 成功。
- no-desktop 全体テストは既存 `tests/contracts.rs:228` が desktop-gated `presentation::runtime` を参照してコンパイルできず、上記の対象を個別指定した。
- desktop `cargo check` は環境に `glib-2.0.pc` がないため未完了。実 WebView / ネイティブブラウザー・OS ストア / 実接続の成功を示すものではない。

Devin は公式の [認証ファイル配置](https://docs.devin.ai/cli/enterprise/devin-auth) と [ACP サブコマンド](https://docs.devin.ai/cli/acp/zed) を使用する。TOML は原文で保存し、意味の解釈は CLI に委ねる。

### 認証フロー拡張の実施結果

- 対象の UI / IPC 20 tests、Rust account integration 16 tests、native account adapter / security 11 tests が成功。
- `npm run typecheck`、`npm run architecture:check`（363 files / 3076 ops 違反なし）、`npm run localization:check`（849 keys / 62 files 違反なし）、account contract generator の `--check` が成功。
- `npm run test:unit` 全体 90 files / 716 tests 成功。no-desktop Rust library 126 tests、AI 27 tests、AI service 4 tests、`npm run test:bundling` 35 tests 成功。
- 人工 fixture は API-key precedence、Cookie の独立保存・削除と rollback、regional group/model、console workspace 自動検出と明示指定、header 名保持と外部 redirect 拒否、Grok issuer scoping、Cursor CLI 優先・SQLite TEXT/BLOB・上限・既存 DB 非変更、信頼済み parent alias と managed nested-link 拒否を検証。
- 実アカウント・実接続、macOS Keychain、各 OS の実 CLI / IDE sign-in と WebView は未検証。console 応答に workspace ID が現れない方式は明示 ID が必要。親が管理する Windows ACL と ACP 会話／起動環境の統合は本変更の対象外。
