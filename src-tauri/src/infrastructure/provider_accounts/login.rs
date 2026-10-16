//! Explicit read-only discovery of existing Grok and Cursor logins, never browser credentials.
use super::store;
use crate::contracts::provider_accounts::*;
use crate::domain::provider_accounts::{cursor_cookie, grok_login};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use std::{
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

pub(super) enum LoginPlatform {
    MacOs,
    Windows,
    Linux,
}

/// Select native paths without relying on a workspace or executing a provider CLI.
pub(super) fn host_platform() -> LoginPlatform {
    if cfg!(target_os = "macos") {
        LoginPlatform::MacOs
    } else if cfg!(windows) {
        LoginPlatform::Windows
    } else {
        LoginPlatform::Linux
    }
}

/// Keep CLI and IDE casing/location differences explicit and fixture-testable on every platform.
pub(super) fn cursor_paths(
    home: &Path,
    platform: LoginPlatform,
    roaming: Option<&Path>,
    config: Option<&Path>,
) -> (PathBuf, PathBuf) {
    let (cli, ide) = match platform {
        LoginPlatform::MacOs => (
            home.join(".cursor"),
            home.join("Library/Application Support/Cursor"),
        ),
        LoginPlatform::Windows => {
            let root = roaming
                .filter(|p| p.is_absolute())
                .map(Path::to_path_buf)
                .unwrap_or_else(|| home.join("AppData/Roaming"))
                .join("Cursor");
            (root.clone(), root)
        }
        LoginPlatform::Linux => {
            let root = config
                .filter(|p| p.is_absolute())
                .map(Path::to_path_buf)
                .unwrap_or_else(|| home.join(".config"));
            (root.join("cursor"), root.join("Cursor"))
        }
    };
    (
        cli.join("auth.json"),
        ide.join("User/globalStorage/state.vscdb"),
    )
}

/// Normalize only verified Grok issuer entries; leave the CLI's auth file byte-for-byte unchanged.
pub(super) fn read_grok(path: &Path) -> Result<Option<String>, ProviderAccountError> {
    let Some(value) = store::read_json(path)? else {
        return Ok(None);
    };
    grok_login(&value)?
        .map(|value| {
            serde_json::to_string(&value).map_err(|_| ProviderAccountError::InvalidResponse)
        })
        .transpose()
}

/// Read one fixed Cursor IDE key with a read-only connection and bounded SQLite values.
fn cursor_ide_token(path: &Path) -> Result<Option<String>, ProviderAccountError> {
    store::reject_link(path)?;
    match std::fs::metadata(path) {
        Ok(meta) if meta.is_file() => {}
        Ok(_) => return Err(ProviderAccountError::InvalidResponse),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(ProviderAccountError::StoreFailed),
    }
    #[cfg(unix)]
    let canonical = path
        .canonicalize()
        .map_err(|_| ProviderAccountError::StoreFailed)?;
    #[cfg(not(unix))]
    let canonical = path.to_path_buf();
    let connection = Connection::open_with_flags(
        &canonical,
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .map_err(|_| ProviderAccountError::StoreFailed)?;
    connection
        .set_limit(rusqlite::limits::Limit::SQLITE_LIMIT_LENGTH, 65536)
        .map_err(|_| ProviderAccountError::StoreFailed)?;
    connection
        .busy_timeout(Duration::from_millis(200))
        .map_err(|_| ProviderAccountError::StoreFailed)?;
    let bytes = connection
        .query_row(
            "SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken' LIMIT 1",
            [],
            |row| {
                let value = row.get_ref(0)?;
                match value {
                    rusqlite::types::ValueRef::Text(bytes)
                    | rusqlite::types::ValueRef::Blob(bytes) => Ok(bytes.to_vec()),
                    _ => Err(rusqlite::Error::InvalidColumnType(
                        0,
                        "value".into(),
                        value.data_type(),
                    )),
                }
            },
        )
        .optional()
        .map_err(|_| ProviderAccountError::InvalidResponse)?;
    bytes
        .map(|bytes| {
            if bytes.len() > 32768 {
                Err(ProviderAccountError::InvalidResponse)
            } else {
                String::from_utf8(bytes).map_err(|_| ProviderAccountError::InvalidResponse)
            }
        })
        .transpose()
}

/// Prefer an existing CLI login over IDE fallback; invalid/expired CLI credentials never switch accounts.
pub(super) fn read_cursor_at(
    cli: &Path,
    ide: &Path,
    now_seconds: f64,
) -> Result<Option<String>, ProviderAccountError> {
    if let Some(value) = store::read_json(cli)? {
        let token = value
            .get("accessToken")
            .and_then(serde_json::Value::as_str)
            .ok_or(ProviderAccountError::InvalidResponse)?;
        return cursor_cookie(token, now_seconds).map(Some);
    }
    cursor_ide_token(ide)?
        .map(|token| cursor_cookie(&token, now_seconds))
        .transpose()
}

/// Discover native paths only for an explicit presence/usage call; never refresh or change sign-in.
pub(super) fn read_cursor(home: &Path) -> Result<Option<String>, ProviderAccountError> {
    let roaming = std::env::var_os("APPDATA").map(PathBuf::from);
    let config = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from);
    let (cli, ide) = cursor_paths(home, host_platform(), roaming.as_deref(), config.as_deref());
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64();
    let result = read_cursor_at(&cli, &ide, now)?;
    if result.is_some() {
        return Ok(result);
    }
    #[cfg(target_os = "macos")]
    {
        let entry = keyring::Entry::new("cursor-access-token", "cursor-user")
            .map_err(|_| ProviderAccountError::CredentialStoreFailed)?;
        match entry.get_password() {
            Ok(token) => return cursor_cookie(&token, now).map(Some),
            Err(keyring::Error::NoEntry) => {}
            Err(_) => return Err(ProviderAccountError::CredentialStoreFailed),
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    /// Read an artificial token, never an installed account's credential file.
    fn cursor_fixture() -> String {
        let value: Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/provider-accounts/cursor-cli.json"
        ))
        .unwrap();
        value["accessToken"].as_str().unwrap().into()
    }

    #[test]
    /// Each platform uses its verified CLI/IDE path, including case-sensitive Linux directory names.
    fn platform_paths_are_distinct_and_fixed() {
        #[cfg(windows)]
        let (home, roaming, config) = (
            Path::new("C:/fixture/home"),
            Path::new("C:/fixture/roaming"),
            Path::new("C:/fixture/config"),
        );
        #[cfg(not(windows))]
        let (home, roaming, config) = (
            Path::new("/fixture/home"),
            Path::new("/fixture/roaming"),
            Path::new("/fixture/config"),
        );
        let (cli, ide) = cursor_paths(home, LoginPlatform::MacOs, None, None);
        assert_eq!(cli, home.join(".cursor/auth.json"));
        assert_eq!(
            ide,
            home.join("Library/Application Support/Cursor/User/globalStorage/state.vscdb")
        );
        let (cli, ide) = cursor_paths(home, LoginPlatform::Windows, Some(roaming), None);
        assert_eq!(cli, roaming.join("Cursor/auth.json"));
        assert_eq!(ide, roaming.join("Cursor/User/globalStorage/state.vscdb"));
        let (cli, ide) = cursor_paths(home, LoginPlatform::Linux, None, Some(config));
        assert_eq!(cli, config.join("cursor/auth.json"));
        assert_eq!(ide, config.join("Cursor/User/globalStorage/state.vscdb"));
    }

    #[test]
    /// Grok reads only verified issuer access-token fields and never edits or refreshes its login.
    fn grok_existing_login_is_read_only_and_scope_bound() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("auth.json");
        let original = include_str!("../../../../tests/fixtures/provider-accounts/grok-auth.json");
        std::fs::write(&file, original).unwrap();
        let value: Value = serde_json::from_str(&read_grok(&file).unwrap().unwrap()).unwrap();
        assert_eq!(value["accessToken"], "fixture-grok-access");
        assert_eq!(value["userId"], "fixture-grok-user");
        assert!(value.get("refresh_token").is_none());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), original);
        assert_eq!(read_grok(&temp.path().join("missing.json")).unwrap(), None);
        std::fs::write(
            &file,
            r#"{"https://untrusted.example":{"key":"fixture-do-not-forward"}}"#,
        )
        .unwrap();
        assert!(read_grok(&file).unwrap().is_none());
    }

    #[test]
    /// SQLite IDE fallback reads TEXT/BLOB values with no writes and yields to an existing CLI login.
    fn cursor_cli_precedes_read_only_ide_database() {
        let temp = tempfile::tempdir().unwrap();
        let cli = temp.path().join("auth.json");
        let db = temp.path().join("state.vscdb");
        let token = cursor_fixture();
        for blob in [false, true] {
            let _ = std::fs::remove_file(&db);
            {
                let connection = Connection::open(&db).unwrap();
                connection
                    .execute_batch("CREATE TABLE ItemTable (key TEXT UNIQUE, value BLOB)")
                    .unwrap();
                if blob {
                    connection
                        .execute(
                            "INSERT INTO ItemTable VALUES ('cursorAuth/accessToken',?1)",
                            [token.as_bytes()],
                        )
                        .unwrap();
                } else {
                    connection
                        .execute(
                            "INSERT INTO ItemTable VALUES ('cursorAuth/accessToken',?1)",
                            [&token],
                        )
                        .unwrap();
                }
            }
            let before = std::fs::read(&db).unwrap();
            let files = std::fs::read_dir(temp.path()).unwrap().count();
            let cookie = read_cursor_at(&cli, &db, 1.0).unwrap().unwrap();
            assert!(cookie.starts_with("WorkosCursorSessionToken=fixture%7Ccursor-user%3A%3A"));
            assert!(cookie.ends_with(&token));
            assert_eq!(std::fs::read(&db).unwrap(), before);
            assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), files);
        }
        let original = include_str!("../../../../tests/fixtures/provider-accounts/cursor-cli.json");
        std::fs::write(&cli, original).unwrap();
        std::fs::write(&db, b"invalid database ignored while CLI exists").unwrap();
        assert!(read_cursor_at(&cli, &db, 1.0).unwrap().is_some());
        assert_eq!(std::fs::read_to_string(&cli).unwrap(), original);
        assert_eq!(
            read_cursor_at(&cli, &db, 4200000000.0),
            Err(ProviderAccountError::Unauthorized)
        );
        std::fs::write(&cli, "not JSON").unwrap();
        assert_eq!(
            read_cursor_at(&cli, &db, 1.0),
            Err(ProviderAccountError::InvalidResponse)
        );
    }

    #[test]
    /// Oversized or malformed IDE values are opaque errors and never become a manufactured login.
    fn cursor_database_values_are_bounded() {
        let temp = tempfile::tempdir().unwrap();
        let db = temp.path().join("state.vscdb");
        {
            let connection = Connection::open(&db).unwrap();
            connection
                .execute_batch("CREATE TABLE ItemTable (key TEXT,value BLOB)")
                .unwrap();
            connection
                .execute(
                    "INSERT INTO ItemTable VALUES ('cursorAuth/accessToken',?1)",
                    ["x".repeat(70000)],
                )
                .unwrap();
        }
        assert_eq!(
            cursor_ide_token(&db),
            Err(ProviderAccountError::InvalidResponse)
        );
        assert!(cursor_ide_token(&temp.path().join("missing-db"))
            .unwrap()
            .is_none());
        assert!(!temp.path().join("missing-db").exists());
    }
}
