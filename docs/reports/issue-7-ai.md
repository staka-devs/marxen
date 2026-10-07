# AI 接続の検証

Windows x64 / MSVC で確認した。

| 検証 | 結果 |
| --- | --- |
| `cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --locked --test ai` | 18 件成功。ローカル SSE サーバー、独立 ACP mock、取消・timeout・巨大行・権限拒否・接続失敗 |
| `MARXEN_NATIVE_KEYRING_TEST=1 cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --locked --test credentials_native` | Windows Credential Store で保存、別インスタンスからの取得、削除を確認 |
| OpenCode v2.0.24 の実接続 | `initialize` と `session/new` が成功。プロンプトは未送信 |

実 CLI のテストは `MARXEN_REAL_ACP_BIN` / `MARXEN_REAL_ACP_ARGS` が指定された場合だけ実行する。通常のテスト成功は実接続の成功を意味しない。

実 API への生成要求、macOS / Linux の OS ストア、各 OS の実 WebView からの AI 操作は未確認。mock や Windows の確認結果から成功を推定しない。
