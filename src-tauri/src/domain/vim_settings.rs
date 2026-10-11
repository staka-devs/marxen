//! Pure Marxen-managed Vimscript block rewrite and validation.
//!
//! The managed block is the only region the Settings GUI owns. Arbitrary
//! Vimscript outside the block is never parsed and always preserved. This
//! module never touches the filesystem: callers pass file text and receive a
//! rewritten string or a rejection detail.

use crate::contracts::vim_settings::{VimCopyKeys, VimMapping, VimSettings};

/// Opening marker line of the Marxen-managed region (exact text).
pub const MANAGED_START: &str = "\" === MARXEN MANAGED START ===";
/// Closing marker line of the Marxen-managed region (exact text).
pub const MANAGED_END: &str = "\" === MARXEN MANAGED END ===";
/// Human note emitted directly inside the managed region.
pub const MANAGED_NOTE: &str =
    "\" Managed by Marxen Settings GUI. Do not edit between markers; use Settings or the raw editor.";
/// Supported config basenames for managed Vimscript rewriting.
pub const VIMRC_NAMES: [&str; 4] = ["vimrc", "_vimrc", ".vimrc", "init.vim"];
/// Basename selecting Lua raw-only handling.
pub const LUA_NAME: &str = "init.lua";
/// Upper bound for a raw config file accepted by managed operations.
pub const MAX_CONFIG_BYTES: usize = 512 * 1024;
/// Upper bound for mode-specific mappings in one settings value.
pub const MAX_MAPPINGS: usize = 64;

/// Build the default structured settings for a fresh managed block.
pub fn default_settings() -> VimSettings {
    VimSettings {
        tabstop: 2,
        shiftwidth: 2,
        expandtab: true,
        ignorecase: true,
        smartcase: true,
        leader: " ".into(),
        mappings: Vec::new(),
        copy_keys: VimCopyKeys {
            markdown: "<F6>".into(),
            text: "<F7>".into(),
            rich: "<F8>".into(),
            html: "<F9>".into(),
        },
    }
}

/// Report whether a filename selects managed Vimscript rewriting.
pub fn is_vimrc_name(file_name: &str) -> bool {
    VIMRC_NAMES
        .iter()
        .any(|name| name.eq_ignore_ascii_case(file_name))
}

/// Report whether a filename selects Lua raw-only handling.
pub fn is_lua_name(file_name: &str) -> bool {
    file_name.eq_ignore_ascii_case(LUA_NAME)
}

/// Report whether a full path selects managed Vimscript rewriting.
pub fn is_vimrc_path(path: &std::path::Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(is_vimrc_name)
}

/// Report whether a full path selects Lua raw-only handling.
pub fn is_lua_path(path: &std::path::Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(is_lua_name)
}

/// Check whether a trimmed line is a Marxen block marker.
fn is_marker(line: &str, marker: &str) -> bool {
    line.trim_end_matches('\r').trim() == marker
}

/// Validate one copy-format selector value, returning a rejection detail.
///
/// Empty disables the selector. Non-empty values must be a single character
/// or `<...>` notation within 64 bytes, mirroring the native copy-config
/// check so GUI input and sourced behavior agree.
pub fn validate_copy_key(name: &str, value: &str) -> Option<String> {
    if value.is_empty() {
        return None;
    }
    if value.len() > 64 {
        return Some(format!(
            "g:marxen_copy_{name}_key: 一つのキーを指定してください。"
        ));
    }
    let single = value.chars().count() == 1
        || (value.starts_with('<')
            && value.ends_with('>')
            && value.len() >= 3
            && !value[1..value.len() - 1].contains(['<', '>']));
    if !single {
        return Some(format!(
            "g:marxen_copy_{name}_key: 一つのキーを指定してください。"
        ));
    }
    if value.contains('\'') {
        return Some(format!(
            "g:marxen_copy_{name}_key: 設定コードエディターで指定してください。"
        ));
    }
    let lower = value.to_ascii_lowercase();
    let reserved = matches!(
        lower.as_str(),
        "<left>" | "<right>" | "<up>" | "<down>" | "<home>" | "<end>"
    );
    let app_shortcut = (lower.contains("c-") || lower.contains("d-"))
        && (lower.ends_with("p>") || lower.ends_with("s>"));
    if reserved || app_shortcut {
        return Some(format!(
            "g:marxen_copy_{name}_key: アプリのショートカット・表示行移動のキーは指定できません。"
        ));
    }
    None
}

