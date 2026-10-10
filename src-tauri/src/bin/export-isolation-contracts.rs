use std::{fs, path::Path};

fn main() {
    let default_path =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/contracts/isolation-contracts.ts");
    let args: Vec<String> = std::env::args().collect();
    let path = args
        .windows(2)
        .find(|pair| pair[0] == "--output")
        .map(|pair| std::path::PathBuf::from(&pair[1]))
        .unwrap_or(default_path);
    let generated = marxen_lib::contracts::isolation::typescript();
    if std::env::args().any(|arg| arg == "--check") {
        let current = fs::read_to_string(&path).expect("Generate isolation contracts first");
        assert_eq!(
            current.replace("\r\n", "\n"),
            generated,
            "Run npm run isolation-contracts:generate and commit the result"
        );
    } else {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, generated).unwrap();
    }
    println!("Isolation IPC contract: {}", path.display());
}
