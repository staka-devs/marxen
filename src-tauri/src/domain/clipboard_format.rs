//! CF_HTML offsets are UTF-8 byte positions, independently padded to ten
//! digits. A complete HTML context helps native document importers.
pub(crate) fn windows_html(fragment: &str) -> Vec<u8> {
    const PREFIX: &str = "<html><head><meta charset=\"utf-8\"></head><body><!--StartFragment-->";
    const SUFFIX: &str = "<!--EndFragment--></body></html>";
    let header = |start_html, end_html, start_fragment, end_fragment| {
        format!("Version:1.0\r\nStartHTML:{start_html:010}\r\nEndHTML:{end_html:010}\r\nStartFragment:{start_fragment:010}\r\nEndFragment:{end_fragment:010}\r\n")
    };
    let start_html = header(0, 0, 0, 0).len();
    let start_fragment = start_html + PREFIX.len();
    let end_fragment = start_fragment + fragment.len();
    let end_html = end_fragment + SUFFIX.len();
    let mut bytes = header(start_html, end_html, start_fragment, end_fragment).into_bytes();
    bytes.extend_from_slice(PREFIX.as_bytes());
    bytes.extend_from_slice(fragment.as_bytes());
    bytes.extend_from_slice(SUFFIX.as_bytes());
    bytes.push(0);
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fragment_offsets_cover_all_unicode_text_and_multiple_images() {
        let fragment = format!(
            "<h1>東京 😀</h1><img src=\"data:image/png;base64,{}\"><p>終わり</p>",
            "A".repeat(1400)
        );
        let bytes = windows_html(&fragment);
        let header = std::str::from_utf8(&bytes[..105]).unwrap();
        let offset = |key: &str| -> usize {
            header
                .lines()
                .find_map(|line| line.strip_prefix(key))
                .unwrap()
                .parse()
                .unwrap()
        };
        let start = offset("StartFragment:");
        let end = offset("EndFragment:");
        assert_eq!(&bytes[start..end], fragment.as_bytes());
        assert_eq!(offset("StartHTML:"), 105);
        assert_eq!(offset("EndHTML:"), bytes.len() - 1);
        assert_eq!(&bytes[end..end + 18], b"<!--EndFragment-->");
        assert_eq!(bytes.last(), Some(&0));
        assert!(
            start < 1000,
            "a larger preceding offset must not leak digits into this one"
        );
    }
}