/// Validate one mode-specific mapping, returning a rejection detail.
pub fn validate_mapping(mapping: &VimMapping) -> Option<String> {
    if !matches!(
        mapping.mode.as_str(),
        "n" | "i" | "v" | "x" | "s" | "o" | "c" | "t"
    ) {
        return Some(format!(
            "mapping {}: モードは n/i/v/x/s/o/c/t で指定してください。",
            mapping.mode
        ));
    }
    let lhs_count = mapping.lhs.chars().count();
    if lhs_count == 0 || lhs_count > 64 {
        return Some("mapping: キーは1〜64文字で指定してください。".into());
    }
    if mapping
        .lhs
        .chars()
        .any(|c| c.is_whitespace() || c.is_control())
    {
        return Some("mapping: キーに空白や制御文字は使えません。".into());
    }
    if mapping.lhs.contains(['|', '\0']) {
        return Some(
            "mapping: キーに | は使えません（<Bar>を使うか設定コードで編集してください）。".into(),
        );
    }
    let rhs_count = mapping.rhs.chars().count();
    if rhs_count == 0 || rhs_count > 256 {
        return Some("mapping: 置換内容は1〜256文字で指定してください。".into());
    }
    if mapping.rhs.contains(['|', '\0', '\n', '\r'])
        || mapping.rhs.chars().any(|c| c.is_control() && c != '\t')
    {
        return Some("mapping: 置換内容に | や改行や制御文字は使えません。".into());
    }
    None
}

/// Collect every settings validation failure in stable field order.
pub fn validate_settings(settings: &VimSettings) -> Vec<String> {
    let mut errors = Vec::new();
    if !(1..=32).contains(&settings.tabstop) {
        errors.push("tabstop は 1〜32 で指定してください。".into());
    }
    if !(1..=32).contains(&settings.shiftwidth) {
        errors.push("shiftwidth は 1〜32 で指定してください。".into());
    }
    if settings.leader.chars().count() != 1 || settings.leader.chars().any(|c| c.is_control()) {
        errors.push("leader は1文字で指定してください。".into());
    }
    for (name, value) in [
        ("markdown", settings.copy_keys.markdown.as_str()),
        ("text", settings.copy_keys.text.as_str()),
        ("rich", settings.copy_keys.rich.as_str()),
        ("html", settings.copy_keys.html.as_str()),
    ] {
        if let Some(detail) = validate_copy_key(name, value) {
            errors.push(detail);
        }
    }
    let copy_values: Vec<&str> = [
        settings.copy_keys.markdown.as_str(),
        settings.copy_keys.text.as_str(),
        settings.copy_keys.rich.as_str(),
        settings.copy_keys.html.as_str(),
    ]
    .into_iter()
    .filter(|v| !v.is_empty())
    .collect();
    let mut seen = std::collections::BTreeMap::new();
    for value in copy_values {
        let key = value.to_ascii_lowercase();
        if seen.insert(key, value).is_some() {
            errors.push(format!("{value}: コピー形式キーと重複しています。"));
        }
    }
    if settings.mappings.len() > MAX_MAPPINGS {
        errors.push(format!("mapping は最大 {MAX_MAPPINGS} 件です。"));
    }
    for mapping in &settings.mappings {
        if let Some(detail) = validate_mapping(mapping) {
            errors.push(detail);
        }
    }
    let mut pairs = std::collections::BTreeSet::new();
    for mapping in &settings.mappings {
        let key = format!("{}\u{0}{}", mapping.mode, mapping.lhs);
        if !pairs.insert(key) {
            errors.push(format!(
                "mapping {} {}: 重複しています。",
                mapping.mode, mapping.lhs
            ));
        }
    }
    errors
}

/// Escape a leader character for a double-quoted Vimscript string.
fn escape_leader(leader: &str) -> String {
    leader.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Unescape a double- or single-quoted Vimscript leader literal.
fn unescape_leader(quoted: &str) -> Option<String> {
    let inner = if quoted.starts_with('"') && quoted.ends_with('"') && quoted.len() >= 2 {
        &quoted[1..quoted.len() - 1]
    } else if quoted.starts_with('\'') && quoted.ends_with('\'') && quoted.len() >= 2 {
        // Single-quoted leaders cannot contain escapes; reject embedded quotes.
        let body = &quoted[1..quoted.len() - 1];
        if body.contains('\'') {
            return None;
        }
        return Some(body.to_owned());
    } else {
        return None;
    };
    let mut out = String::new();
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            let next = chars.next()?;
            out.push(next);
        } else {
            out.push(c);
        }
    }
    Some(out)
}

