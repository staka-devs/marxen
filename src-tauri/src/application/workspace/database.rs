//! Database views over a folder of Markdown notes or a contained SQLite table.

use super::Workspace;
use crate::application::document::DocumentActor;
use crate::application::ports::TableStore;
use crate::contracts::*;
use crate::domain::coordinates::utf16_len;
use crate::domain::database::{
    frontmatter_properties, set_frontmatter_property, validate_name, MAX_DATABASE_ROWS,
};
use crate::domain::storage;
use std::path::PathBuf;

impl Workspace {
    /// Read the rows a database view shows.
    pub fn database_query(
        &self,
        document_id: &str,
        source: &DatabaseSource,
        tables: &dyn TableStore,
    ) -> Result<DatabaseTable, WorkspaceError> {
        match source {
            DatabaseSource::Folder { path } => self.folder_table(document_id, path),
            DatabaseSource::Sqlite { path, table } => tables.read(
                &self.sqlite_file(document_id, path)?,
                table,
                MAX_DATABASE_ROWS,
            ),
        }
    }

    /// Apply one view edit and return the refreshed rows.
    pub fn database_edit(
        &self,
        document_id: &str,
        source: &DatabaseSource,
        edit: &DatabaseEdit,
        tables: &dyn TableStore,
    ) -> Result<DatabaseTable, WorkspaceError> {
        match source {
            DatabaseSource::Folder { path } => self.folder_edit(document_id, path, edit)?,
            DatabaseSource::Sqlite { path, table } => {
                tables.edit(&self.sqlite_file(document_id, path)?, table, edit)?
            }
        }
        self.database_query(document_id, source, tables)
    }

    /// Resolve a view path against the document folder, or the root with a leading `/`.
    fn view_path(&self, document_id: &str, path: &str) -> Result<String, WorkspaceError> {
        let mut base = match path.starts_with(['/', '\\']) {
            true => self.root.clone(),
            false => self
                .actor(document_id)?
                .path()
                .and_then(|p| p.parent().map(PathBuf::from))
                .ok_or(WorkspaceError::InvalidPath)?,
        };
        for segment in path
            .split(['/', '\\'])
            .filter(|s| !s.is_empty() && *s != ".")
        {
            base.push(segment);
        }
        let relative = storage::relative(&self.root, &base)?;
        self.storage.resolve(&self.root, &relative)?;
        Ok(relative)
    }

    /// Contain a SQLite file path and require a database extension.
    fn sqlite_file(&self, document_id: &str, path: &str) -> Result<PathBuf, WorkspaceError> {
        let relative = self.view_path(document_id, path)?;
        let extension = relative
            .rsplit_once('.')
            .map(|(_, e)| e.to_ascii_lowercase());
        if !matches!(extension.as_deref(), Some("sqlite" | "sqlite3" | "db")) {
            return Err(WorkspaceError::InvalidPath);
        }
        self.storage.resolve(&self.root, &relative)
    }

    /// Find the live actor for a root-relative path, so open notes are edited through Neovim.
    fn actor_for(&self, relative: &str) -> Option<&DocumentActor> {
        let target = self.root.join(relative);
        self.actors
            .values()
            .find(|actor| actor.path().is_some_and(|p| p == target))
    }

    /// Current note text: the live buffer when open, otherwise the file on disk.
    fn note_text(&self, relative: &str) -> Result<String, WorkspaceError> {
        if let Some(actor) = self.actor_for(relative) {
            return Ok(actor.snapshot().text);
        }
        let target = self.storage.resolve(&self.root, relative)?;
        let bytes = self
            .storage
            .read_disk(&target)?
            .ok_or(WorkspaceError::NotFound)?;
        storage::utf8_text(bytes)
    }

    /// Markdown notes directly inside the view folder, in name order.
    fn folder_notes(&self, document_id: &str, path: &str) -> Result<Vec<String>, WorkspaceError> {
        let folder = self.view_path(document_id, path)?;
        Ok(self
            .list(&folder)?
            .into_iter()
            .filter(|entry| entry.markdown)
            .map(|entry| entry.path)
            .collect())
    }

