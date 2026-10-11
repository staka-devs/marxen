# ADR-0040-Rustが文書の保存競合とクラッシュ復旧を管理する

- 状態: 採用
- 日付: 2026-10-07
- 関連 Issue: #4、#3、#5、#8

## 背景と選択肢

Markdown の BOM・改行・末尾空行を保ち、GUI と Vim の保存を同一の結果にする必要がある。
GUI に保存を任せる方法、Neovim の通常保存に任せる方法、Rust が保存と復旧を所有する方法を比較した。
正本を実 Neovim に統一する ADR-0001 と編集を直列化する ADR-0002 に従い Rust に統一する。

## 決定と理由

文書 ID ごとの実 Neovim アクターをワークスペースに保持し、範囲編集と保存を exact revision で検証する。
複数範囲の GUI 編集は一つの Lua RPC 内で Undo をまとめ、初期本文を Undo の下限にする。
BOM と CR を原文の文字として扱い、UTF-8 バイトへ戻す際に改行や末尾を追加しない。

`:w` と GUI は同じ fingerprint 検証・同期・置換を使う。
SHA-256 の内容値を保存基準にし、外部変更を検出したら上書きを拒否する。
一時ファイルは保存先と同じディレクトリに作る。
Unix は mode を引き継いで atomic rename とディレクトリ同期を行う。
Windows の既存ファイルは ACL と名前付きストリームを保つ ReplaceFileW を使い、
部分失敗に備えて元ファイルの退避先を確保する。
新規作成は no-clobber、リネームは hard link の no-clobber 作成と元名除去を使う。

外部変更を 500ms 間隔で通知し、本文を自動で差し替えない。
未保存文書の再読込を拒否し、終了は save/discard/cancel を明示する。
編集を読み戻した後にアプリデータへ復旧記録を同期する。
復元は元の fingerprint を保持し、クラッシュ後のディスク変更を通常保存と同じ競合にする。
保存成功、保存済み本文への Undo、明示的破棄で記録を除去する。

相対パスを検証し、リンクや外部 junction を通る経路を拒否する。
相対画像の親ディレクトリ参照も境界内に限る。
画像はラスター形式を転送し、貼付を revision 付き範囲編集にする。

## 結果と制約

未保存本文、保存失敗、外部変更を一つの契約で扱える。
hard link 非対応の保存先ではリネームを拒否する。
外部プロセスへの強制ロック、最終内容確認と OS 置換間の compare-and-swap は保証しない。
OS 置換後の同期失敗は未保存と復旧記録を維持してエラーを返す。
電源断時の保証は各 OS とファイルシステムに依存する。
設定変更は明示的 Neovim 再起動で Undo とモードを初期化する。
実 WebView/IME の結果を Rust またはブラウザの成功から推定しない。

## 確認方法

実 Neovim と一時ディレクトリでバイト比較、競合、書込失敗、外部変更、
未保存終了、プロセス終了からの復旧、Neovim 終了、封じ込め、Undo、画像を検証する。
Windows では保護された ACL と名前付きストリームも確認する。
実施結果と未実施範囲は [ワークスペース検証](../workspace-verification.md) に記載する。

参照: [tempfile persist](https://docs.rs/tempfile/3.27.0/tempfile/struct.NamedTempFile.html#method.persist)、
[ReplaceFileW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-replacefilew)。
