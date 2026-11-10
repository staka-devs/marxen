//! Pure rules for database views: flat frontmatter properties and SQLite identifiers.

use crate::contracts::WorkspaceError;

/// Most rows one view returns; larger sources are marked truncated.
pub const MAX_DATABASE_ROWS: usize = 1000;

/// Byte length of the leading `---` frontmatter block including its closing line, if any.
fn frontmatter_end(text: &str) -> Option<usize> {
    let body = text
        .strip_prefix("---\n")
        .or_else(|| text.strip_prefix("---\r\n"))?;
    let start = text.len() - body.len();
    let mut offset = start;
    for line in body.split_inclusive('\n') {
        if line.trim_end() == "---" {
            return Some(offset + line.len());
        }
        offset += line.len();
    }
    None
}

/// Split one `key: value` line; nested YAML (indented or list lines) is not a property.
fn property(line: &str) -> Option<(&str, String)> {
    if line.starts_with([' ', '\t', '-', '#']) {
        return None;
    }
    let (key, value) = line.split_once(':')?;
    let key = key.trim();
    if key.is_empty() {
        return None;
    }
    let value = value.trim();
    if let Some(inner) = value.strip_prefix('"').and_then(|v| v.strip_suffix('"')) {
        return Some((key, inner.replace("\\\"", "\"").replace("\\\\", "\\")));
    }
    let single = value.strip_prefix('\'').and_then(|v| v.strip_suffix('\''));
    Some((key, single.unwrap_or(value).to_owned()))
}

/// Read flat `key: value` frontmatter properties in order.
///
/// shortcut: only flat scalar properties are read; lists and nested maps are
/// skipped, upgrade to a YAML parser when views need them.
pub fn frontmatter_properties(text: &str) -> Vec<(String, String)> {
    let Some(end) = frontmatter_end(text) else {
        return Vec::new();
    };
    text[..end]
        .lines()
        .skip(1)
        .filter_map(property)
        .map(|(key, value)| (key.to_owned(), value))
        .collect()
}

/// Quote a value so YAML reads it back as the same string.
fn yaml_value(value: &str) -> String {
    let plain = !value.is_empty()
        && !value.starts_with([
            ' ', '"', '\'', '-', '?', ':', '[', ']', '{', '}', '#', '&', '*', '!', '|', '>', '%',
            '@', '`',
        ])
        && !value.ends_with(' ')
        && !value.contains(": ")
        && !value.contains(" #");
    match plain {
        true => value.to_owned(),
        false => format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\"")),
    }
}

/// Validate a property or column name typed in a view.
pub fn validate_name(name: &str) -> Result<&str, WorkspaceError> {
    let name = name.trim();
    if name.is_empty()
        || name.len() > 64
        || name.contains(['"', ':', '#', '\n', '\r'])
        || name.chars().any(char::is_control)
    {
        return Err(WorkspaceError::InvalidPath);
    }
    Ok(name)
}

/// Return the text with one frontmatter property set, adding the block or the key as needed.
///
/// Returns the replaced byte range and its new text so open buffers receive a
/// minimal edit instead of a whole-document rewrite.
pub fn set_frontmatter_property(
    text: &str,
    key: &str,
    value: &str,
) -> Result<(std::ops::Range<usize>, String), WorkspaceError> {
    let key = validate_name(key)?;
    if value.contains(['\n', '\r']) {
        return Err(WorkspaceError::InvalidPath);
    }
    let line = format!("{key}: {}", yaml_value(value));
    let newline = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let Some(end) = frontmatter_end(text) else {
        return Ok((0..0, format!("---{newline}{line}{newline}---{newline}")));
    };
    let block = &text[..end];
    let mut offset = 0;
    let mut close = 0;
    for (index, raw) in block.split_inclusive('\n').enumerate() {
        let trimmed = raw.trim_end_matches(['\n', '\r']);
        if index > 0 && property(trimmed).is_some_and(|(k, _)| k == key) {
            let stop = offset + trimmed.len();
            return Ok((offset..stop, line));
        }
        close = offset;
        offset += raw.len();
    }
    Ok((close..close, format!("{line}{newline}")))
}

/// Quote a SQLite identifier after refusing names that could not round-trip.
pub fn sqlite_identifier(name: &str) -> Result<String, WorkspaceError> {
    Ok(format!("\"{}\"", validate_name(name)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Apply a returned range edit to the text.
    fn apply(text: &str, key: &str, value: &str) -> String {
        let (range, insert) = set_frontmatter_property(text, key, value).unwrap();
        format!("{}{insert}{}", &text[..range.start], &text[range.end..])
    }

    #[test]
    /// Read flat properties, unquote values and skip nested lines.
    fn reads_flat_properties() {
        let text = "---\nstatus: done\ntitle: \"A: B\"\ntags:\n  - x\n---\n# Body\nkey: no\n";
        assert_eq!(
            frontmatter_properties(text),
            vec![
                ("status".into(), "done".into()),
                ("title".into(), "A: B".into()),
                ("tags".into(), "".into()),
            ]
        );
        assert!(frontmatter_properties("# no frontmatter\n").is_empty());
    }

    #[test]
    /// Replace an existing key, append a new one and create a missing block.
    fn sets_properties_minimally() {
        let text = "---\nstatus: todo\n---\nbody\n";
        assert_eq!(
            apply(text, "status", "done"),
            "---\nstatus: done\n---\nbody\n"
        );
        assert_eq!(
            apply(text, "due", "2026-11-10"),
            "---\nstatus: todo\ndue: 2026-11-10\n---\nbody\n"
        );
        assert_eq!(
            apply("body\n", "status", "a: b"),
            "---\nstatus: \"a: b\"\n---\nbody\n"
        );
        assert_eq!(
            frontmatter_properties(&apply(text, "note", "say \"hi\"")),
            vec![
                ("status".into(), "todo".into()),
                ("note".into(), "say \"hi\"".into())
            ]
        );
        assert!(set_frontmatter_property(text, "bad:key", "x").is_err());
        assert!(set_frontmatter_property(text, "k", "two\nlines").is_err());
    }

    #[test]
    /// Quote identifiers and refuse ones that would break the quoting.
    fn quotes_sqlite_identifiers() {
        assert_eq!(sqlite_identifier("タスク").unwrap(), "\"タスク\"");
        assert!(sqlite_identifier("a\"b").is_err());
        assert!(sqlite_identifier(" ").is_err());
    }
}
