# ADR-0135: Windowsスタンドアローン版にNeovim全資源を含める

- 状態: 採用
- 日付: 2026-10-16
- 関連: #102、#98

## 背景と決定

インストールせず利用できるWindows版も配布する。Neovimの実行ファイルとruntimeが必要なため、裸のexeだけでは動作する配布物にならない。

Windows CIで`Marxen.exe`と完全な`neovim/`を同梱した`Marxen_{version}_x64-portable.zip`を作る。ZIP展開後は同じフォルダーのexeから起動する。OSのWebView2 Runtimeを使用する。

## 結果・確認方法

既存5形式の配布物にスタンドアローンZIPを加え、6配布物すべてをSHA256SUMSとGitHubのアセットdigestで検証する。CIでZIPを再展開し、exe・Neovim実行ファイル・runtime・manifestの存在とハッシュを確認する。リリースは引き続きタグと同一コミットのmain CI成果物だけを使う。

各OSでの実起動・インストール・IMEはCIの梱包成功とは別の確認とする。
