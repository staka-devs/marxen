use std::{fs, path::Path};

fn main() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/shared/ai-contracts.ts");
    let generated = marxen_lib::ai_contracts::typescript();
    if std::env::args().any(|arg| arg == "--check") {
        let current = fs::read_to_string(&path).expect("Generate AI contracts first");
        assert_eq!(
            current.replace("\r\n", "\n"),
            generated,
            "Run npm run ai-contracts:generate and commit the result"
        );
    } else {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, generated).unwrap();
    }
    println!("AI IPC contract: {}", path.display());
}
