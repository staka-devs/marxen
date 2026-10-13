use std::{fs, path::Path};

fn main() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/shared/contracts.ts");
    let generated = marxen_lib::contracts::typescript();
    if std::env::args().any(|arg| arg == "--check") {
        let current = fs::read_to_string(&path).expect("Generate contracts first");
        assert_eq!(
            current.replace("\r\n", "\n"),
            generated,
            "Run npm run contracts:generate and commit the result"
        );
    } else {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, generated).unwrap();
    }
    println!("IPC contract: {}", path.display());
}
