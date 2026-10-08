# Neovim 接続の検証

Windows x64 / MSVC と同梱した実 Neovim 0.11.5 で確認した。

| 検証 | 結果 |
| --- | --- |
| `npm run verify:neovim` | 版、Markdown runtime、日本語・絵文字のバッファ操作が成功 |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked` | Neovim 9 件、runtime 5 件、Vim 入力 9 件成功。日本語・絵文字の座標、mapping、モード、grid、Undo、stale revision、保存要求、設定エラー、設定パス、終了検出。キーを個別に送る `gg` / `diw` / macro / plugin 入力待ち / コマンドライン保存、global・buffer-local mapping の先頭キー、文字・行選択の半開区間と方向、排他的選択、矩形操作のUndo、入力待ちのサロゲート境界も確認 |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings` | desktop と全テスト対象が成功 |

Windows 実 WebView2 / Edge 154 では、Orca の Windows キー入力から日本語 IME の「にほん」→「日本」を変換した。未確定・変換中は Rust 正本と revision が不変、確定時は一度だけ編集され、一回の Neovim Undo で本文を復元した。未確定「か」の Esc 取消は本文・revision とも不変だった。ハードウェアのキー押下ではない。保存・設定ファイルの適用・実マッピングの確認は [UI 検証報告](issue-5-ui.md) に記載する。

macOS WKWebView / NSTextInput、Linux WebKitGTK / IBus・Fcitx の実 IME は未確認。headless Neovim と各 OS の native CI は実 GUI・IME の確認を代替しない。

設計は [ADR-0020](../adr/ADR-0020-NeovimのembedRPCで文書編集を直列化する.md)、[配布資源・設定パス](../adr/ADR-0021-Neovimはアプリ配布資源から起動して設定パスを安全に渡す.md)、[保存経路](../adr/ADR-0022-Vimの保存は所有文書をRust経由で書き込む.md) を参照する。
