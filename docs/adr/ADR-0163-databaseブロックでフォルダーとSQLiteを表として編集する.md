# ADR-0163-databaseブロックでフォルダーとSQLiteを表として編集する

- 状態: 採用
- 日付: 2026-11-10

## 決定

- Notion の Database に当たる表示を、Markdown の fenced block（言語 `database`）で文書に埋め込む。設定「データベース表示を有効にする」（`databases`、既定オフ）を有効にしたときだけ表として描画する。オフのときは有効にする方法を示し、ブロックの中身はそのまま残す。
- データ元は二種類から選ぶ。パスは文書のフォルダーから数え、`/` で始めるとワークスペース直下から数える。
  - `folder: tasks`：フォルダー直下の Markdown ノートを 1 行ずつ並べ、frontmatter のキーを列にする。正本は Markdown ファイルのままで、Git や Vim でそのまま扱える。
  - `sqlite: data/tasks.db`（`table:` 省略時 `items`）：ワークスペース内の SQLite ファイルの表を正本にする。ファイルや表が無ければ `id INTEGER PRIMARY KEY, title TEXT` の表を作る。
- 表の操作は、行の追加、セルの編集、列の追加、行の削除。編集は Rust が所有する。
  - フォルダー：開いているノートは Neovim のバッファへ revision 付きの最小範囲編集で書き、閉じているノートはディスクの指紋を確かめて原子的に書く。新しい行は `Untitled.md` を作る。列の追加は全ノートに空のキーを足す。行の削除は OS のごみ箱へ移し、開いているノートは削除しない。
  - SQLite：識別子は二重引用符で囲み、値はバインドで渡す。主キー列は表で編集しない。
- frontmatter は平らな `key: value` だけを読む。リストや入れ子は列にしない（`shortcut:` として記録）。
- 表は最大 1000 行まで返し、超えた分は「先頭 1000 行」と示す。
- 表のセルに入力したキー、IME、貼り付けは、エディターや Vim に渡さない。

## 確認方法

- `cargo test --features dev-tools --lib domain::database infrastructure::sqlite_tables`。
- `cargo test --features dev-tools --test workspace folder_database_reads_and_edits_note_properties`（開いたノートと閉じたノートの編集、行と列の追加、開いたノートの削除拒否、封じ込め）。
- `npx vitest run src/domain/database-block.test.ts src/presentation/database`。
- macOS / Linux の実機、IME 入力中の挙動は未確認。
