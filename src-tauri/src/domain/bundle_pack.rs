//! Marxen bundles (`name.marxen/` folders) and their single-file packs (`.marxenpack`, uncompressed ustar).
//!
//! A bundle keeps a note's `index.md`, its `assets/` and any SQLite file as
//! real files, so editing, saving and Git work unchanged. A pack is only for
//! carrying a bundle around: it is written from and extracted to real files.

use crate::contracts::WorkspaceError;

/// Folder suffix that marks a bundle.
pub const BUNDLE_SUFFIX: &str = ".marxen";
/// File extension of a packed bundle.
pub const PACK_EXTENSION: &str = "marxenpack";
/// Largest pack read or written.
pub const MAX_PACK_BYTES: usize = 256 * 1024 * 1024;
/// Most files one pack may hold.
pub const MAX_PACK_FILES: usize = 10_000;

const BLOCK: usize = 512;

/// True when the last path segment names a bundle folder.
pub fn is_bundle(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path);
    name.len() > BUNDLE_SUFFIX.len() && name.ends_with(BUNDLE_SUFFIX)
}

/// Refuse pack member names that are absolute, empty, traversing or unportable.
pub fn validate_member(name: &str) -> Result<(), WorkspaceError> {
    let bad = name.is_empty()
        || name.len() > 100
        || name.starts_with('/')
        || name.contains(['\\', ':', '\0'])
        || name
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..");
    match bad {
        true => Err(WorkspaceError::InvalidPath),
        false => Ok(()),
    }
}

/// Write `value` as a NUL-terminated octal field of `width` bytes.
fn octal(field: &mut [u8], value: u64) {
    let width = field.len() - 1;
    let text = format!("{value:0width$o}");
    field[..width].copy_from_slice(text.as_bytes());
    field[width] = 0;
}

/// Build an uncompressed ustar archive of regular files.
pub fn write_pack(files: &[(String, Vec<u8>)]) -> Result<Vec<u8>, WorkspaceError> {
    let mut out = Vec::new();
    for (name, bytes) in files {
        validate_member(name)?;
        let mut header = [0u8; BLOCK];
        header[..name.len()].copy_from_slice(name.as_bytes());
        octal(&mut header[100..108], 0o644);
        octal(&mut header[108..116], 0);
        octal(&mut header[116..124], 0);
        octal(&mut header[124..136], bytes.len() as u64);
        octal(&mut header[136..148], 0);
        header[156] = b'0';
        header[257..263].copy_from_slice(b"ustar\0");
        header[263..265].copy_from_slice(b"00");
        header[148..156].fill(b' ');
        let sum: u32 = header.iter().map(|&b| u32::from(b)).sum();
        octal(&mut header[148..155], u64::from(sum));
        header[155] = b' ';
        out.extend_from_slice(&header);
        out.extend_from_slice(bytes);
        out.resize(out.len().next_multiple_of(BLOCK), 0);
        if out.len() > MAX_PACK_BYTES {
            return Err(WorkspaceError::InvalidPath);
        }
    }
    out.resize(out.len() + 2 * BLOCK, 0);
    Ok(out)
}

/// Parse one NUL- or space-terminated octal header field.
fn parse_octal(field: &[u8]) -> Result<u64, WorkspaceError> {
    let text = std::str::from_utf8(field).map_err(|_| WorkspaceError::InvalidPath)?;
    let digits = text.trim_matches(|c: char| c == '\0' || c == ' ');
    u64::from_str_radix(if digits.is_empty() { "0" } else { digits }, 8)
        .map_err(|_| WorkspaceError::InvalidPath)
}

/// Read regular files from a ustar archive, refusing links, devices and unsafe names.
pub fn read_pack(bytes: &[u8]) -> Result<Vec<(String, Vec<u8>)>, WorkspaceError> {
    if bytes.len() > MAX_PACK_BYTES {
        return Err(WorkspaceError::InvalidPath);
    }
    let mut files = Vec::new();
    let mut offset = 0;
    while offset + BLOCK <= bytes.len() {
        let header = &bytes[offset..offset + BLOCK];
        if header.iter().all(|&b| b == 0) {
            return Ok(files);
        }
        let stored = parse_octal(&header[148..156])?;
        let sum: u64 = header
            .iter()
            .enumerate()
            .map(|(i, &b)| u64::from(if (148..156).contains(&i) { b' ' } else { b }))
            .sum();
        if stored != sum {
            return Err(WorkspaceError::InvalidPath);
        }
        let end = header[..100].iter().position(|&b| b == 0).unwrap_or(100);
        let name = std::str::from_utf8(&header[..end]).map_err(|_| WorkspaceError::InvalidPath)?;
        let size = parse_octal(&header[124..136])? as usize;
        let start = offset + BLOCK;
        let data = bytes
            .get(start..start.checked_add(size).ok_or(WorkspaceError::InvalidPath)?)
            .ok_or(WorkspaceError::InvalidPath)?;
        match header[156] {
            b'0' | 0 => {
                validate_member(name)?;
                files.push((name.to_owned(), data.to_vec()));
            }
            b'5' => {}
            _ => return Err(WorkspaceError::InvalidPath),
        }
        if files.len() > MAX_PACK_FILES {
            return Err(WorkspaceError::InvalidPath);
        }
        offset = start + size.next_multiple_of(BLOCK);
    }
    Err(WorkspaceError::InvalidPath)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    /// Round-trip files, including Japanese names and empty files.
    fn packs_and_unpacks_files() {
        let files = vec![
            ("メモ.marxen/index.md".to_owned(), b"# hi\n".to_vec()),
            (
                "メモ.marxen/assets/a.png".to_owned(),
                vec![0x89, b'P', 0, 1],
            ),
            ("メモ.marxen/empty".to_owned(), Vec::new()),
        ];
        let pack = write_pack(&files).unwrap();
        assert_eq!(pack.len() % BLOCK, 0);
        assert_eq!(read_pack(&pack).unwrap(), files);
    }

    #[test]
    /// Refuse traversal, absolute names, links and corrupted headers.
    fn refuses_unsafe_packs() {
        assert!(write_pack(&[("../x".into(), vec![])]).is_err());
        assert!(write_pack(&[("/x".into(), vec![])]).is_err());
        assert!(write_pack(&[("a//b".into(), vec![])]).is_err());
        let mut link = write_pack(&[("a.marxen/x".into(), vec![])]).unwrap();
        link[156] = b'2';
        assert!(read_pack(&link).is_err());
        let mut corrupt = write_pack(&[("a.marxen/x".into(), b"abc".to_vec())]).unwrap();
        corrupt[0] = b'b';
        assert!(read_pack(&corrupt).is_err());
        assert!(read_pack(&[1u8; 100]).is_err());
    }

    #[test]
    /// Recognize bundle folder names only.
    fn recognizes_bundles() {
        assert!(is_bundle("notes/メモ.marxen"));
        assert!(!is_bundle(".marxen"));
        assert!(!is_bundle("a.marxen/index.md"));
    }
}