    /// One row per note with its frontmatter properties as cells.
    fn folder_table(&self, document_id: &str, path: &str) -> Result<DatabaseTable, WorkspaceError> {
        let notes = self.folder_notes(document_id, path)?;
        let truncated = notes.len() > MAX_DATABASE_ROWS;
        let mut columns: Vec<DatabaseColumn> = Vec::new();
        let mut rows = Vec::new();
        for note in notes.into_iter().take(MAX_DATABASE_ROWS) {
            let properties = frontmatter_properties(&self.note_text(&note)?);
            for (key, _) in &properties {
                if !columns.iter().any(|c| &c.name == key) {
                    columns.push(DatabaseColumn {
                        name: key.clone(),
                        editable: true,
                    });
                }
            }
            rows.push(DatabaseRow {
                id: note.clone(),
                cells: properties.into_iter().collect(),
                path: Some(note),
            });
        }
        Ok(DatabaseTable {
            columns,
            rows,
            truncated,
        })
    }

    /// Change notes for one folder-view edit; rows can only be notes of that folder.
    fn folder_edit(
        &self,
        document_id: &str,
        path: &str,
        edit: &DatabaseEdit,
    ) -> Result<(), WorkspaceError> {
        let notes = self.folder_notes(document_id, path)?;
        let member = |id: &str| {
            notes
                .iter()
                .find(|note| note.as_str() == id)
                .ok_or(WorkspaceError::NotFound)
        };
        match edit {
            DatabaseEdit::SetCell { id, column, value } => {
                self.set_note_property(member(id)?, column, value)
            }
            DatabaseEdit::AddColumn { name } => {
                let name = validate_name(name)?;
                for note in notes.iter().take(MAX_DATABASE_ROWS) {
                    let present = frontmatter_properties(&self.note_text(note)?)
                        .iter()
                        .any(|(key, _)| key == name);
                    if !present {
                        self.set_note_property(note, name, "")?;
                    }
                }
                Ok(())
            }
            DatabaseEdit::AddRow => {
                let folder = self.view_path(document_id, path)?;
                let prefix = match folder.as_str() {
                    "" => String::new(),
                    folder => format!("{folder}/"),
                };
                let name = (0..1000)
                    .map(|n| match n {
                        0 => format!("{prefix}Untitled.md"),
                        n => format!("{prefix}Untitled-{n}.md"),
                    })
                    .find(|candidate| {
                        self.storage
                            .resolve(&self.root, candidate)
                            .is_ok_and(|target| !self.storage.exists(&target))
                    })
                    .ok_or(WorkspaceError::AlreadyExists)?;
                let target = self.storage.resolve(&self.root, &name)?;
                self.storage
                    .atomic_write(&target, b"", None, Some(&self.root))?;
                Ok(())
            }
            DatabaseEdit::DeleteRow { id } => {
                let note = member(id)?;
                // An open note keeps its buffer; deleting it underneath would lose edits.
                if self.actor_for(note).is_some() {
                    return Err(WorkspaceError::FolderOpenDocuments);
                }
                self.storage
                    .move_to_trash(&self.storage.resolve(&self.root, note)?)
            }
        }
    }

    /// Set one frontmatter property through the open buffer, or atomically on disk.
    fn set_note_property(&self, note: &str, key: &str, value: &str) -> Result<(), WorkspaceError> {
        if let Some(actor) = self.actor_for(note) {
            let snapshot = actor.sync_from_nvim()?;
            let (range, text) = set_frontmatter_property(&snapshot.text, key, value)?;
            actor.apply_edits(EditRequest {
                document_id: snapshot.document_id.clone(),
                base_revision: snapshot.revision,
                source: EditSource::Gui,
                edits: vec![TextEdit {
                    range: Utf16Range {
                        start: Utf16Offset(utf16_len(&snapshot.text[..range.start])),
                        end: Utf16Offset(utf16_len(&snapshot.text[..range.end])),
                    },
                    text,
                }],
            })?;
            return Ok(());
        }
        let target = self.storage.resolve(&self.root, note)?;
        let bytes = self
            .storage
            .read_disk(&target)?
            .ok_or(WorkspaceError::NotFound)?;
        let expected = storage::fingerprint(&bytes);
        let current = storage::utf8_text(bytes)?;
        let (range, text) = set_frontmatter_property(&current, key, value)?;
        let next = format!("{}{text}{}", &current[..range.start], &current[range.end..]);
        self.storage
            .atomic_write(&target, next.as_bytes(), Some(&expected), Some(&self.root))?;
        Ok(())
    }
}
