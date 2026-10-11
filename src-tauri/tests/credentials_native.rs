//! Opt-in check against the real OS store, with a unique disposable test entry.
#[test]
fn native_store_persists_across_entry_instances() {
    if std::env::var_os("MARXEN_NATIVE_KEYRING_TEST").is_none() {
        return;
    }
    let user = format!(
        "test-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let original = keyring::Entry::new("dev.staka.marxen.test", &user).unwrap();
    struct Cleanup(keyring::Entry);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = self.0.delete_credential();
        }
    }
    let cleanup = Cleanup(original);
    cleanup
        .0
        .set_password("Marxen disposable native-store test")
        .unwrap();
    let reopened = keyring::Entry::new("dev.staka.marxen.test", &user).unwrap();
    assert_eq!(
        reopened.get_password().unwrap(),
        "Marxen disposable native-store test"
    );
    reopened.delete_credential().unwrap();
    assert!(matches!(
        cleanup.0.get_password(),
        Err(keyring::Error::NoEntry)
    ));
}