/// Render the canonical managed block lines for validated settings.
pub fn render_managed(settings: &VimSettings) -> Vec<String> {
    let mut lines = vec![
        MANAGED_START.to_owned(),
        MANAGED_NOTE.to_owned(),
        format!("set tabstop={}", settings.tabstop),
        format!("set shiftwidth={}", settings.shiftwidth),
        (if settings.expandtab {
            "set expandtab"
        } else {
            "set noexpandtab"
        })
        .to_owned(),
        (if settings.ignorecase {
            "set ignorecase"
        } else {
            "set noignorecase"
        })
        .to_owned(),
        (if settings.smartcase {
            "set smartcase"
        } else {
            "set nosmartcase"
        })
        .to_owned(),
        format!("let mapleader=\"{}\"", escape_leader(&settings.leader)),
    ];
    for (name, value) in [
        ("markdown", settings.copy_keys.markdown.as_str()),
        ("text", settings.copy_keys.text.as_str()),
        ("rich", settings.copy_keys.rich.as_str()),
        ("html", settings.copy_keys.html.as_str()),
    ] {
        lines.push(format!("let g:marxen_copy_{name}_key='{value}'"));
    }
    for mapping in &settings.mappings {
        lines.push(format!(
            "{}noremap {} {}",
            mapping.mode, mapping.lhs, mapping.rhs
        ));
    }
    lines.push(MANAGED_END.to_owned());
    lines
}

/// Locate the managed block line range, rejecting malformed markers.
///
/// Returns `None` when no block exists, or the inclusive `(start, end)` line
/// indices. Duplicate markers, a missing end, or an end before the start are
/// rejections so repeated edits never duplicate the block.
pub fn find_managed_block(lines: &[&str]) -> Result<Option<(usize, usize)>, String> {
    let mut starts = Vec::new();
    let mut ends = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        if is_marker(line, MANAGED_START) {
            starts.push(index);
        }
        if is_marker(line, MANAGED_END) {
            ends.push(index);
        }
    }
    match (starts.len(), ends.len()) {
        (0, 0) => Ok(None),
        (1, 1) => {
            if starts[0] < ends[0] {
                Ok(Some((starts[0], ends[0])))
            } else {
                Err("管理ブロックの開始と終了の順序が正しくありません。設定コードエディターで修正してください。".into())
            }
        }
        _ => Err("管理ブロックのマーカーが重複または不足しています。設定コードエディターで1組に修正してください。".into()),
    }
}

/// Parse one `set` line's tokens into settings, rejecting unknown options.
fn parse_set_line(
    tokens: &[&str],
    settings: &mut VimSettings,
    line_no: usize,
) -> Result<(), String> {
    for token in tokens {
        if let Some(value) = token.strip_prefix("tabstop=") {
            settings.tabstop = value.parse::<u8>().map_err(|_| {
                format!("管理ブロック{line_no}行目: tabstop の値が正しくありません。")
            })?;
        } else if let Some(value) = token.strip_prefix("shiftwidth=") {
            settings.shiftwidth = value.parse::<u8>().map_err(|_| {
                format!("管理ブロック{line_no}行目: shiftwidth の値が正しくありません。")
            })?;
        } else if *token == "expandtab" {
            settings.expandtab = true;
        } else if *token == "noexpandtab" {
            settings.expandtab = false;
        } else if *token == "ignorecase" {
            settings.ignorecase = true;
        } else if *token == "noignorecase" {
            settings.ignorecase = false;
        } else if *token == "smartcase" {
            settings.smartcase = true;
        } else if *token == "nosmartcase" {
            settings.smartcase = false;
        } else {
            return Err(format!(
                "管理ブロック{line_no}行目: 対応していない設定です（{token}）。ブロック外へ移動するか設定コードで編集してください。"
            ));
        }
    }
    Ok(())
}

