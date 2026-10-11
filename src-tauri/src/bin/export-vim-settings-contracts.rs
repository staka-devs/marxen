use std::{fs, path::Path};

/// Write Vim-settings TypeScript contracts to the default or `--output` path.
/// `--check` requires exact generated text after normalizing existing CRLF;
/// missing/stale output or failed filesystem operations panic.
fn main() {
    let default_path =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/contracts/vim-settings.ts");
    let args: Vec<String> = std::env::args().collect();
    let path = args
        .windows(2)
        .find(|pair| pair[0] == "--output")
        .map(|pair| std::path::PathBuf::from(&pair[1]))
        .unwrap_or(default_path);
    let generated = marxen_lib::contracts::vim_settings::typescript();
    if std::env::args().any(|arg| arg == "--check") {
        let current = fs::read_to_string(&path).expect("Generate vim-settings contracts first");
        assert_eq!(
            current.replace("\r\n", "\n"),
            generated,
            "Run the export-vim-settings-contracts helper and commit the result"
        );
    } else {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, generated).unwrap();
    }
    println!("Vim-settings IPC contract: {}", path.display());
}
