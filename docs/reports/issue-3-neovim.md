# Neovim 接続の検証

Windows x64 / MSVC と同梱した実 Neovim 0.11.5 で確認した。

| 検証 | 結果 |
| --- | --- |
| `npm run verify:neovim` | 版、Markdown runtime、日本語・絵文字のバッファ操作が成功 |
| `cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --locked --test neovim --test neovim_runtime` | 14 件成功。日本語・絵文字の座標、mapping、モード、grid、Undo、stale revision、保存要求、設定エラー、設定パス、終了検出 |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings` | desktop と全テスト対象が成功 |

Windows WebView2 / TSF、macOS WKWebView / NSTextInput、Linux WebKitGTK / IBus・Fcitx の実 IME は未確認。上記は headless Neovim の検証であり、各 OS の GUI・IME の確認を代替しない。

設計は [ADR-0020](../adr/ADR-0020-NeovimのembedRPCで文書編集を直列化する.md)、[配布資源・設定パス](../adr/ADR-0021-Neovimはアプリ配布資源から起動して設定パスを安全に渡す.md)、[保存経路](../adr/ADR-0022-Vimの保存は所有文書をRust経由で書き込む.md) を参照する。