/// Parse one managed-block body line, rejecting anything outside the owned subset.
fn parse_block_line(line: &str, settings: &mut VimSettings, line_no: usize) -> Result<(), String> {
    let trimmed = line.trim_end_matches('\r').trim();
    if trimmed.is_empty() || trimmed.starts_with('"') {
        return Ok(());
    }
    if let Some(rest) = trimmed.strip_prefix("set ") {
        let tokens: Vec<&str> = rest.split_whitespace().collect();
        if tokens.is_empty() {
            return Err(format!(
                "管理ブロック{line_no}行目: set の内容がありません。"
            ));
        }
        return parse_set_line(&tokens, settings, line_no);
    }
    if trimmed.starts_with("let ") {
        let body = trimmed.strip_prefix("let ").unwrap_or("").trim();
        if let Some(value) = body.strip_prefix("mapleader=") {
            let leader = unescape_leader(value.trim()).ok_or_else(|| {
                format!("管理ブロック{line_no}行目: mapleader の引用が正しくありません。")
            })?;
            settings.leader = leader;
            return Ok(());
        }
        if let Some(value) = body.strip_prefix("g:mapleader=") {
            let leader = unescape_leader(value.trim()).ok_or_else(|| {
                format!("管理ブロック{line_no}行目: mapleader の引用が正しくありません。")
            })?;
            settings.leader = leader;
            return Ok(());
        }
        if let Some(rest) = body.strip_prefix("g:marxen_copy_") {
            if let Some((name, value)) = rest.split_once("_key=") {
                let key_value = value.trim();
                let unquoted = if key_value.starts_with('\'')
                    && key_value.ends_with('\'')
                    && key_value.len() >= 2
                {
                    key_value[1..key_value.len() - 1].to_owned()
                } else if key_value.starts_with('"')
                    && key_value.ends_with('"')
                    && key_value.len() >= 2
                {
                    unescape_leader(key_value).ok_or_else(|| {
                        format!(
                            "管理ブロック{line_no}行目: コピー形式キーの引用が正しくありません。"
                        )
                    })?
                } else {
                    return Err(format!(
                        "管理ブロック{line_no}行目: コピー形式キーの引用が正しくありません。"
                    ));
                };
                match name {
                    "markdown" => settings.copy_keys.markdown = unquoted,
                    "text" => settings.copy_keys.text = unquoted,
                    "rich" => settings.copy_keys.rich = unquoted,
                    "html" => settings.copy_keys.html = unquoted,
                    _ => {
                        return Err(format!(
                            "管理ブロック{line_no}行目: 対応していないコピー形式です（{name}）。"
                        ))
                    }
                }
                return Ok(());
            }
        }
        return Err(format!(
            "管理ブロック{line_no}行目: 対応していない let です。ブロック外へ移動してください。"
        ));
    }
    for mode in ["n", "i", "v", "x", "s", "o", "c", "t"] {
        let prefix = format!("{mode}noremap ");
        if let Some(rest) = trimmed.strip_prefix(prefix.as_str()) {
            let mut parts = rest.splitn(2, char::is_whitespace);
            let lhs = parts.next().unwrap_or("").to_owned();
            let rhs = parts.next().unwrap_or("").trim().to_owned();
            if lhs.is_empty() || rhs.is_empty() {
                return Err(format!(
                    "管理ブロック{line_no}行目: mapping の形式が正しくありません。"
                ));
            }
            settings.mappings.push(VimMapping {
                mode: mode.into(),
                lhs,
                rhs,
            });
            return Ok(());
        }
    }
    Err(format!(
        "管理ブロック{line_no}行目: 対応していない行です（{trimmed}）。ブロック外へ移動してください。"
    ))
}

/// Parse the managed block of raw file text into structured settings.
///
/// Returns `None` when no block exists. Rejects duplicate/missing markers and
/// any body line outside the owned subset so unknown Vim language is never
/// silently reinterpreted.
pub fn parse_managed(raw: &str) -> Result<Option<VimSettings>, String> {
    let lines: Vec<&str> = raw.split('\n').collect();
    let Some((start, end)) = find_managed_block(&lines)? else {
        return Ok(None);
    };
    let mut settings = default_settings();
    for (offset, line) in lines[start + 1..end].iter().enumerate() {
        parse_block_line(line, &mut settings, start + offset + 2)?;
    }
    Ok(Some(settings))
}

