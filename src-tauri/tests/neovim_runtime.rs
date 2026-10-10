use marxen_lib::neovim::{config::ConfigSource, rpc::RpcError, NeovimSession};
use std::time::{Duration, Instant};

#[test]
fn user_config_paths_support_spaces_and_unicode() {
    let directory = tempfile::tempdir().unwrap();
    let settings = directory.path().join("設定 フォルダー");
    std::fs::create_dir(&settings).unwrap();
    for (filename, source, expected) in [
        ("init.vim", "let g:marxen_marker = '日本語😀'\n", "日本語😀"),
        ("init.lua", "vim.g.marxen_marker = 'Lua 設定'\n", "Lua 設定"),
    ] {
        let path = settings.join(filename);
        std::fs::write(&path, source).unwrap();
        let session = NeovimSession::spawn_with_config(ConfigSource::UserFile(path)).unwrap();
        assert!(
            !session.config_report().has_errors(),
            "{:?}",
            session.config_report()
        );
        let value = session
            .client()
            .call("nvim_get_var", vec!["marxen_marker".into()])
            .unwrap();
        assert_eq!(value.as_str(), Some(expected));
    }
}

#[test]
fn exited_neovim_wakes_pending_rpc_without_waiting_for_timeout() {
    let session = NeovimSession::spawn_isolated().unwrap();
    std::thread::scope(|scope| {
        let request = scope.spawn(|| {
            session.client().call("nvim_exec_lua", vec![
                "vim.fn.rpcnotify(1, 'marxen:test-blocking'); vim.wait(10000, function() return false end); return true".into(),
                rmpv::Value::Array(vec![]),
            ])
        });
        assert!(session
            .client()
            .wait_notification(Duration::from_secs(2), |notification| notification.method
                == "marxen:test-blocking")
            .is_some());
        let started = Instant::now();
        session.client().shutdown().unwrap();
        let result = request.join().unwrap();
        assert!(
            matches!(result, Err(RpcError::Disconnected(_))),
            "{result:?}"
        );
        assert!(started.elapsed() < Duration::from_secs(2));
    });
}

#[test]
fn bundle_metadata_identifies_target_instead_of_version() {
    let bundle = marxen_lib::neovim::bundle_paths().unwrap();
    let target = if cfg!(windows) {
        "x86_64-pc-windows-msvc"
    } else if cfg!(target_os = "macos") && cfg!(target_arch = "aarch64") {
        "aarch64-apple-darwin"
    } else if cfg!(target_os = "macos") {
        "x86_64-apple-darwin"
    } else {
        "x86_64-unknown-linux-gnu"
    };
    assert_eq!(bundle.manifest_target, target);
}

#[test]
fn process_health_detects_the_owned_child_exit() {
    let session = NeovimSession::spawn_isolated().unwrap();
    assert!(session.is_alive().unwrap());
    session.client().shutdown().unwrap();
    assert!(!session.is_alive().unwrap());
}

#[test]
fn vim_writes_delegate_only_complete_owned_document_saves() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("文書 original.md");
    let other = directory.path().join("alternate.md");
    std::fs::write(&path, "original\n").unwrap();
    let session = NeovimSession::spawn_isolated().unwrap();
    session.set_buf_name(path.to_str().unwrap()).unwrap();
    session.set_text("first\nsecond\nthird").unwrap();
    session.command("setlocal buftype=acwrite").unwrap();
    session.install_save_intercept().unwrap();
    session.install_save_intercept().unwrap();
    for command in ["write", "write!"] {
        session.drain_notifications();
        session.command(command).unwrap();
        assert!(session
            .client()
            .wait_notification(Duration::from_secs(2), |event| event.method
                == "marxen:save-requested")
            .is_some());
        assert!(
            session.drain_save_requests().is_empty(),
            "duplicate save callbacks"
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "original\n");
    }
    let escaped = session
        .call_function("fnameescape", vec![other.to_str().unwrap().into()])
        .unwrap();
    for command in [
        format!("write {}", escaped.as_str().unwrap()),
        "1write".into(),
        format!("write >> {}", escaped.as_str().unwrap()),
    ] {
        session.drain_notifications();
        assert!(session.command(&command).is_err(), "accepted {command}");
        assert!(
            session.drain_save_requests().is_empty(),
            "delegated rejected {command}"
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "original\n");
        assert!(!other.exists(), "write bypassed Rust: {command}");
    }
}
