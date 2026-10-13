use std::{fs, path::Path};

fn main() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/shared/isolation-contracts.ts");
    let generated = marxen_lib::isolation::typescript();
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