/// Rewrite raw file text with canonical managed settings.
///
/// Validates the new settings first, refuses Lua targets, rejects malformed
/// existing blocks, appends a fresh block when missing, and replaces the
/// block in place otherwise. Unknown text outside the block is preserved
/// byte-for-byte apart from the block splice; repeated calls are idempotent.
pub fn rewrite_managed(raw: &str, settings: &VimSettings, is_lua: bool) -> Result<String, String> {
    if is_lua {
        return Err("init.lua は設定コード編集のみです。管理ブロックを挿入しません。".into());
    }
    let failures = validate_settings(settings);
    if let Some(first) = failures.first() {
        return Err(first.clone());
    }
    // Reject an ambiguous existing block before discarding anything.
    parse_managed(raw)?;
    let block = render_managed(settings).join("\n");
    if raw.is_empty() {
        return Ok(format!("{block}\n"));
    }
    let lines: Vec<&str> = raw.split('\n').collect();
    match find_managed_block(&lines)? {
        None => {
            let separator = if raw.ends_with('\n') { "" } else { "\n" };
            Ok(format!("{raw}{separator}{block}\n"))
        }
        Some((start, end)) => {
            let before = lines[..start].join("\n");
            let after = lines[end + 1..].join("\n");
            let mut result = String::new();
            if !before.is_empty() {
                result.push_str(&before);
                result.push('\n');
            }
            result.push_str(&block);
            result.push('\n');
            result.push_str(&after);
            if !after.is_empty() && !after.ends_with('\n') {
                result.push('\n');
            }
            Ok(result)
        }
    }
}

#[cfg(test)]
mod unit {
    use super::*;

    /// Keep an empty file rewrite minimal and idempotent on second application.
    #[test]
    fn empty_file_gains_one_block_idempotently() {
        let settings = default_settings();
        let once = rewrite_managed("", &settings, false).unwrap();
        assert!(once.contains(MANAGED_START));
        assert!(once.contains(MANAGED_END));
        assert_eq!(once.matches(MANAGED_START).count(), 1);
        let twice = rewrite_managed(&once, &settings, false).unwrap();
        assert_eq!(once, twice);
    }

    /// Preserve Japanese comments, emoji, and unknown commands outside the block.
    #[test]
    fn unknown_outside_text_survives_rewrite() {
        let raw = "\" 日本語コメント 🎉\nset number\nnnoremap j gj\n";
        let rewritten = rewrite_managed(raw, &default_settings(), false).unwrap();
        assert!(rewritten.contains("\" 日本語コメント 🎉"));
        assert!(rewritten.contains("set number"));
        assert!(rewritten.contains("nnoremap j gj"));
        assert_eq!(rewritten.matches(MANAGED_START).count(), 1);
    }

    /// Reject duplicated or unterminated markers instead of doubling the block.
    #[test]
    fn malformed_markers_reject() {
        let duplicated = format!(
            "{MANAGED_START}\nset tabstop=2\n{MANAGED_END}\n{MANAGED_START}\n{MANAGED_END}\n"
        );
        assert!(rewrite_managed(&duplicated, &default_settings(), false).is_err());
        let missing_end = format!("{MANAGED_START}\nset tabstop=2\n");
        assert!(rewrite_managed(&missing_end, &default_settings(), false).is_err());
        let reversed = format!("{MANAGED_END}\n{MANAGED_START}\n");
        assert!(rewrite_managed(&reversed, &default_settings(), false).is_err());
    }

    /// Reject unknown body lines inside the block rather than reinterpreting Vim.
    #[test]
    fn unknown_inside_block_rejects() {
        let raw = format!("{MANAGED_START}\nset number\n{MANAGED_END}\n");
        assert!(parse_managed(&raw).is_err());
        assert!(rewrite_managed(&raw, &default_settings(), false).is_err());
    }

    /// Refuse managed insertion into Lua while raw editing stays available.
    #[test]
    fn lua_target_rejects_managed_rewrite() {
        let raw = "vim.opt.number = true\n";
        assert!(rewrite_managed(raw, &default_settings(), true).is_err());
        assert!(is_lua_name("init.lua"));
        assert!(!is_vimrc_name("init.lua"));
    }

    /// Reject invalid options and keys before touching file text.
    #[test]
    fn invalid_options_reject() {
        let mut bad = default_settings();
        bad.tabstop = 0;
        assert!(rewrite_managed("", &bad, false).is_err());
        let mut dup = default_settings();
        dup.copy_keys.text = dup.copy_keys.markdown.clone();
        assert!(validate_settings(&dup).iter().any(|e| e.contains("重複")));
        assert!(validate_copy_key("markdown", "<Left>").is_some());
        let mapping = VimMapping {
            mode: "n".into(),
            lhs: "a|b".into(),
            rhs: ":w".into(),
        };
        assert!(validate_mapping(&mapping).is_some());
    }

    /// Round-trip leader quoting including escapable characters.
    #[test]
    fn leader_quote_round_trip() {
        let mut settings = default_settings();
        settings.leader = "\\".into();
        let raw = rewrite_managed("", &settings, false).unwrap();
        let parsed = parse_managed(&raw).unwrap().unwrap();
        assert_eq!(parsed.leader, "\\");
    }
}
