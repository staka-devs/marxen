//! SQLite-backed database views through rusqlite.

use crate::application::ports::TableStore;
use crate::contracts::{DatabaseColumn, DatabaseEdit, DatabaseRow, DatabaseTable, WorkspaceError};
use crate::domain::database::sqlite_identifier;
use rusqlite::{types::ValueRef, Connection};
use std::collections::BTreeMap;
use std::path::Path;

/// Native SQLite table store; each call opens its own short-lived connection.
pub struct SqliteTables;

/// Map a SQLite failure to the workspace error shown by the view.
fn io(error: rusqlite::Error) -> WorkspaceError {
    WorkspaceError::Io {
        detail: error.to_string(),
    }
}

/// Open the file and create a starter table so a new view has somewhere to put rows.
fn open(file: &Path, table: &str) -> Result<(Connection, String), WorkspaceError> {
    let quoted = sqlite_identifier(table)?;
    let connection = Connection::open(file).map_err(io)?;
    connection
        .execute_batch(&format!(
            "CREATE TABLE IF NOT EXISTS {quoted} (id INTEGER PRIMARY KEY, title TEXT)"
        ))
        .map_err(io)?;
    Ok((connection, quoted))
}

/// Render one stored value as the text a cell shows.
fn cell(value: ValueRef<'_>) -> String {
    match value {
        ValueRef::Null => String::new(),
        ValueRef::Integer(n) => n.to_string(),
        ValueRef::Real(n) => n.to_string(),
        ValueRef::Text(text) => String::from_utf8_lossy(text).into_owned(),
        ValueRef::Blob(bytes) => format!("<{} bytes>", bytes.len()),
    }
}

impl TableStore for SqliteTables {
    /// Read columns from `table_info` and rows keyed by `rowid`.
    fn read(
        &self,
        file: &Path,
        table: &str,
        limit: usize,
    ) -> Result<DatabaseTable, WorkspaceError> {
        let (connection, quoted) = open(file, table)?;
        let mut info = connection
            .prepare(&format!("PRAGMA table_info({quoted})"))
            .map_err(io)?;
        let columns = info
            .query_map([], |row| {
                Ok(DatabaseColumn {
                    name: row.get::<_, String>(1)?,
                    editable: row.get::<_, i64>(5)? == 0,
                })
            })
            .map_err(io)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(io)?;
        let mut select = connection
            .prepare(&format!("SELECT rowid, * FROM {quoted} LIMIT ?1"))
            .map_err(io)?;
        let mut rows = Vec::new();
        let mut cursor = select.query([limit as i64 + 1]).map_err(io)?;
        while let Some(row) = cursor.next().map_err(io)? {
            let mut cells = BTreeMap::new();
            for (index, column) in columns.iter().enumerate() {
                cells.insert(
                    column.name.clone(),
                    cell(row.get_ref(index + 1).map_err(io)?),
                );
            }
            rows.push(DatabaseRow {
                id: cell(row.get_ref(0).map_err(io)?),
                cells,
                path: None,
            });
        }
        let truncated = rows.len() > limit;
        rows.truncate(limit);
        Ok(DatabaseTable {
            columns,
            rows,
            truncated,
        })
    }

    /// Insert, delete, update or add a TEXT column with bound values only.
    fn edit(&self, file: &Path, table: &str, edit: &DatabaseEdit) -> Result<(), WorkspaceError> {
        let (connection, quoted) = open(file, table)?;
        /// Parse a row id sent back by the view.
        fn rowid(id: &str) -> Result<i64, WorkspaceError> {
            id.parse().map_err(|_| WorkspaceError::NotFound)
        }
        match edit {
            DatabaseEdit::AddRow => connection
                .execute(&format!("INSERT INTO {quoted} DEFAULT VALUES"), [])
                .map(|_| ()),
            DatabaseEdit::DeleteRow { id } => connection
                .execute(
                    &format!("DELETE FROM {quoted} WHERE rowid = ?1"),
                    [rowid(id)?],
                )
                .map(|_| ()),
            DatabaseEdit::SetCell { id, column, value } => connection
                .execute(
                    &format!(
                        "UPDATE {quoted} SET {} = ?1 WHERE rowid = ?2",
                        sqlite_identifier(column)?
                    ),
                    rusqlite::params![value, rowid(id)?],
                )
                .map(|_| ()),
            DatabaseEdit::AddColumn { name } => connection.execute_batch(&format!(
                "ALTER TABLE {quoted} ADD COLUMN {} TEXT",
                sqlite_identifier(name)?
            )),
        }
        .map_err(io)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    /// Create a starter table, then add, edit, widen and delete rows.
    fn edits_a_starter_table() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("tasks.sqlite");
        let store = SqliteTables;
        let empty = store.read(&file, "タスク", 10).unwrap();
        assert_eq!(empty.columns.len(), 2);
        assert!(!empty.columns[0].editable);
        store.edit(&file, "タスク", &DatabaseEdit::AddRow).unwrap();
        store
            .edit(
                &file,
                "タスク",
                &DatabaseEdit::AddColumn {
                    name: "状態".into(),
                },
            )
            .unwrap();
        store
            .edit(
                &file,
                "タスク",
                &DatabaseEdit::SetCell {
                    id: "1".into(),
                    column: "状態".into(),
                    value: "完了".into(),
                },
            )
            .unwrap();
        let table = store.read(&file, "タスク", 10).unwrap();
        assert_eq!(table.rows[0].cells["状態"], "完了");
        assert!(store
            .edit(
                &file,
                "タスク",
                &DatabaseEdit::SetCell {
                    id: "1".into(),
                    column: "x\" = 1; --".into(),
                    value: "".into(),
                },
            )
            .is_err());
        store
            .edit(&file, "タスク", &DatabaseEdit::DeleteRow { id: "1".into() })
            .unwrap();
        assert!(store.read(&file, "タスク", 10).unwrap().rows.is_empty());
    }
}
