//! AI protocol and lifecycle regression fixtures.
use super::acp::*;
use super::credentials::*;
use crate::application::ai::credentials::*;
use crate::application::ai::runs::*;
use crate::application::ai::usage::{UsageRegistry, MAX_USAGE_ENTRIES};
use crate::contracts::ai::*;
use crate::domain::ai::*;
use std::path::Path;
use std::sync::atomic::AtomicBool;

#[cfg(windows)]
#[test]
/// Resolve an official npm Codex shim directly to the native binary, retaining exact arguments.
fn codex_npm_account_reader_preserves_argv_without_launching_a_node_parent() {
    let root = tempfile::tempdir().unwrap();
    let shim = root.path().join("codex.cmd");
    std::fs::write(&shim, "test shim; never executed").unwrap();
    let (package, target) = if cfg!(target_arch = "aarch64") {
        ("codex-win32-arm64", "aarch64-pc-windows-msvc")
    } else {
        ("codex-win32-x64", "x86_64-pc-windows-msvc")
    };
    let executable = root
        .path()
        .join("node_modules/@openai")
        .join(package)
        .join("vendor")
        .join(target)
        .join("bin/codex.exe");
    std::fs::create_dir_all(executable.parent().unwrap()).unwrap();
    std::fs::write(&executable, "test binary; never executed").unwrap();
    let argv = AcpArgv {
        command: shim.to_string_lossy().into_owned(),
        args: vec!["app-server".into(), "--listen".into(), "stdio://".into()],
    };
    let launch = resolve_acp_launch(&argv).unwrap();
    assert!(launch.program.is_absolute());
    assert_eq!(launch.program, executable);
    assert_eq!(launch.args, argv.args);
}
mod regression {
    use super::*;
    use crate::contracts::{DocumentId, Revision, Utf16Offset, Utf16Range};

    /// Build a revision-7 Unicode context for wire/structural tests; its excerpt
    /// is deliberately not a snapshot-authorized slice of the `[1, 3)` source range.
    fn context() -> PromptContext {
        PromptContext {
            location: None,
            document_id: DocumentId("doc_01".into()),
            revision: Revision(7),
            ranges: vec![Utf16Range {
                start: Utf16Offset(1),
                end: Utf16Offset(3),
            }],
            text: "a😀日本語".into(),
        }
    }

    /// Build a Codex ACP ask request with one context, `copy_01`, and no session/history.
    fn acp_request() -> AiPromptRequest {
        AiPromptRequest {
            conversation_id: None,
            provider: AiProviderConfig {
                kind: AiProviderKind::Acp,
                acp: Some(AcpConfig {
                    selections: None,
                    preset: AcpPreset::Codex,
                    argv: None,
                }),
                openai: None,
                anthropic: None,
                connection_id: None,
            },
            mode: PromptMode::Ask,
            prompt: "これは何ですか".into(),
            contexts: vec![context()],
            staging: StagingTarget {
                copy_id: IsolatedCopyId("copy_01".into()),
            },
            session_id: None,
            history: vec![],
        }
    }

    /// Accept a bounded ASCII handle and reject empty, spaced, path-like, Unicode,
    /// and over-128-byte identifiers.
    #[test]
    fn handles_accept_valid_and_reject_bad() {
        assert!(validate_handle("copy_01", "x").is_ok());
        for bad in ["", "has space", "doc/1", "文書", &"x".repeat(129)] {
            assert!(validate_handle(bad, "x").is_err(), "{bad}");
        }
    }

    /// Reject recognized Claude Code command basenames across case/path variants
    /// while keeping unrelated and similarly prefixed executable names available.
    #[test]
    fn claude_commands_are_refused() {
        for command in [
            "claude",
            "CLAUDE",
            "claude.exe",
            "claude-code",
            "/usr/local/bin/claude",
            "C:\\tools\\claude.exe",
        ] {
            assert!(is_claude_command(command), "{command}");
            let argv = AcpArgv {
                command: command.into(),
                args: vec![],
            };
            assert!(matches!(
                validate_argv(&argv),
                Err(AiError::ClaudeCodeRefused { .. })
            ));
        }
        for command in ["codex", "opencode", "my-agent", "claudette", "claude-extra"] {
            assert!(!is_claude_command(command), "{command}");
        }
    }

    /// Require the official `codex-acp` argv, custom argv for custom mode, and no
    /// argv override for fixed presets; reject an empty custom command.
    #[test]
    fn preset_argv_resolution_is_strict() {
        let codex = AcpConfig {
            selections: None,
            preset: AcpPreset::Codex,
            argv: None,
        };
        assert_eq!(
            resolve_acp_argv(&codex).unwrap(),
            AcpArgv {
                // Official adapter binary, never `codex acp`.
                command: "codex-acp".into(),
                args: vec![]
            }
        );
        let custom_missing = AcpConfig {
            selections: None,
            preset: AcpPreset::Custom,
            argv: None,
        };
        assert!(resolve_acp_argv(&custom_missing).is_err());
        let preset_with_argv = AcpConfig {
            selections: None,
            preset: AcpPreset::Opencode,
            argv: Some(AcpArgv {
                command: "x".into(),
                args: vec![],
            }),
        };
        assert!(resolve_acp_argv(&preset_with_argv).is_err());
        let custom = AcpConfig {
            selections: None,
            preset: AcpPreset::Custom,
            argv: Some(AcpArgv {
                command: "my-agent".into(),
                args: vec!["--stdio".into()],
            }),
        };
        assert!(resolve_acp_argv(&custom).is_ok());
        let empty_command = AcpConfig {
            selections: None,
            preset: AcpPreset::Custom,
            argv: Some(AcpArgv {
                command: String::new(),
                args: vec![],
            }),
        };
        assert!(resolve_acp_argv(&empty_command).is_err());
    }

    /// Normalize trailing endpoint slashes and allow local HTTP, while rejecting
    /// unsupported/missing schemes, empty hosts, embedded credentials, and spaces.
    #[test]
    fn endpoint_validation_rejects_non_http_and_embedded_auth() {
        assert_eq!(
            validate_endpoint("https://api.example.com/v1/").unwrap(),
            "https://api.example.com/v1"
        );
        assert!(validate_endpoint("http://127.0.0.1:11434/v1").is_ok());
        for bad in [
            "ftp://x.test/v1",
            "api.example.com/v1",
            "",
            "https://",
            "https://user:pass@x.test/v1",
            "https://x.test/has space",
        ] {
            assert!(validate_endpoint(bad).is_err(), "{bad}");
        }
    }

    /// Require a single backend configuration matching its kind and explicit
    /// Anthropic opt-in without excluding the independent Anthropic API backend.
    #[test]
    fn provider_configs_must_match_kind_and_anthropic_is_opt_in() {
        assert!(validate_provider_config(&acp_request().provider).is_ok());
        let mut openai = AiProviderConfig {
            kind: AiProviderKind::OpenaiCompatible,
            acp: None,
            openai: Some(OpenAiConfig {
                endpoint: "https://api.example.com/v1".into(),
                model: "gpt-x".into(),
            }),
            anthropic: None,
            connection_id: None,
        };
        assert!(validate_provider_config(&openai).is_ok());
        openai.acp = Some(AcpConfig {
            selections: None,
            preset: AcpPreset::Codex,
            argv: None,
        });
        assert!(validate_provider_config(&openai).is_err());

        let disabled = AiProviderConfig {
            kind: AiProviderKind::Anthropic,
            acp: None,
            openai: None,
            anthropic: Some(AnthropicConfig {
                enabled: false,
                endpoint: "https://api.anthropic.example".into(),
                model: "claude-x".into(),
            }),
            connection_id: None,
        };
        assert!(matches!(
            validate_provider_config(&disabled),
            Err(AiError::InvalidConfig { .. })
        ));
        let mut enabled = disabled.clone();
        enabled.anthropic.as_mut().expect("set").enabled = true;
        assert!(validate_provider_config(&enabled).is_ok());
    }

    /// Keep source offsets independent of excerpt length/surrogate boundaries
    /// during structural validation; reject blank prompts, absent/reversed ranges,
    /// and HTTP session IDs, while permitting general questions without contexts.
    #[test]
    fn prompt_requests_check_ranges_structurally() {
        assert!(validate_prompt_request(&acp_request()).is_ok());
        let mut bad = acp_request();
        bad.prompt = "   ".into();
        assert!(validate_prompt_request(&bad).is_err());
        // Ranges are source-document offsets, so a nonzero offset beyond the
        // excerpt length is structurally valid here; authority checks against
        // the captured Rust snapshots (IsolationManager::authorize_prompt)
        // decide it in production. Surrogate and excerpt checks live there.
        let mut far = acp_request();
        far.contexts[0].ranges[0] = Utf16Range {
            start: Utf16Offset(100),
            end: Utf16Offset(105),
        };
        assert!(validate_prompt_request(&far).is_ok());
        let mut split = acp_request();
        split.contexts[0].ranges[0] = Utf16Range {
            start: Utf16Offset(2),
            end: Utf16Offset(3),
        }; // splits the surrogate pair of 😀 in the excerpt
        assert!(validate_prompt_request(&split).is_ok());
        let mut bad = acp_request();
        bad.contexts[0].ranges.clear();
        assert!(validate_prompt_request(&bad).is_err());
        let mut bad = acp_request();
        bad.contexts[0].ranges[0] = Utf16Range {
            start: Utf16Offset(4),
            end: Utf16Offset(1),
        };
        assert!(validate_prompt_request(&bad).is_err());
        let mut http = acp_request();
        http.provider = AiProviderConfig {
            kind: AiProviderKind::OpenaiCompatible,
            acp: None,
            openai: Some(OpenAiConfig {
                endpoint: "https://api.example.com/v1".into(),
                model: "m".into(),
            }),
            anthropic: None,
            connection_id: None,
        };
        http.session_id = Some(AcpSessionId("sess_1".into()));
        assert!(validate_prompt_request(&http).is_err());
        // Zero contexts are allowed for general questions.
        let mut bare = acp_request();
        bare.contexts.clear();
        assert!(validate_prompt_request(&bare).is_ok());
    }

    /// Freeze the exact Japanese mode instruction, document/revision/UTF-16 header,
    /// Unicode excerpt, and prompt delimiters rendered for one ask request.
    #[test]
    fn composed_message_has_exact_sent_scope() {
        let message = compose_user_message(PromptMode::Ask, "これは何ですか", &[context()]);
        assert_eq!(
            message,
            "文書について質問に回答してください。編集中の文書は変更しません。\n\
             --- context document=doc_01 revision=7 ranges=[1, 3) ---\n\
             a😀日本語\n\
             --- prompt ---\n\
             これは何ですか"
        );
    }

    /// Skip SSE comments, accept CRLF/LF framing, retain a split payload until
    /// completion, and drain an unterminated final data event at EOF.
    #[test]
    fn sse_decoder_survives_chunk_splits_comments_and_crlf() {
        let mut decoder = SseDecoder::default();
        let mut out = decoder.push(b": ping\r\n\r\ndata: {\"a\": 1}\n\ndata: part");
        assert_eq!(out, vec!["{\"a\": 1}"]);
        out = decoder.push(b"ial\n\n");
        assert_eq!(out, vec!["partial"]);
        assert_eq!(decoder.finish(), None);
        let mut decoder = SseDecoder::default();
        decoder.push(b"data: tail");
        assert_eq!(decoder.finish(), Some("tail".to_owned()));
    }

    /// Preserve Unicode deltas, ignore role-only chunks, classify bad-key errors
    /// as authentication failures, and fail on other provider errors or invalid JSON.
    #[test]
    fn openai_deltas_and_errors_map_correctly() {
        let delta = r#"{"choices": [{"delta": {"content": "日本語"}, "finish_reason": null}]}"#;
        assert_eq!(openai_delta_text(delta).unwrap(), Some("日本語".to_owned()));
        let role_only = r#"{"choices": [{"delta": {"role": "assistant"}}]}"#;
        assert_eq!(openai_delta_text(role_only).unwrap(), None);
        let auth = r#"{"error": {"message": "invalid_api_key", "code": "invalid_api_key"}}"#;
        assert!(matches!(
            openai_delta_text(auth),
            Err(AiError::AuthFailed { .. })
        ));
        let other = r#"{"error": {"message": "busy", "code": "server_error"}}"#;
        assert!(matches!(
            openai_delta_text(other),
            Err(AiError::StreamFailed { .. })
        ));
        assert!(openai_delta_text("not json").is_err());
    }

    /// Extract Anthropic text deltas and message-stop signals, ignore JSON/start
    /// noise, and classify authentication envelopes as `AuthFailed`.
    #[test]
    fn anthropic_signals_cover_text_end_error_and_noise() {
        let delta =
            r#"{"type": "content_block_delta", "delta": {"type": "text_delta", "text": "あ"}}"#;
        assert_eq!(
            anthropic_signal(delta).unwrap(),
            AnthropicSignal::Text("あ".into())
        );
        let json_delta =
            r#"{"type": "content_block_delta", "delta": {"type": "input_json_delta"}}"#;
        assert_eq!(
            anthropic_signal(json_delta).unwrap(),
            AnthropicSignal::Ignore
        );
        assert_eq!(
            anthropic_signal(r#"{"type": "message_stop"}"#).unwrap(),
            AnthropicSignal::End
        );
        assert_eq!(
            anthropic_signal(r#"{"type": "message_start"}"#).unwrap(),
            AnthropicSignal::Ignore
        );
        let auth =
            r#"{"type": "error", "error": {"type": "authentication_error", "message": "bad key"}}"#;
        assert!(matches!(
            anthropic_signal(auth),
            Err(AiError::AuthFailed { .. })
        ));
    }

    /// Accept HTTP 200, classify 401 as authentication failure, and 500 as connection failure.
    #[test]
    fn http_status_maps_to_auth_or_connection_errors() {
        assert!(map_http_status(200, "").is_none());
        assert!(matches!(
            map_http_status(401, "nope"),
            Some(AiError::AuthFailed { .. })
        ));
        assert!(matches!(
            map_http_status(500, "boom"),
            Some(AiError::ConnectionFailed { .. })
        ));
    }

    /// BufRead that yields at most `max` bytes per read, forcing the real
    /// NdjsonReader through fragmentation (including mid-UTF-8 splits).
    struct Chunked<'a> {
        data: &'a [u8],
        max: usize,
    }

    impl std::io::Read for Chunked<'_> {
        /// Copy at most `max` bytes into the caller's buffer and advance the remaining slice.
        /// Return zero at EOF or when the buffer/cap allows no bytes.
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            if self.data.is_empty() {
                return Ok(0);
            }
            let take = self.data.len().min(buf.len()).min(self.max);
            buf[..take].copy_from_slice(&self.data[..take]);
            self.data = &self.data[take..];
            Ok(take)
        }
    }

    impl std::io::BufRead for Chunked<'_> {
        /// Borrow all remaining fixture bytes independently of the `read` fragmentation cap.
        fn fill_buf(&mut self) -> std::io::Result<&[u8]> {
            Ok(self.data)
        }

        /// Advance by the requested byte count, clamped to the remaining fixture length.
        fn consume(&mut self, amount: usize) {
            self.data = &self.data[amount.min(self.data.len())..];
        }
    }

    /// Require one LF per compact ACP message and decode multiple envelopes
    /// both from whole-stream reads and 1–7-byte reads splitting Unicode scalars.
    #[test]
    fn ndjson_survives_fragmentation_coalescing_and_utf8_splits() {
        let first = serde_json::json!({"jsonrpc": "2.0", "id": 1});
        let second = serde_json::json!({"jsonrpc": "2.0", "method": "n", "params": {"text": "こんにちは世界"}});
        let mut bytes = encode_acp_message(&first);
        bytes.extend_from_slice(&encode_acp_message(&second));
        // Compact encoding: exactly one trailing newline per message, none inside.
        assert_eq!(bytes.iter().filter(|byte| **byte == b'\n').count(), 2);
        assert!(bytes.ends_with(b"\n"));

        // Fragmented reads down to one byte per read: splits fall inside
        // multibyte UTF-8 sequences and still decode.
        for max in [1usize, 2, 3, 7] {
            let mut reader = NdjsonReader::new(Chunked { data: &bytes, max });
            assert_eq!(reader.next_value().unwrap(), Some(first.clone()));
            assert_eq!(reader.next_value().unwrap(), Some(second.clone()));
            assert_eq!(reader.next_value().unwrap(), None);
        }

        // Coalesced read: the whole stream at once also works.
        let mut reader = NdjsonReader::new(&bytes[..]);
        assert_eq!(reader.next_value().unwrap(), Some(first));
        assert_eq!(reader.next_value().unwrap(), Some(second));
        assert_eq!(reader.next_value().unwrap(), None);
    }

    /// Reject invalid UTF-8/JSON, truncated EOF lines, and oversized ACP lines;
    /// distinguish clean EOF and tolerate empty lines plus CRLF framing.
    #[test]
    fn ndjson_rejects_bad_lines_and_limits_size() {
        // Invalid UTF-8.
        let mut reader = NdjsonReader::new(&b"\xff\xfe\n"[..]);
        assert!(matches!(
            reader.next_value(),
            Err(AiError::StreamFailed { .. })
        ));
        // Invalid JSON.
        let mut reader = NdjsonReader::new(&b"{oops}\n"[..]);
        assert!(reader.next_value().is_err());
        // Clean EOF.
        let mut reader = NdjsonReader::new(&[][..]);
        assert_eq!(reader.next_value().unwrap(), None);
        // Truncated line at EOF.
        let mut reader = NdjsonReader::new(&b"{\"a\": 1"[..]);
        assert!(reader.next_value().is_err());
        // Oversized line.
        let mut big = vec![b' '; MAX_ACP_LINE_BYTES + 16];
        big.push(b'\n');
        let mut reader = NdjsonReader::new(&big[..]);
        assert!(reader.next_value().is_err());
        // Empty lines are skipped, CRLF is tolerated.
        let mut reader = NdjsonReader::new(&b"\n{\"a\": 1}\r\n\n"[..]);
        assert_eq!(
            reader.next_value().unwrap(),
            Some(serde_json::json!({"a": 1}))
        );
        assert_eq!(reader.next_value().unwrap(), None);
    }

    /// Route response IDs, notifications, and agent requests to distinct variants,
    /// preserving request ID/method and rejecting an envelope with neither.
    #[test]
    fn incoming_messages_classify_by_id_and_method() {
        let response = serde_json::json!({"jsonrpc": "2.0", "id": 3, "result": {}});
        assert!(matches!(
            classify_incoming(response),
            Ok(AgentIncoming::Response { .. })
        ));
        let notification = serde_json::json!({"jsonrpc": "2.0", "method": "session/update"});
        assert!(matches!(
            classify_incoming(notification),
            Ok(AgentIncoming::Notification(_))
        ));
        let agent_request = serde_json::json!({
            "jsonrpc": "2.0", "id": 9, "method": "session/request_permission", "params": {}
        });
        match classify_incoming(agent_request).unwrap() {
            AgentIncoming::AgentRequest { id, method, .. } => {
                assert_eq!(id, serde_json::json!(9));
                assert_eq!(method, "session/request_permission");
            }
            other => panic!("expected agent request, got {other:?}"),
        }
        let malformed = serde_json::json!({"jsonrpc": "2.0"});
        assert!(classify_incoming(malformed).is_err());
    }

    /// Accept ACP v1, reject v2 or missing negotiation, and preserve the unsupported
    /// version number through serialized error round-trips.
    #[test]
    fn protocol_version_negotiation_is_explicit() {
        let ok = serde_json::json!({"result": {"protocolVersion": 1}});
        assert_eq!(check_protocol_version(&ok).unwrap(), 1);
        let newer = serde_json::json!({"result": {"protocolVersion": 2}});
        assert!(matches!(
            check_protocol_version(&newer),
            Err(AiError::UnsupportedProtocol { version: 2 })
        ));
        let missing = serde_json::json!({"result": {}});
        assert!(check_protocol_version(&missing).is_err());
        let roundtrip: AiError = serde_json::from_value(
            serde_json::to_value(AiError::UnsupportedProtocol { version: 2 }).unwrap(),
        )
        .unwrap();
        assert_eq!(roundtrip, AiError::UnsupportedProtocol { version: 2 });
    }

    /// Select the reject option in the exact ACP outcome shape, cancel explicitly
    /// or when only approval exists, and retain IDs in unsupported-method errors.
    #[test]
    fn permission_answers_deny_by_default_with_exact_shapes() {
        let params = serde_json::json!({
            "options": [
                { "optionId": "allow", "name": "許可", "kind": "allow_once" },
                { "optionId": "deny", "name": "拒否", "kind": "reject_once" }
            ]
        });
        assert_eq!(
            answer_permission(&params, PermissionAnswer::Deny),
            serde_json::json!({
                "outcome": { "outcome": "selected", "optionId": "deny" }
            })
        );
        assert_eq!(
            answer_permission(&params, PermissionAnswer::Cancelled),
            serde_json::json!({ "outcome": { "outcome": "cancelled" } })
        );
        let without_reject = serde_json::json!({
            "options": [{ "optionId": "allow", "name": "許可", "kind": "allow_always" }]
        });
        assert_eq!(
            answer_permission(&without_reject, PermissionAnswer::Deny),
            serde_json::json!({ "outcome": { "outcome": "cancelled" } })
        );
        let unknown = method_not_found(&serde_json::json!(7), "fs/read_text_file");
        assert_eq!(unknown["error"]["code"], -32601);
        assert_eq!(unknown["id"], 7);
    }

    /// Recognize all five supported prompt stop reasons, including cancellation,
    /// and reject a response missing `stopReason`.
    #[test]
    fn stop_reasons_route_cancellation() {
        for (raw, expected) in [
            ("end_turn", StopReason::EndTurn),
            ("max_tokens", StopReason::MaxTokens),
            ("max_turn_requests", StopReason::MaxTurnRequests),
            ("refusal", StopReason::Refusal),
            ("cancelled", StopReason::Cancelled),
        ] {
            let body = serde_json::json!({"result": {"stopReason": raw}});
            assert_eq!(parse_stop_reason(&body).unwrap(), expected);
        }
        assert!(parse_stop_reason(&serde_json::json!({"result": {}})).is_err());
    }

    /// Preserve initialize identity/version, staging cwd with no MCP servers,
    /// session prompt scope, ID-free cancellation, and text-only update extraction.
    #[test]
    fn acp_builders_and_update_parsing_keep_protocol_shape() {
        let init = acp_initialize(1);
        assert_eq!(init["method"], "initialize");
        assert_eq!(init["params"]["protocolVersion"], 1);
        assert_eq!(init["params"]["clientInfo"]["name"], "marxen");
        assert_eq!(
            init["params"]["clientCapabilities"]["fs"]["readTextFile"],
            serde_json::json!(true)
        );
        assert_eq!(
            init["params"]["clientCapabilities"]["fs"]["writeTextFile"],
            serde_json::json!(true)
        );
        let dir = Path::new("/tmp/staging-copy");
        let new = acp_session_new(2, dir);
        assert_eq!(new["params"]["cwd"], "/tmp/staging-copy");
        assert_eq!(new["params"]["mcpServers"], serde_json::json!([]));
        let prompt = acp_session_prompt(3, "sess_1", PromptMode::Ask, "p", &[context()]);
        assert_eq!(prompt["params"]["sessionId"], "sess_1");
        assert!(prompt["params"]["prompt"][0]["text"]
            .as_str()
            .expect("text")
            .contains("doc_01"));
        // session/cancel is a notification: no id.
        let cancel = acp_session_cancel_notification("sess_1");
        assert_eq!(cancel["method"], "session/cancel");
        assert!(cancel.get("id").is_none());

        let update = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": "sess_1",
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": { "type": "text", "text": "あい" }
                }
            }
        });
        assert_eq!(acp_update_text(&update), Some("あい".to_owned()));
        let tool_call = serde_json::json!({
            "method": "session/update",
            "params": { "update": { "sessionUpdate": "tool_call" } }
        });
        assert_eq!(acp_update_text(&tool_call), None);
    }

    /// Parse real tool-call lifecycles in order without fabricating timelines.
    ///
    /// Pending announces, in-progress patches, and completed settlement keep
    /// their IDs; foreign sessions and malformed lists are dropped.
    #[test]
    fn agentic_tool_lifecycle_orders_pending_to_completed() {
        use std::path::Path;
        let staging = Path::new("/tmp/staging-copy");
        let announced = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": "sess_1",
                "update": {
                    "sessionUpdate": "tool_call",
                    "toolCallId": "call_1",
                    "title": "Reading file",
                    "kind": "read",
                    "status": "pending",
                    "locations": [{ "path": "/tmp/staging-copy/a.md" }]
                }
            }
        });
        let call = parse_tool_call_notification(&announced, "sess_1", staging).expect("tool call");
        assert_eq!(call.tool_call_id, "call_1");
        assert_eq!(call.kind, AcpToolKind::Read);
        assert_eq!(call.status, AcpToolStatus::Pending);
        assert_eq!(call.locations.expect("locations")[0].path, "a.md");
        let foreign = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": "sess_other",
                "update": {
                    "sessionUpdate": "tool_call",
                    "toolCallId": "call_1",
                    "title": "Reading file",
                    "kind": "read",
                    "status": "pending"
                }
            }
        });
        assert!(parse_tool_call_notification(&foreign, "sess_1", staging).is_none());
        let progress = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": "sess_1",
                "update": {
                    "sessionUpdate": "tool_call_update",
                    "toolCallId": "call_1",
                    "status": "in_progress"
                }
            }
        });
        let update =
            parse_tool_call_update_notification(&progress, "sess_1", staging).expect("update");
        assert_eq!(update.status, Some(AcpToolStatus::InProgress));
        let done = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": "sess_1",
                "update": {
                    "sessionUpdate": "tool_call_update",
                    "toolCallId": "call_1",
                    "status": "completed",
                    "content": [{ "type": "diff", "path": "/tmp/staging-copy/a.md", "oldText": "a", "newText": "b" }]
                }
            }
        });
        let finished = parse_tool_call_update_notification(&done, "sess_1", staging).expect("done");
        assert_eq!(finished.status, Some(AcpToolStatus::Completed));
        match finished.content.expect("diff").first().expect("item") {
            ToolCallContent::Diff { path, new_text, .. } => {
                assert_eq!(path, "/tmp/staging-copy/a.md");
                assert_eq!(new_text, "b");
            }
            other => panic!("expected diff, got {other:?}"),
        }
    }

    /// Replace execution plans completely and surface permission by actual IDs.
    ///
    /// Plans require every entry; permissions require real option IDs and
    /// answer with the selected ID (deny) or the cancelled outcome.
    #[test]
    fn agentic_plan_and_permission_use_actual_ids() {
        let plan = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": "sess_1",
                "update": {
                    "sessionUpdate": "plan",
                    "entries": [
                        { "content": "Read", "priority": "high", "status": "pending" },
                        { "content": "Edit", "priority": "medium", "status": "in_progress" }
                    ]
                }
            }
        });
        let entries = parse_plan_notification(&plan, "sess_1").expect("plan");
        assert_eq!(entries.len(), 2);
        assert!(parse_plan_notification(&plan, "sess_other").is_none());
        let params = serde_json::json!({
            "sessionId": "sess_1",
            "toolCall": { "toolCallId": "call_1", "title": "mock tool" },
            "options": [
                { "optionId": "mock_allow", "name": "allow", "kind": "allow_once" },
                { "optionId": "mock_reject", "name": "deny", "kind": "reject_once" }
            ]
        });
        let parsed =
            parse_permission_request(&serde_json::json!(900), &params).expect("permission");
        assert_eq!(parsed.request_id, "900");
        assert_eq!(parsed.options.len(), 2);
        assert_eq!(
            answer_permission_by_id("mock_reject", false),
            serde_json::json!({ "outcome": { "outcome": "selected", "optionId": "mock_reject" } })
        );
        assert_eq!(
            answer_permission_by_id("mock_reject", true),
            serde_json::json!({ "outcome": { "outcome": "cancelled" } })
        );
        assert_eq!(
            stringify_request_id(&serde_json::json!(900)),
            Some("900".to_owned())
        );
        assert!(stringify_request_id(&serde_json::json!(null)).is_none());
    }

    /// Contain file access to the authorized staging directory.
    ///
    /// Absolute outside paths, relative paths, and symlink escapes are
    /// rejected; contained absolute paths are allowed for fs methods.
    /// Domain rules stay pure lexical; the infrastructure check adds the
    /// canonical filesystem read for existing files.
    #[test]
    fn agentic_staging_paths_reject_outside_access() {
        use std::path::Path;
        let scratch = tempfile::tempdir().expect("scratch dir");
        let staging = scratch.path().join("staging");
        std::fs::create_dir_all(&staging).expect("staging dir");
        let inside = staging.join("a.md").to_string_lossy().replace('\\', "/");
        let outside = scratch
            .path()
            .join("other-a.md")
            .to_string_lossy()
            .replace('\\', "/");
        // On Windows the lossy slash form stays absolute via the temp root.
        let staging_abs = staging.to_string_lossy().replace('\\', "/");
        for check in [staging_path_is_contained, staging_path_allowed] {
            assert!(check(&staging, &inside));
            assert!(!check(&staging, &outside));
            assert!(!check(&staging, "relative/a.md"));
            assert!(!check(&staging, &staging_abs));
        }
        assert_eq!(display_path_for_staging(&inside, &staging), "a.md");
        let _ = Path::new("/tmp");
    }

    /// Accept staging paths that differ lexically but resolve canonically.
    ///
    /// macOS reports the agent `current_dir` as `/private/var/...` while the
    /// test `temp_dir` keeps `/var/...`; Windows canonicalizes to UNC
    /// `\\?\...` versus the drive-letter form. The domain rule stays purely
    /// lexical, but the infrastructure gate must fall back to canonical
    /// comparison for absolute existing paths so the mock's
    /// `fs/read_text_file` round-trip succeeds. Traversal (`..`) is rejected
    /// before either acceptance even when it resolves inside, and outside,
    /// relative, and symlink-escape paths stay rejected through every alias
    /// form. The scratch directory is uniquely owned: nothing shared is
    /// created or deleted.
    #[test]
    fn agentic_staging_paths_accept_canonical_aliases() {
        let scratch = tempfile::tempdir().expect("scratch dir");
        let staging = scratch.path().join("staging");
        std::fs::create_dir_all(staging.join("subdir")).expect("staging dir");
        std::fs::write(staging.join("a.md"), "# Seed\n").expect("seed file");
        std::fs::write(scratch.path().join("other.md"), "other\n").expect("outside file");
        let lexical_inside = staging.join("a.md").to_string_lossy().into_owned();
        // Traversal is never authorized even when it resolves inside staging.
        let inner_traversal = staging
            .join("subdir")
            .join("..")
            .join("a.md")
            .to_string_lossy()
            .into_owned();
        assert!(!staging_path_allowed(&staging, &inner_traversal));
        let escaping_traversal = staging
            .join("..")
            .join("other.md")
            .to_string_lossy()
            .into_owned();
        assert!(!staging_path_allowed(&staging, &escaping_traversal));
        // The exact IPC read refuses traversal with the outside-path error.
        let params = serde_json::json!({"sessionId": "sess_1", "path": inner_traversal});
        assert!(serve_fs_read(&staging, "sess_1", &params).is_err());
        let canonical_root = staging.canonicalize().expect("canonical staging");
        let alias_inside = canonical_root.join("a.md");
        let alias_str = alias_inside.to_string_lossy().into_owned();
        if alias_str != lexical_inside {
            // Lexically different alias: the domain rule stays strict while
            // the infrastructure gate resolves the identical file.
            assert!(
                !staging_path_is_contained(&staging, &alias_str),
                "alias must differ lexically, got {alias_str}"
            );
            assert!(staging_path_allowed(&staging, &alias_str));
            // The exact IPC read succeeds through the alias with verbatim bytes.
            let params = serde_json::json!({"sessionId": "sess_1", "path": alias_str});
            let reply = serve_fs_read(&staging, "sess_1", &params).expect("alias read");
            assert_eq!(
                reply.get("content").and_then(|content| content.as_str()),
                Some("# Seed\n")
            );
            // Canonical escapes through the alias stay rejected.
            let alias_outside = canonical_root
                .join("..")
                .join("other.md")
                .to_string_lossy()
                .into_owned();
            assert!(!staging_path_allowed(&staging, &alias_outside));
        }
        // Symlink aliases resolve the same way on Unix; the link lives in the
        // owned scratch directory so nothing shared is touched.
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let link = scratch.path().join("link");
            symlink(&staging, &link).expect("staging symlink");
            let linked = link.join("a.md").to_string_lossy().into_owned();
            assert!(staging_path_allowed(&staging, &linked));
            let params = serde_json::json!({"sessionId": "sess_1", "path": linked});
            let reply = serve_fs_read(&staging, "sess_1", &params).expect("link read");
            assert_eq!(
                reply.get("content").and_then(|content| content.as_str()),
                Some("# Seed\n")
            );
            let link_outside = link
                .join("..")
                .join("other.md")
                .to_string_lossy()
                .into_owned();
            assert!(!staging_path_allowed(&staging, &link_outside));
        }
        // The plain lexical path keeps working and guards stay intact.
        assert!(staging_path_allowed(&staging, &lexical_inside));
    }

    /// Bind permission replies to exact run/request IDs and offered options.
    ///
    /// Unknown runs, stale requests, and unoffered options fail without
    /// recording; a validated choice is delivered exactly once and run
    /// cleanup drops every remaining slot.
    #[test]
    fn agentic_permission_replies_require_exact_ids_and_options() {
        let registry = RunRegistry::new();
        let (run_id, _) = registry.register();
        let options = vec![
            PermissionOption {
                option_id: "mock_allow".into(),
                name: "allow".into(),
                kind: PermissionOptionKind::AllowOnce,
            },
            PermissionOption {
                option_id: "mock_reject".into(),
                name: "deny".into(),
                kind: PermissionOptionKind::RejectOnce,
            },
        ];
        registry
            .register_permission(&run_id, "900", "sess_1", options)
            .unwrap();
        // Foreign request IDs and invented options never record a choice.
        assert!(matches!(
            registry.reply_permission(&run_id, "901", "mock_reject"),
            Err(AiError::UnknownSession)
        ));
        assert!(matches!(
            registry.reply_permission(&run_id, "900", "mock_other"),
            Err(AiError::InvalidConfig { .. })
        ));
        let unknown_run = AiRunId("run_9999".into());
        assert!(matches!(
            registry.reply_permission(&unknown_run, "900", "mock_reject"),
            Err(AiError::UnknownSession)
        ));
        registry
            .reply_permission(&run_id, "900", "mock_reject")
            .unwrap();
        assert_eq!(
            registry.take_permission_reply(&run_id, "900"),
            Some("mock_reject".to_owned())
        );
        // Each choice delivers a single time.
        assert_eq!(registry.take_permission_reply(&run_id, "900"), None);
        // Settlement cleanup drops remaining slots for the run.
        registry
            .register_permission(
                &run_id,
                "901",
                "sess_1",
                vec![PermissionOption {
                    option_id: "mock_reject".into(),
                    name: "deny".into(),
                    kind: PermissionOptionKind::RejectOnce,
                }],
            )
            .unwrap();
        registry.remove(&run_id);
        assert!(matches!(
            registry.reply_permission(&run_id, "901", "mock_reject"),
            Err(AiError::UnknownSession)
        ));
    }

    /// Bound one permission wait to the remaining overall prompt budget.
    ///
    /// A late permission never restarts the full run deadline: a nearly spent
    /// budget waits almost nothing, while a fresh long budget caps at the
    /// interactive 120-second ceiling.
    #[test]
    fn agentic_permission_wait_uses_remaining_prompt_budget() {
        use std::time::{Duration, Instant};
        let started = Instant::now();
        // Nearly spent overall budget: the wait ends with the run deadline.
        let late = started + Duration::from_secs(29);
        let until = permission_wait_until(started, Duration::from_secs(30), late);
        assert!(until >= late);
        assert!(until <= started + Duration::from_secs(30) + Duration::from_millis(10));
        // Fresh long budget: capped at the interactive ceiling, not restarted.
        let fresh = permission_wait_until(started, Duration::from_secs(300), started);
        assert!(fresh <= started + Duration::from_secs(120) + Duration::from_millis(10));
        assert!(fresh > started + Duration::from_secs(100));
    }

    /// Accept exactly one choice per pending request across concurrent replies.
    ///
    /// The first valid choice wins; duplicates, late replies after delivery,
    /// and replies after run settlement all fail without touching the agent.
    #[test]
    fn agentic_permission_accepts_at_most_one_concurrent_choice() {
        use std::sync::Arc;
        let registry = Arc::new(RunRegistry::new());
        let (run_id, _) = registry.register();
        let options = || {
            vec![
                PermissionOption {
                    option_id: "mock_allow".into(),
                    name: "allow".into(),
                    kind: PermissionOptionKind::AllowOnce,
                },
                PermissionOption {
                    option_id: "mock_reject".into(),
                    name: "deny".into(),
                    kind: PermissionOptionKind::RejectOnce,
                },
            ]
        };
        registry
            .register_permission(&run_id, "900", "sess_1", options())
            .unwrap();
        let first = Arc::new(std::sync::Mutex::new(Vec::new()));
        let handles: Vec<_> = ["mock_allow", "mock_reject"]
            .into_iter()
            .map(|choice| {
                let registry = Arc::clone(&registry);
                let run_id = run_id.clone();
                let first = Arc::clone(&first);
                std::thread::spawn(move || {
                    let outcome = registry.reply_permission(&run_id, "900", choice);
                    first
                        .lock()
                        .expect("result lock")
                        .push((choice, outcome.is_ok()));
                })
            })
            .collect();
        for handle in handles {
            handle.join().expect("reply thread");
        }
        let outcomes = first.lock().expect("result lock");
        assert_eq!(
            outcomes.iter().filter(|(_, ok)| *ok).count(),
            1,
            "exactly one concurrent choice wins, got {outcomes:?}"
        );
        // A second choice before delivery is a duplicate and fails.
        assert!(matches!(
            registry.reply_permission(&run_id, "900", "mock_reject"),
            Err(AiError::InvalidConfig { .. })
        ));
        // The recorded choice delivers exactly once.
        assert!(registry.take_permission_reply(&run_id, "900").is_some());
        assert_eq!(registry.take_permission_reply(&run_id, "900"), None);
        // Late replies after driver cleanup fail as stale.
        registry.drop_permission(&run_id, "900");
        assert!(matches!(
            registry.reply_permission(&run_id, "900", "mock_allow"),
            Err(AiError::UnknownSession)
        ));
    }

    /// Build the two mock permission options shared by reply-race tests.
    fn mock_permission_options() -> Vec<PermissionOption> {
        vec![
            PermissionOption {
                option_id: "mock_allow".into(),
                name: "allow".into(),
                kind: PermissionOptionKind::AllowOnce,
            },
            PermissionOption {
                option_id: "mock_reject".into(),
                name: "deny".into(),
                kind: PermissionOptionKind::RejectOnce,
            },
        ]
    }

    /// Reject a second reply arriving after take but before driver drop.
    ///
    /// The driver consumes the deliverable first and drops the slot second;
    /// the retained consumed state keeps the gap from accepting the same
    /// request twice. Cleanup still resets the slot so a retried agent
    /// request with the same ID answers again.
    #[test]
    fn agentic_permission_reply_rejected_after_take_before_drop() {
        let registry = RunRegistry::new();
        let (run_id, _) = registry.register();
        registry
            .register_permission(&run_id, "900", "sess_1", mock_permission_options())
            .unwrap();
        registry
            .reply_permission(&run_id, "900", "mock_allow")
            .unwrap();
        // Driver consumes the deliverable before dropping the slot.
        assert_eq!(
            registry.take_permission_reply(&run_id, "900"),
            Some("mock_allow".to_owned())
        );
        // A reply in the take-before-drop gap is a duplicate, not a new vote.
        assert!(matches!(
            registry.reply_permission(&run_id, "900", "mock_reject"),
            Err(AiError::InvalidConfig { .. })
        ));
        assert_eq!(registry.take_permission_reply(&run_id, "900"), None);
        // Driver cleanup drops the slot; late replies fail as stale.
        registry.drop_permission(&run_id, "900");
        assert!(matches!(
            registry.reply_permission(&run_id, "900", "mock_reject"),
            Err(AiError::UnknownSession)
        ));
        // A retried agent request reusing the same ID starts unanswered.
        registry
            .register_permission(&run_id, "900", "sess_1", mock_permission_options())
            .unwrap();
        registry
            .reply_permission(&run_id, "900", "mock_reject")
            .unwrap();
        assert_eq!(
            registry.take_permission_reply(&run_id, "900"),
            Some("mock_reject".to_owned())
        );
    }

    /// Reject permission replies for a cancelled run that is still registered.
    ///
    /// Cancellation only flips the run flag; settlement removes the run
    /// later. Registration alone therefore cannot decide replyability: the
    /// cancel flag rejects the reply while the run entry still exists.
    #[test]
    fn agentic_permission_reply_rejected_for_cancelled_run() {
        let registry = RunRegistry::new();
        let (run_id, _) = registry.register();
        registry
            .register_permission(&run_id, "900", "sess_1", mock_permission_options())
            .unwrap();
        assert!(registry.cancel(&run_id));
        // The run is still registered, but its cancelled flag refuses replies.
        assert!(registry.cancel_flag(&run_id).is_some());
        assert!(matches!(
            registry.reply_permission(&run_id, "900", "mock_allow"),
            Err(AiError::RequestCancelled)
        ));
        assert_eq!(registry.take_permission_reply(&run_id, "900"), None);
        // Settlement removes the run; replies then fail as stale.
        registry.remove(&run_id);
        assert!(matches!(
            registry.reply_permission(&run_id, "900", "mock_allow"),
            Err(AiError::UnknownSession)
        ));
    }

    /// Reject unauthorized staged file access without touching the filesystem.
    ///
    /// Wrong sessions, outside paths, and `ask`-mode writes fail; a contained
    /// write/read roundtrip inside the staging directory succeeds.
    #[test]
    fn agentic_staged_file_access_rejects_wrong_session_and_path() {
        let root = tempfile::tempdir().unwrap();
        let staging = root.path().join("copy_1");
        std::fs::create_dir_all(&staging).unwrap();
        let inside = staging.join("a.md");
        let inside_text = inside.to_string_lossy().into_owned();
        let outside = root.path().join("outside.md");
        let outside_text = outside.to_string_lossy().into_owned();
        std::fs::write(&outside, "outside").unwrap();
        // Wrong sessions never read, wherever the path points.
        assert!(serve_fs_read(
            &staging,
            "sess_1",
            &serde_json::json!({ "sessionId": "sess_other", "path": inside_text }),
        )
        .is_err());
        // Outside paths never read, even with the right session.
        assert!(serve_fs_read(
            &staging,
            "sess_1",
            &serde_json::json!({ "sessionId": "sess_1", "path": outside_text }),
        )
        .is_err());
        // `ask` turns never write, even inside their own staging copy.
        assert!(serve_fs_write(
            &staging,
            "sess_1",
            &serde_json::json!({ "sessionId": "sess_1", "path": inside_text, "content": "x" }),
            PromptMode::Ask,
        )
        .is_err());
        // A contained workspace write/read roundtrip succeeds verbatim.
        serve_fs_write(
            &staging,
            "sess_1",
            &serde_json::json!({ "sessionId": "sess_1", "path": inside_text, "content": "hello staging" }),
            PromptMode::Workspace,
        )
        .unwrap();
        let body = serve_fs_read(
            &staging,
            "sess_1",
            &serde_json::json!({ "sessionId": "sess_1", "path": inside_text }),
        )
        .unwrap();
        assert_eq!(body["content"], "hello staging");
        assert_eq!(std::fs::read_to_string(&inside).unwrap(), "hello staging");
    }

    /// Reject absent destinations below outside-pointing symlinked parents.
    ///
    /// A symlinked staging parent resolving outside the owned root must refuse
    /// creation with no outside file created or modified, while an ordinary
    /// absent-file write and a permitted internal alias succeed verbatim. The
    /// scratch directory is uniquely owned. Symlink creation needs privilege
    /// on Windows, so those branches only execute on Unix; public macOS/Linux
    /// CI verifies them and Windows reports them as unexecuted.
    #[test]
    fn agentic_write_rejects_absent_file_below_outside_symlink() {
        let scratch = tempfile::tempdir().expect("scratch dir");
        let staging = scratch.path().join("staging");
        std::fs::create_dir_all(staging.join("sub")).expect("staging dir");
        let outside = scratch.path().join("outside");
        std::fs::create_dir_all(&outside).expect("outside dir");
        std::fs::write(outside.join("keep.md"), "keep\n").expect("sentinel");
        // An ordinary absent-file write succeeds verbatim, nested or not.
        for rel in ["new.md", "sub/nested.md"] {
            let dest = staging.join(rel).to_string_lossy().into_owned();
            serve_fs_write(
                &staging,
                "sess_1",
                &serde_json::json!({"sessionId": "sess_1", "path": dest, "content": "hello staging"}),
                PromptMode::Workspace,
            )
            .unwrap_or_else(|_| panic!("ordinary write for {rel}"));
            assert_eq!(
                std::fs::read_to_string(staging.join(rel)).unwrap(),
                "hello staging"
            );
        }
        // Symlink branches need link privilege: Unix-only execution.
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            // An outside-pointing parent refuses creation and modifies nothing.
            let link = staging.join("link");
            symlink(&outside, &link).expect("outside symlink");
            let evil = link.join("evil.md").to_string_lossy().into_owned();
            assert!(serve_fs_write(
                &staging,
                "sess_1",
                &serde_json::json!({"sessionId": "sess_1", "path": evil, "content": "pwned"}),
                PromptMode::Workspace,
            )
            .is_err());
            assert!(!outside.join("evil.md").exists());
            assert_eq!(
                std::fs::read_to_string(outside.join("keep.md")).unwrap(),
                "keep\n"
            );
            // A permitted internal alias writes inside verbatim.
            let inner = staging.join("inner");
            symlink(staging.join("sub"), &inner).expect("internal symlink");
            let note = inner.join("note.md").to_string_lossy().into_owned();
            serve_fs_write(
                &staging,
                "sess_1",
                &serde_json::json!({"sessionId": "sess_1", "path": note, "content": "inside"}),
                PromptMode::Workspace,
            )
            .expect("internal alias write");
            assert_eq!(
                std::fs::read_to_string(staging.join("sub").join("note.md")).unwrap(),
                "inside"
            );
        }
    }

    /// Authorize absent destinations through valid canonical aliases.
    ///
    /// A previously absent destination reached through a canonical alias of
    /// the owned root (platform alias or Unix root symlink) resolves inside
    /// staging and must succeed, while dangling links and missing staging
    /// roots fail closed with nothing created. The scratch directory is
    /// uniquely owned. Symlink branches only execute on Unix; public
    /// macOS/Linux CI verifies them and Windows reports them as unexecuted.
    #[test]
    fn agentic_staging_allows_absent_destinations_through_valid_aliases() {
        let scratch = tempfile::tempdir().expect("scratch dir");
        let staging = scratch.path().join("staging");
        std::fs::create_dir_all(&staging).expect("staging dir");
        // Platform-alias branch when the canonical root differs lexically
        // (macOS /private/var, Windows UNC): the absent destination succeeds.
        let canonical_root = staging.canonicalize().expect("canonical staging");
        let canonical_dest = canonical_root
            .join("fresh.md")
            .to_string_lossy()
            .into_owned();
        let lexical_dest = staging.join("fresh.md").to_string_lossy().into_owned();
        if canonical_dest != lexical_dest {
            assert!(staging_path_allowed(&staging, &canonical_dest));
            serve_fs_write(
                &staging,
                "sess_1",
                &serde_json::json!({"sessionId": "sess_1", "path": canonical_dest, "content": "fresh alias"}),
                PromptMode::Workspace,
            )
            .expect("alias absent-file write");
            assert_eq!(
                std::fs::read_to_string(staging.join("fresh.md")).unwrap(),
                "fresh alias"
            );
        }
        // A missing staging root fails closed for gate, read, and write alike.
        let ghost = scratch.path().join("ghost");
        let ghost_dest = ghost.join("a.md").to_string_lossy().into_owned();
        assert!(!staging_path_allowed(&ghost, &ghost_dest));
        assert!(serve_fs_read(
            &ghost,
            "sess_1",
            &serde_json::json!({"sessionId": "sess_1", "path": ghost_dest}),
        )
        .is_err());
        assert!(serve_fs_write(
            &ghost,
            "sess_1",
            &serde_json::json!({"sessionId": "sess_1", "path": ghost_dest, "content": "x"}),
            PromptMode::Workspace,
        )
        .is_err());
        assert!(!ghost.exists());
        // Symlink branches need link privilege: Unix-only execution.
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            // A root symlink is a valid alias: the absent destination succeeds.
            let root_link = scratch.path().join("root-link");
            symlink(&staging, &root_link).expect("root symlink");
            let via_link = root_link.join("via-link.md").to_string_lossy().into_owned();
            assert!(staging_path_allowed(&staging, &via_link));
            serve_fs_write(
                &staging,
                "sess_1",
                &serde_json::json!({"sessionId": "sess_1", "path": via_link, "content": "via link"}),
                PromptMode::Workspace,
            )
            .expect("root-link absent-file write");
            assert_eq!(
                std::fs::read_to_string(staging.join("via-link.md")).unwrap(),
                "via link"
            );
            // A dangling link is an entry that cannot resolve: gate, read,
            // and write all fail and the link itself is left untouched.
            let missing_target = scratch.path().join("no-such-target");
            let dangling = staging.join("dangling.md");
            symlink(&missing_target, &dangling).expect("dangling symlink");
            let dangling_text = dangling.to_string_lossy().into_owned();
            assert!(!staging_path_allowed(&staging, &dangling_text));
            assert!(serve_fs_read(
                &staging,
                "sess_1",
                &serde_json::json!({"sessionId": "sess_1", "path": dangling_text}),
            )
            .is_err());
            let refusal = serve_fs_write(
                &staging,
                "sess_1",
                &serde_json::json!({"sessionId": "sess_1", "path": dangling_text, "content": "x"}),
                PromptMode::Workspace,
            )
            .expect_err("dangling write refuses");
            assert_eq!(
                refusal
                    .pointer("/error/message")
                    .and_then(|message| message.as_str()),
                Some("path is outside the authorized staging copy")
            );
            assert!(!missing_target.exists());
            assert!(std::fs::symlink_metadata(&dangling).is_ok());
        }
    }

    /// Refuse prompts before a session opens, concurrent prompts, and foreign
    /// session IDs; allow the recorded session again after prompt completion.
    #[test]
    fn tracker_enforces_lifecycle() {
        let mut tracker = AcpSessionTracker::new();
        assert_eq!(tracker.prompt_started(None), Err(AiError::SessionRequired));
        tracker.initialized();
        assert_eq!(tracker.prompt_started(None), Err(AiError::SessionRequired));
        tracker.session_opened("sess_1".into());
        assert_eq!(tracker.session(), Some("sess_1"));
        assert!(tracker.prompt_started(None).is_ok());
        assert_eq!(tracker.prompt_started(None), Err(AiError::SessionBusy));
        tracker.prompt_finished();
        assert_eq!(
            tracker.prompt_started(Some("other")),
            Err(AiError::UnknownSession)
        );
        assert!(tracker.prompt_started(Some("sess_1")).is_ok());
    }

    /// Keep provider credential slots distinct across set/has/delete operations,
    /// use separate account keys, and reject an empty secret.
    #[test]
    fn memory_keyring_holds_separate_slots() {
        let keyring = MemoryKeyring::default();
        assert!(!keyring.has(AiProviderKind::OpenaiCompatible).unwrap());
        keyring
            .set(AiProviderKind::OpenaiCompatible, "s3cret")
            .unwrap();
        assert!(keyring.has(AiProviderKind::OpenaiCompatible).unwrap());
        assert!(!keyring.has(AiProviderKind::Anthropic).unwrap());
        assert_ne!(
            credential_account(AiProviderKind::OpenaiCompatible),
            credential_account(AiProviderKind::Anthropic)
        );
        keyring.delete(AiProviderKind::OpenaiCompatible).unwrap();
        assert!(!keyring.has(AiProviderKind::OpenaiCompatible).unwrap());
        assert!(validate_secret("").is_err());
    }

    /// Keep named connection credential slots isolated from each other and from
    /// legacy kind slots; deleting one connection leaves the rest untouched.
    #[test]
    fn connection_keyring_isolates_named_slots_from_kind_slots() {
        let keyring = MemoryKeyring::default();
        let first = ApiConnectionId("api-first".into());
        let second = ApiConnectionId("api-second".into());
        keyring
            .set(AiProviderKind::OpenaiCompatible, "legacy")
            .unwrap();
        keyring.set_connection(&first, "one").unwrap();
        keyring.set_connection(&second, "two").unwrap();
        assert!(keyring.has_connection(&first).unwrap());
        assert!(keyring.has_connection(&second).unwrap());
        assert!(keyring.has(AiProviderKind::OpenaiCompatible).unwrap());
        assert_ne!(connection_account(&first), connection_account(&second));
        assert_ne!(
            connection_account(&first),
            credential_account(AiProviderKind::OpenaiCompatible).to_owned()
        );
        keyring.delete_connection(&first).unwrap();
        assert!(!keyring.has_connection(&first).unwrap());
        assert_eq!(
            keyring.get_connection(&second).unwrap().as_deref(),
            Some("two")
        );
        assert_eq!(
            keyring
                .get(AiProviderKind::OpenaiCompatible)
                .unwrap()
                .as_deref(),
            Some("legacy")
        );
    }

    /// Reject malformed connection IDs on every connection keyring operation.
    #[test]
    fn connection_keyring_rejects_invalid_ids() {
        let keyring = MemoryKeyring::default();
        let bad = ApiConnectionId("has space".into());
        let empty = ApiConnectionId(String::new());
        assert!(validate_connection_id(&bad).is_err());
        assert!(validate_connection_id(&empty).is_err());
        assert!(keyring.set_connection(&bad, "s").is_err());
        assert!(keyring.get_connection(&empty).is_err());
        assert!(keyring.has_connection(&bad).is_err());
        assert!(keyring.delete_connection(&empty).is_err());
    }

    /// Reject blank names, overlong names, bad IDs, and bad endpoints while
    /// allowing an empty model at rest for later connection-time validation.
    #[test]
    fn api_connection_validation_rejects_blank_and_bad_input() {
        let valid = ApiConnection {
            id: ApiConnectionId("api-1".into()),
            name: "本番".into(),
            protocol: ApiProtocol::OpenaiCompatible,
            endpoint: "https://api.example.com/v1".into(),
            model: "model-x".into(),
        };
        assert!(validate_api_connection(&valid).is_ok());
        assert!(validate_api_connection(&ApiConnection {
            model: String::new(),
            ..valid.clone()
        })
        .is_ok());
        assert!(validate_api_connection(&ApiConnection {
            name: "   ".into(),
            ..valid.clone()
        })
        .is_err());
        assert!(validate_api_connection(&ApiConnection {
            name: "n".repeat(65),
            ..valid.clone()
        })
        .is_err());
        assert!(validate_api_connection(&ApiConnection {
            id: ApiConnectionId("bad id".into()),
            ..valid.clone()
        })
        .is_err());
        assert!(validate_api_connection(&ApiConnection {
            endpoint: "not-a-url".into(),
            ..valid.clone()
        })
        .is_err());
        assert!(validate_api_connection(&ApiConnection {
            model: "has\nnewline".into(),
            ..valid.clone()
        })
        .is_err());
    }

    /// Map each protocol to its wire provider config, trimming pasted values
    /// and requiring a model before any connection attempt.
    #[test]
    fn provider_config_for_connection_maps_protocols() {
        let openai = ApiConnection {
            id: ApiConnectionId("api-o".into()),
            name: "  Open  ".into(),
            protocol: ApiProtocol::OpenaiCompatible,
            endpoint: "https://api.example.com/v1/".into(),
            model: "  model-a  ".into(),
        };
        let config = provider_config_for_connection(&openai).unwrap();
        assert_eq!(config.kind, AiProviderKind::OpenaiCompatible);
        let openai_config = config.openai.expect("openai section");
        assert_eq!(openai_config.endpoint, "https://api.example.com/v1");
        assert_eq!(openai_config.model, "model-a");
        assert!(config.anthropic.is_none());
        let anthropic = ApiConnection {
            id: ApiConnectionId("api-a".into()),
            name: "A".into(),
            protocol: ApiProtocol::Anthropic,
            endpoint: "https://api.anthropic.com/v1".into(),
            model: "claude-x".into(),
        };
        let config = provider_config_for_connection(&anthropic).unwrap();
        assert_eq!(config.kind, AiProviderKind::Anthropic);
        let anthropic_config = config.anthropic.expect("anthropic section");
        assert!(anthropic_config.enabled);
        assert!(config.openai.is_none());
        let modeless = ApiConnection {
            model: String::new(),
            ..openai
        };
        assert!(provider_config_for_connection(&modeless).is_err());
    }

    struct StubTransport;
    struct StubSpawner;

    impl crate::application::ai::transport::AiTransport for StubTransport {
        /// Never called by credential tests; panic if the wiring changes.
        fn resolve_launch(
            &self,
            _argv: &AcpArgv,
        ) -> Result<crate::application::ai::transport::ResolvedAcpLaunch, AiError> {
            unimplemented!("credential tests never resolve launches")
        }
        /// Never called by credential tests; panic if the wiring changes.
        fn handshake(&self, _argv: &AcpArgv) -> Result<AiTestResult, AiError> {
            unimplemented!("credential tests never handshake")
        }
        /// Never called by credential tests; panic if the wiring changes.
        fn test_http<'a>(
            &'a self,
            _target: &'a HttpTarget,
            _secret: &'a str,
        ) -> crate::application::ai::transport::AiFuture<'a, Result<AiTestResult, AiError>>
        {
            unimplemented!("credential tests never probe http")
        }
        /// Never called by credential tests; panic if the wiring changes.
        fn run_acp(
            &self,
            _params: &crate::application::ai::transport::AcpRunParams,
            _request: &AiPromptRequest,
            _run_id: &AiRunId,
            _registry: &std::sync::Arc<RunRegistry>,
            _cancel: &AtomicBool,
            _emit: &mut (dyn FnMut(AiStreamEvent) + Send),
        ) -> Result<(), AiError> {
            unimplemented!("credential tests never run acp")
        }
        /// Never called by credential tests; panic if the wiring changes.
        fn run_http<'a>(
            &'a self,
            _target: &'a HttpTarget,
            _secret: &'a str,
            _request: &'a AiPromptRequest,
            _run_id: &'a AiRunId,
            _cancel: &'a AtomicBool,
            _emit: &'a mut (dyn FnMut(AiStreamEvent) + Send),
        ) -> crate::application::ai::transport::AiFuture<'a, Result<(), AiError>> {
            unimplemented!("credential tests never run http")
        }
    }

    impl crate::application::ai::transport::TaskSpawner for StubSpawner {
        /// Never called by credential tests; panic if the wiring changes.
        fn spawn_blocking(&self, _task: Box<dyn FnOnce() + Send>) {
            unimplemented!("credential tests never spawn")
        }
        /// Never called by credential tests; panic if the wiring changes.
        fn spawn_async(&self, _task: crate::application::ai::transport::AiFuture<'static, ()>) {
            unimplemented!("credential tests never spawn")
        }
    }

    /// Copy a legacy kind credential into an empty connection slot without
    /// exposing it, keep the legacy slot, and never overwrite an owned secret.
    #[test]
    fn service_migrates_connection_credential_without_exposing_or_overwriting() {
        use std::sync::Arc;
        let keyring = Arc::new(MemoryKeyring::default());
        let service = crate::application::ai::service::AiService {
            keyring: keyring.clone(),
            connection_keyring: keyring.clone(),
            transport: Arc::new(StubTransport),
            spawner: Arc::new(StubSpawner),
            runs: Arc::new(RunRegistry::new()),
            usage: Arc::new(UsageRegistry::new()),
        };
        let id = ApiConnectionId("api-migrated".into());
        keyring
            .set(AiProviderKind::Anthropic, "legacy-secret")
            .unwrap();
        let state = service
            .migrate_connection_credential(&id, AiProviderKind::Anthropic)
            .unwrap();
        assert_eq!(state.connection_id, id);
        assert!(state.has_secret);
        assert_eq!(
            keyring.get_connection(&id).unwrap().as_deref(),
            Some("legacy-secret")
        );
        assert!(keyring.has(AiProviderKind::Anthropic).unwrap());
        keyring.set_connection(&id, "owned-secret").unwrap();
        let state = service
            .migrate_connection_credential(&id, AiProviderKind::Anthropic)
            .unwrap();
        assert!(state.has_secret);
        assert_eq!(
            keyring.get_connection(&id).unwrap().as_deref(),
            Some("owned-secret")
        );
        service.delete_connection_credential(&id).unwrap();
        assert!(!keyring.has_connection(&id).unwrap());
        assert!(keyring.has(AiProviderKind::Anthropic).unwrap());
    }

    /// Build one named OpenAI-compatible provider config carrying its stable ID.
    fn named_openai_config(id: &str) -> AiProviderConfig {
        AiProviderConfig {
            kind: AiProviderKind::OpenaiCompatible,
            acp: None,
            openai: Some(OpenAiConfig {
                endpoint: "https://api.example.com/v1".into(),
                model: "m".into(),
            }),
            anthropic: None,
            connection_id: Some(ApiConnectionId(id.into())),
        }
    }

    /// Resolve each named request from its own ID slot without any kind fallback.
    /// Two same-protocol connections select different secrets; a missing or
    /// deleted selected secret fails even when the legacy kind slot is filled.
    #[test]
    fn named_requests_resolve_only_their_own_secret_slot() {
        let keyring = MemoryKeyring::default();
        let first = ApiConnectionId("api-first".into());
        let second = ApiConnectionId("api-second".into());
        keyring.set_connection(&first, "secret-one").unwrap();
        keyring.set_connection(&second, "secret-two").unwrap();
        keyring
            .set(AiProviderKind::OpenaiCompatible, "legacy-secret")
            .unwrap();
        let (_, one) =
            resolve_http_request(&keyring, &keyring, &named_openai_config("api-first")).unwrap();
        let (_, two) =
            resolve_http_request(&keyring, &keyring, &named_openai_config("api-second")).unwrap();
        assert_eq!(one, "secret-one");
        assert_eq!(two, "secret-two");
        keyring.delete_connection(&second).unwrap();
        assert!(matches!(
            resolve_http_request(&keyring, &keyring, &named_openai_config("api-second")),
            Err(AiError::MissingCredentials { .. })
        ));
        assert!(validate_connection_id(&ApiConnectionId("bad id".into())).is_err());
        let mut acp = acp_request().provider;
        acp.connection_id = Some(ApiConnectionId("api-first".into()));
        assert!(validate_provider_config(&acp).is_err());
    }

    /// Stream started/chunk events before completion, concatenate Unicode output,
    /// and retain the request's base revision and scalar-count scope echo.
    #[test]
    fn mock_script_emits_started_chunks_done_with_sent_echo() {
        let request = acp_request();
        let run_id = AiRunId("run_1".into());
        let script = MockScript {
            chunks: vec!["こんにちは".into(), "世界".into()],
            fail: None,
        };
        let cancel = AtomicBool::new(false);
        let mut events = Vec::new();
        let composed = run_mock_script(&request, &run_id, &script, &cancel, &mut |event| {
            events.push(event);
        });
        assert!(composed.contains("doc_01"));
        assert!(matches!(events[0], AiStreamEvent::Started(_)));
        assert!(matches!(events[1], AiStreamEvent::Chunk(_)));
        match events.last().expect("done") {
            AiStreamEvent::Done(done) => {
                assert_eq!(done.proposal.text, "こんにちは世界");
                assert_eq!(done.proposal.base_contexts.len(), 1);
                assert_eq!(done.proposal.base_contexts[0].revision, Revision(7));
                assert_eq!(done.sent.len(), 1);
                assert_eq!(done.sent[0].chars, "a😀日本語".chars().count() as u32);
            }
            other => panic!("expected done, got {other:?}"),
        }
    }

    /// Emit cancellation for a pre-cancelled mock run and an error event for an
    /// injected authentication failure after the initial started event.
    #[test]
    fn mock_script_honors_cancel_and_failure() {
        let request = acp_request();
        let run_id = AiRunId("run_2".into());
        let script = MockScript {
            chunks: vec!["x".into()],
            fail: None,
        };
        let cancel = AtomicBool::new(true);
        let mut events = Vec::new();
        run_mock_script(&request, &run_id, &script, &cancel, &mut |event| {
            events.push(event);
        });
        assert!(matches!(events[1], AiStreamEvent::Cancelled(_)));

        let script = MockScript {
            chunks: vec![],
            fail: Some(AiError::AuthFailed {
                detail: "bad key".into(),
            }),
        };
        let cancel = AtomicBool::new(false);
        let mut events = Vec::new();
        run_mock_script(&request, &run_id, &script, &cancel, &mut |event| {
            events.push(event);
        });
        assert!(matches!(events[1], AiStreamEvent::Error(_)));
    }

    /// Build a terminal done fixture for the given run without provenance or scope entries.
    fn gate_done(run_id: &AiRunId) -> AiStreamEvent {
        AiStreamEvent::Done(StreamDone {
            run_id: run_id.clone(),
            proposal: ProposalText {
                text: "done".into(),
                base_contexts: vec![],
            },
            sent: vec![],
        })
    }

    /// Deliver started/chunk events live while buffering completion until settlement.
    #[test]
    fn terminal_gate_streams_live_then_delivers_once() {
        let run_id = AiRunId("run_gate".into());
        let mut gate = TerminalGate::new();
        let mut live = Vec::new();
        gate.push(
            AiStreamEvent::Started(StreamStarted {
                run_id: run_id.clone(),
            }),
            &mut |event| live.push(event),
        );
        gate.push(
            AiStreamEvent::Chunk(StreamChunk {
                run_id: run_id.clone(),
                text: "a".into(),
            }),
            &mut |event| live.push(event),
        );
        gate.push(
            AiStreamEvent::Chunk(StreamChunk {
                run_id: run_id.clone(),
                text: "b".into(),
            }),
            &mut |event| live.push(event),
        );
        // Terminal stays buffered: live delivery holds chunks in order only.
        gate.push(gate_done(&run_id), &mut |event| live.push(event));
        assert_eq!(live.len(), 3);
        assert!(matches!(live[1], AiStreamEvent::Chunk(_)));
        let terminal = gate.settle(&Ok(()), &run_id);
        assert!(matches!(terminal, AiStreamEvent::Done(_)));
    }

    /// Keep the first done event when a driver later emits an error and returns
    /// a failure, preventing a second terminal delivery.
    #[test]
    fn terminal_gate_keeps_first_settlement_only() {
        let run_id = AiRunId("run_gate2".into());
        let mut gate = TerminalGate::new();
        let mut live = Vec::new();
        // A driver bug emitting Error after Done must not double-deliver:
        // the first terminal wins and the outcome error is absorbed.
        gate.push(gate_done(&run_id), &mut |event| live.push(event));
        gate.push(
            AiStreamEvent::Error(StreamError {
                run_id: Some(run_id.clone()),
                error: AiError::StreamFailed {
                    detail: "late".into(),
                },
            }),
            &mut |event| live.push(event),
        );
        assert!(live.is_empty());
        let outcome: Result<(), AiError> = Err(AiError::ConnectionFailed {
            detail: "also failed".into(),
        });
        assert!(matches!(
            gate.settle(&outcome, &run_id),
            AiStreamEvent::Done(_)
        ));
    }

    /// Turn an error or silent successful driver outcome into an explicit error,
    /// while retaining a buffered cancellation without delivering it live.
    #[test]
    fn terminal_gate_maps_silent_and_error_outcomes() {
        let run_id = AiRunId("run_gate3".into());
        let gate = TerminalGate::new();
        let outcome: Result<(), AiError> = Err(AiError::AuthFailed {
            detail: "bad".into(),
        });
        assert!(matches!(
            gate.settle(&outcome, &run_id),
            AiStreamEvent::Error(_)
        ));
        // A silent Ok (driver bug) still terminates explicitly, never hangs.
        let gate = TerminalGate::new();
        assert!(matches!(
            gate.settle(&Ok(()), &run_id),
            AiStreamEvent::Error(_)
        ));
        // Cancelled is terminal and buffered like Done.
        let mut gate = TerminalGate::new();
        let mut live = Vec::new();
        gate.push(
            AiStreamEvent::Cancelled(StreamCancelled {
                run_id: run_id.clone(),
            }),
            &mut |event| live.push(event),
        );
        assert!(live.is_empty());
        assert!(matches!(
            gate.settle(&Ok(()), &run_id),
            AiStreamEvent::Cancelled(_)
        ));
    }

    /// Classify an intentionally absent executable as `MissingBinary` before agent startup.
    #[test]
    fn missing_binaries_report_without_spawning_agents() {
        let argv = AcpArgv {
            command: "marxen-definitely-missing-binary".into(),
            args: vec![],
        };
        assert!(matches!(
            spawn_acp(&argv, Path::new("/tmp")),
            Err(AiError::MissingBinary { .. })
        ));
    }

    /// Accept the user-facing Claude ACP preset without launching it and round-trip the exact
    /// `request_cancelled` error tag.
    #[test]
    fn wire_accepts_claude_adapter_and_tags_cancellation() {
        let rejected: Result<AcpPreset, _> = serde_json::from_str("\"claude_code\"");
        assert_eq!(rejected.unwrap(), AcpPreset::ClaudeCode);
        assert_eq!(
            preset_argv(AcpPreset::ClaudeCode).command,
            "claude-agent-acp"
        );
        let value = serde_json::to_value(AiError::RequestCancelled).unwrap();
        assert_eq!(value, serde_json::json!({"code": "request_cancelled"}));
        let roundtrip: AiError = serde_json::from_value(value).unwrap();
        assert_eq!(roundtrip, AiError::RequestCancelled);
    }

    /// Build one history fixture with the supplied role and exact owned text.
    fn history_message(role: ChatRole, text: &str) -> ChatHistoryMessage {
        ChatHistoryMessage {
            role,
            text: text.into(),
        }
    }

    /// Allow empty/valid history but reject excess message count, blank entries,
    /// more than 20,000 Unicode scalars in one entry, and embedded NUL.
    #[test]
    fn history_validation_bounds_turns_and_chars() {
        assert!(validate_history(&[]).is_ok());
        assert!(validate_history(&[history_message(ChatRole::User, "前回の質問")]).is_ok());
        let too_many: Vec<ChatHistoryMessage> = (0..MAX_HISTORY_MESSAGES + 1)
            .map(|i| history_message(ChatRole::User, &format!("q{i}")))
            .collect();
        assert!(validate_history(&too_many).is_err());
        assert!(validate_history(&[history_message(ChatRole::User, "   ")]).is_err());
        let long = "あ".repeat(MAX_HISTORY_CHARS + 1);
        assert!(validate_history(&[history_message(ChatRole::Assistant, &long)]).is_err());
        let mut with_nul = String::from("ok");
        with_nul.push('\0');
        assert!(validate_history(&[history_message(ChatRole::User, &with_nul)]).is_err());
    }

    /// Include history validation in pure request checks and retain compatibility
    /// with legacy serialized requests whose missing history defaults to empty.
    #[test]
    fn prompt_requests_validate_history_before_side_effects() {
        let mut request = acp_request();
        request.history = vec![
            history_message(ChatRole::User, "1件目"),
            history_message(ChatRole::Assistant, "1件目の回答"),
        ];
        assert!(validate_prompt_request(&request).is_ok());
        request.history = vec![history_message(ChatRole::User, "   ")];
        assert!(validate_prompt_request(&request).is_err());
        // Old payloads without history still deserialize via default.
        let legacy = serde_json::json!({
            "provider": serde_json::to_value(&request.provider).unwrap(),
            "mode": "ask",
            "prompt": "質問",
            "contexts": [],
            "staging": { "copyId": "copy_01" },
            "sessionId": null
        });
        let parsed: AiPromptRequest = serde_json::from_value(legacy).unwrap();
        assert!(parsed.history.is_empty());
    }

    /// Carry user/assistant history in the ACP text preamble and prompt envelope,
    /// while keeping empty-history composition identical to the original wire text.
    #[test]
    fn acp_composition_carries_history_explicitly() {
        let history = vec![
            history_message(ChatRole::User, "前回の質問"),
            history_message(ChatRole::Assistant, "前回の回答"),
        ];
        let with_history =
            compose_user_message_with_history(PromptMode::Ask, "今回", &[context()], &history);
        assert!(with_history.contains("--- history user ---\n前回の質問"));
        assert!(with_history.contains("--- history assistant ---\n前回の回答"));
        assert!(with_history.contains("--- prompt ---\n今回"));
        // No-history shape is unchanged for the existing exact-shape test.
        assert_eq!(
            compose_user_message(PromptMode::Ask, "これは何ですか", &[context()]),
            compose_user_message_with_history(PromptMode::Ask, "これは何ですか", &[context()], &[])
        );
        let prompt = acp_session_prompt_with_history(
            3,
            "sess_1",
            PromptMode::Ask,
            "今回",
            &[context()],
            &history,
        );
        let text = prompt["params"]["prompt"][0]["text"]
            .as_str()
            .expect("text");
        assert!(text.contains("前回の質問") && text.contains("前回の回答"));
    }

    /// Keep a prior question/answer as separate HTTP messages before the current
    /// scoped prompt for both OpenAI-compatible and Anthropic body builders.
    #[test]
    fn http_bodies_carry_two_turn_history_as_messages() {
        let history = vec![
            history_message(ChatRole::User, "1件目の質問"),
            history_message(ChatRole::Assistant, "1件目の回答"),
        ];
        let mut openai = acp_request();
        openai.provider = AiProviderConfig {
            kind: AiProviderKind::OpenaiCompatible,
            acp: None,
            openai: Some(OpenAiConfig {
                endpoint: "https://api.example.com/v1".into(),
                model: "m".into(),
            }),
            anthropic: None,
            connection_id: None,
        };
        openai.prompt = "2件目の質問".into();
        openai.history = history.clone();
        let body = openai_body(&openai, "m");
        let messages = body["messages"].as_array().expect("messages");
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[0]["role"], "user");
        assert_eq!(messages[0]["content"], "1件目の質問");
        assert_eq!(messages[1]["role"], "assistant");
        assert_eq!(messages[1]["content"], "1件目の回答");
        assert!(messages[2]["content"]
            .as_str()
            .expect("content")
            .contains("2件目の質問"));

        openai.provider = AiProviderConfig {
            kind: AiProviderKind::Anthropic,
            acp: None,
            openai: None,
            anthropic: Some(AnthropicConfig {
                enabled: true,
                endpoint: "https://api.anthropic.example".into(),
                model: "m".into(),
            }),
            connection_id: None,
        };
        let body = anthropic_body(&openai, "m");
        let messages = body["messages"].as_array().expect("messages");
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[0]["content"], "1件目の質問");
        assert_eq!(messages[1]["content"], "1件目の回答");
    }

    /// Preserve `PATHEXT` order while dropping empties, dots, and non-alphanumeric noise.
    #[test]
    fn pathext_parsing_preserves_order_and_drops_noise() {
        let parsed = parse_windows_pathext(".COM;.EXE;.BAT;.CMD;;.PS1;BAD-EXT;.JS");
        assert_eq!(parsed, vec!["com", "exe", "bat", "cmd", "ps1", "js"]);
        assert!(!default_windows_pathext().is_empty());
        assert!(is_windows_script_extension("CMD"));
        assert!(is_windows_script_extension("ps1"));
        assert!(!is_windows_script_extension("exe"));
    }

    /// Treat only `.exe`/`.com` as directly runnable; shims and bare wrappers need resolution.
    #[test]
    fn direct_executable_detection_rejects_shims() {
        assert!(is_direct_windows_executable(Path::new("agent.EXE")));
        assert!(is_direct_windows_executable(Path::new(
            "C:\\tools\\run.com"
        )));
        assert!(!is_direct_windows_executable(Path::new("codex-acp.cmd")));
        assert!(!is_direct_windows_executable(Path::new("codex-acp.ps1")));
        assert!(!is_direct_windows_executable(Path::new("codex-acp")));
        assert!(!is_direct_windows_executable(Path::new("agent.js")));
    }

    /// Classify authentication markers as `AuthFailed` with terminal guidance,
    /// keeping other agent errors as `StreamFailed` with bounded context.
    #[test]
    fn auth_markers_map_to_actionable_failures() {
        assert!(is_auth_required_message("auth_required: need login"));
        assert!(is_auth_required_message("HTTP 401 unauthorized"));
        assert!(!is_auth_required_message("model not found"));
        match map_acp_rpc_error("prompt に失敗しました", None, "auth_required: login") {
            AiError::AuthFailed { detail } => assert!(detail.contains("利用する CLI")),
            other => panic!("expected auth, got {other:?}"),
        }
        match map_acp_rpc_error("initialize が失敗しました", Some(-32603), "busy") {
            AiError::StreamFailed { detail } => assert!(detail.contains("initialize")),
            other => panic!("expected stream, got {other:?}"),
        }
        assert!(missing_binary_hint("codex-acp").contains("@agentclientprotocol/codex-acp"));
        assert!(missing_binary_hint("opencode").contains("opencode"));
        let error = AiError::MissingBinary {
            command: "codex-acp".into(),
        };
        assert!(error_detail(&error).contains("codex-acp"));
        assert!(matches!(
            map_acp_rpc_error("session/new", Some(-32000), "ログインしてください"),
            AiError::AuthFailed { .. }
        ));
        assert!(matches!(
            map_acp_rpc_error(
                "session/new",
                Some(-32603),
                "authentication service unavailable"
            ),
            AiError::StreamFailed { .. }
        ));
    }

    /// Report a definitely absent executable as `MissingBinary` without spawning.
    #[test]
    fn resolve_missing_binary_is_actionable_without_spawn() {
        let argv = AcpArgv {
            command: "marxen-definitely-missing-binary".into(),
            args: vec![],
        };
        match resolve_acp_launch(&argv) {
            Err(AiError::MissingBinary { command }) => {
                assert_eq!(command, "marxen-definitely-missing-binary");
                assert!(missing_binary_hint(&command).contains("PATH"));
            }
            other => panic!("expected missing, got {other:?}"),
        }
        assert!(matches!(
            spawn_acp(&argv, Path::new("/tmp")),
            Err(AiError::MissingBinary { .. })
        ));
    }

    /// Refuse Claude Code commands during resolution before any process starts.
    #[test]
    fn resolve_refuses_claude_without_spawning() {
        let argv = AcpArgv {
            command: "claude".into(),
            args: vec![],
        };
        assert!(matches!(
            resolve_acp_launch(&argv),
            Err(AiError::ClaudeCodeRefused { .. })
        ));
    }

    /// Freeze a relative executable path while preserving arguments before spawn changes cwd.
    #[test]
    fn resolve_relative_executable_to_absolute_path() {
        let cwd = std::env::current_dir().unwrap();
        let root = tempfile::tempdir_in(&cwd).unwrap();
        let exe = root.path().join("agent.exe");
        std::fs::write(&exe, b"fixture").unwrap();
        let relative = exe.strip_prefix(&cwd).unwrap();
        let argv = AcpArgv {
            command: relative.to_string_lossy().into_owned(),
            args: vec!["a b 日本語".into()],
        };
        let launch = resolve_acp_launch(&argv).unwrap();
        assert!(launch.program.is_absolute());
        assert_eq!(launch.program, exe);
        assert_eq!(launch.args, argv.args);
    }

    /// Keep both Node and the adapter script absolute when the npm shim path is relative.
    #[cfg(windows)]
    #[test]
    fn resolve_relative_codex_shim_keeps_script_absolute() {
        let cwd = std::env::current_dir().unwrap();
        let root = tempfile::tempdir_in(&cwd).unwrap();
        let dist = root
            .path()
            .join("node_modules")
            .join("@agentclientprotocol")
            .join("codex-acp")
            .join("dist");
        std::fs::create_dir_all(&dist).unwrap();
        let script = dist.join("index.js");
        std::fs::write(&script, b"fixture").unwrap();
        let node = root.path().join("node.exe");
        std::fs::write(&node, b"fixture").unwrap();
        let shim = root.path().join("codex-acp.cmd");
        std::fs::write(&shim, b"@ECHO off").unwrap();
        let argv = AcpArgv {
            command: shim
                .strip_prefix(&cwd)
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            args: vec!["--stdio".into()],
        };
        let launch = resolve_acp_launch(&argv).unwrap();
        assert_eq!(launch.program, node);
        assert_eq!(
            launch.args,
            vec![script.to_string_lossy().into_owned(), "--stdio".into()]
        );
    }

    /// Resolve an explicit `opencode.cmd` shim with spaces to its bundled `.exe`
    /// without a shell, preserving the original `acp` argument.
    #[cfg(windows)]
    #[test]
    fn resolve_explicit_opencode_shim_with_space_path() {
        let root = tempfile::tempdir().unwrap();
        let npm_root = root.path().join("npm root with space");
        let bin = npm_root
            .join("node_modules")
            .join("@opencode")
            .join("cli")
            .join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let exe = bin.join("opencode.exe");
        std::fs::write(&exe, b"fake").unwrap();
        let shim = npm_root.join("opencode.cmd");
        std::fs::write(&shim, b"@ECHO off").unwrap();
        let argv = AcpArgv {
            command: shim.to_string_lossy().into_owned(),
            args: vec!["acp".into()],
        };
        let launch = resolve_acp_launch(&argv).unwrap();
        assert_eq!(launch.program, exe);
        assert_eq!(launch.args, vec!["acp".to_owned()]);
        // Direct `.exe` paths with spaces also resolve without interpolation.
        let direct = AcpArgv {
            command: exe.to_string_lossy().into_owned(),
            args: vec!["acp".into()],
        };
        let launch = resolve_acp_launch(&direct).unwrap();
        assert_eq!(launch.program, exe);
    }

    /// Resolve an explicit `codex-acp.cmd` shim with spaces to `node <script>`
    /// without a shell, keeping bundled script first and original args after.
    #[cfg(windows)]
    #[test]
    fn resolve_explicit_codex_shim_with_space_path_to_node() {
        let root = tempfile::tempdir().unwrap();
        let npm_root = root.path().join("npm root with space");
        let dist = npm_root
            .join("node_modules")
            .join("@agentclientprotocol")
            .join("codex-acp")
            .join("dist");
        std::fs::create_dir_all(&dist).unwrap();
        let script = dist.join("index.js");
        std::fs::write(&script, b"console.log(1)").unwrap();
        let node = npm_root.join("node.exe");
        std::fs::write(&node, b"fake").unwrap();
        let shim = npm_root.join("codex-acp.cmd");
        std::fs::write(&shim, b"@ECHO off").unwrap();
        let argv = AcpArgv {
            command: shim.to_string_lossy().into_owned(),
            args: vec![],
        };
        let launch = resolve_acp_launch(&argv).unwrap();
        assert_eq!(launch.program, node);
        assert_eq!(launch.args.len(), 1);
        assert_eq!(launch.args[0], script.to_string_lossy());
    }

    /// Keep a stale explicit shim without its bundled target as missing rather
    /// than falling back to an arbitrary shell.
    #[cfg(windows)]
    #[test]
    fn resolve_shim_without_bundled_target_is_missing() {
        let root = tempfile::tempdir().unwrap();
        let shim = root.path().join("codex-acp.cmd");
        std::fs::write(&shim, b"@ECHO off").unwrap();
        let argv = AcpArgv {
            command: shim.to_string_lossy().into_owned(),
            args: vec![],
        };
        assert!(matches!(
            resolve_acp_launch(&argv),
            Err(AiError::MissingBinary { .. })
        ));
    }

    /// Probe the installed Codex adapter through native resolution without sending a prompt.
    #[cfg(windows)]
    #[test]
    #[ignore = "requires the user's installed and already authenticated Codex adapter"]
    fn installed_codex_acp_handshake() {
        let result = handshake_acp(&preset_argv(AcpPreset::Codex)).unwrap();
        assert!(result.ok, "{}", result.detail);
        assert!(result.config_options.is_some());
    }

    /// Probe the installed OpenCode adapter through native resolution without model inference.
    #[cfg(windows)]
    #[test]
    #[ignore = "requires the user's installed and already authenticated OpenCode adapter"]
    fn installed_opencode_acp_handshake() {
        let result = handshake_acp(&preset_argv(AcpPreset::Opencode)).unwrap();
        assert!(result.ok, "{}", result.detail);
        assert!(result.config_options.is_some());
    }

    /// Build one official `usage_update` notification for the given session,
    /// context occupancy, and optional cost object.
    fn usage_note(
        session: &str,
        used: serde_json::Value,
        size: serde_json::Value,
        cost: Option<serde_json::Value>,
    ) -> serde_json::Value {
        let mut update = serde_json::json!({
            "sessionUpdate": "usage_update",
            "used": used,
            "size": size,
        });
        if let Some(cost) = cost {
            update["cost"] = cost;
        }
        serde_json::json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": { "sessionId": session, "update": update }
        })
    }

    /// Build one `session/prompt` response body with the supplied stop reason
    /// and optional unstable `usage` object.
    fn prompt_body(stop: &str, usage: Option<serde_json::Value>) -> serde_json::Value {
        let mut result = serde_json::json!({ "stopReason": stop });
        if let Some(usage) = usage {
            result["usage"] = usage;
        }
        serde_json::json!({ "result": result })
    }

    /// Build one unstable prompt usage object with required token counters and
    /// the supplied optional reasoning/cache counters.
    fn prompt_usage(input: u64, output: u64, total: u64) -> serde_json::Value {
        serde_json::json!({
            "inputTokens": input,
            "outputTokens": output,
            "totalTokens": total,
        })
    }

    /// Accept exact integer counters within the JavaScript-safe range while
    /// rejecting negative, fractional, string, and out-of-range values.
    #[test]
    fn token_counters_reject_dishonest_values() {
        assert_eq!(validate_token_counter(&serde_json::json!(12u64)), Some(12));
        assert_eq!(validate_token_counter(&serde_json::json!(0u64)), Some(0));
        assert_eq!(
            validate_token_counter(&serde_json::json!(JS_SAFE_INTEGER_MAX)),
            Some(JS_SAFE_INTEGER_MAX)
        );
        for bad in [
            serde_json::json!(-1),
            serde_json::json!(1.5),
            serde_json::json!("12"),
            serde_json::json!(JS_SAFE_INTEGER_MAX + 1),
            serde_json::Value::Null,
        ] {
            assert_eq!(validate_token_counter(&bad), None, "{bad}");
        }
    }

    /// Accept finite non-negative cost amounts within the safe range as decimal
    /// text while rejecting negative, string, null, and out-of-range values.
    #[test]
    fn cost_amounts_render_as_decimal_text() {
        assert_eq!(
            validate_cost_amount(&serde_json::json!(12u64)),
            Some("12".to_owned())
        );
        assert_eq!(
            validate_cost_amount(&serde_json::json!(12.5)),
            Some("12.5".to_owned())
        );
        for bad in [
            serde_json::json!(-0.5),
            serde_json::json!(-1),
            serde_json::json!("12.5"),
            serde_json::Value::Null,
        ] {
            assert_eq!(validate_cost_amount(&bad), None, "{bad}");
        }
        assert_eq!(
            validate_cost_amount(&serde_json::json!(9_007_199_254_740_992u64)),
            None
        );
    }

    /// Accept three ASCII letters as an ISO 4217 code with uppercase
    /// normalization while rejecting empty, long, and non-letter codes.
    #[test]
    fn currency_codes_require_three_letters() {
        assert_eq!(validate_currency_code("USD"), Some("USD".to_owned()));
        assert_eq!(validate_currency_code("usd"), Some("USD".to_owned()));
        for bad in ["", "US", "USDD", "U$D", "12A", "usd "] {
            assert_eq!(validate_currency_code(bad), None, "{bad}");
        }
    }

    /// Parse one official `usage_update` with context occupancy and cumulative
    /// session cost, preserving provider, preset, run, session, and receipt time.
    #[test]
    fn usage_update_reports_context_and_session_cost() {
        let run = AiRunId("run_usage_1".into());
        let note = usage_note(
            "sess_usage_1",
            serde_json::json!(120u64),
            serde_json::json!(1000u64),
            Some(serde_json::json!({ "amount": 1.25, "currency": "USD" })),
        );
        let usage = parse_usage_update_notification(
            &note,
            "sess_usage_1",
            AiProviderKind::Acp,
            Some(AcpPreset::Codex),
            &run,
            111,
        )
        .expect("valid usage_update");
        assert_eq!(usage.provider, AiProviderKind::Acp);
        assert_eq!(usage.preset, Some(AcpPreset::Codex));
        assert_eq!(usage.run_id, run);
        assert_eq!(usage.session_id, AcpSessionId("sess_usage_1".into()));
        assert_eq!(usage.source, AcpUsageSource::UsageUpdate);
        assert_eq!(usage.scope, AcpUsageScope::Session);
        assert_eq!(usage.used, Some(120));
        assert_eq!(usage.size, Some(1000));
        assert_eq!(usage.input_tokens, None);
        assert_eq!(usage.cost.as_ref().expect("cost").currency, "USD");
        assert_eq!(usage.cost.as_ref().expect("cost").amount, "1.25");
        assert_eq!(usage.received_ms, 111);
    }

    /// Reject notifications for foreign sessions, other methods, and other
    /// update kinds so costs never mix across sessions.
    #[test]
    fn usage_update_rejects_foreign_sessions() {
        let run = AiRunId("run_usage_2".into());
        let note = usage_note(
            "sess_other",
            serde_json::json!(5u64),
            serde_json::json!(10u64),
            None,
        );
        assert!(parse_usage_update_notification(
            &note,
            "sess_expected",
            AiProviderKind::Acp,
            None,
            &run,
            1,
        )
        .is_none());
        let mut wrong_method = usage_note(
            "sess_expected",
            serde_json::json!(5u64),
            serde_json::json!(10u64),
            None,
        );
        wrong_method["method"] = serde_json::json!("session/other");
        assert!(parse_usage_update_notification(
            &wrong_method,
            "sess_expected",
            AiProviderKind::Acp,
            None,
            &run,
            1,
        )
        .is_none());
        let chunk = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": "sess_expected",
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": { "type": "text", "text": "hi" }
                }
            }
        });
        assert!(parse_usage_update_notification(
            &chunk,
            "sess_expected",
            AiProviderKind::Acp,
            None,
            &run,
            1,
        )
        .is_none());
    }

    /// Reject malformed context counters while keeping a valid report when only
    /// the optional cost is dishonest.
    #[test]
    fn usage_update_handles_malformed_counters_and_cost() {
        let run = AiRunId("run_usage_3".into());
        for (used, size) in [
            (serde_json::json!(-1), serde_json::json!(10u64)),
            (serde_json::json!(1.5), serde_json::json!(10u64)),
            (
                serde_json::json!(9_007_199_254_740_992u64),
                serde_json::json!(10u64),
            ),
            (serde_json::json!(5u64), serde_json::Value::Null),
        ] {
            let note = usage_note("sess_m", used, size, None);
            assert!(parse_usage_update_notification(
                &note,
                "sess_m",
                AiProviderKind::Acp,
                None,
                &run,
                1,
            )
            .is_none());
        }
        let bad_cost = usage_note(
            "sess_m",
            serde_json::json!(5u64),
            serde_json::json!(10u64),
            Some(serde_json::json!({ "amount": -1.0, "currency": "USD" })),
        );
        let usage = parse_usage_update_notification(
            &bad_cost,
            "sess_m",
            AiProviderKind::Acp,
            None,
            &run,
            2,
        )
        .expect("context survives a bad cost");
        assert_eq!(usage.used, Some(5));
        assert_eq!(usage.cost, None);
        let bad_currency = usage_note(
            "sess_m",
            serde_json::json!(5u64),
            serde_json::json!(10u64),
            Some(serde_json::json!({ "amount": 1.0, "currency": "XX" })),
        );
        let usage = parse_usage_update_notification(
            &bad_currency,
            "sess_m",
            AiProviderKind::Acp,
            None,
            &run,
            3,
        )
        .expect("context survives a bad currency");
        assert_eq!(usage.cost, None);
        let no_cost = usage_note(
            "sess_m",
            serde_json::json!(5u64),
            serde_json::json!(10u64),
            None,
        );
        let usage =
            parse_usage_update_notification(&no_cost, "sess_m", AiProviderKind::Acp, None, &run, 4)
                .expect("cost stays absent");
        assert_eq!(usage.cost, None);
    }

    /// Parse unstable prompt usage with required and optional token counters,
    /// honestly labeled with the undefined scope and no context or cost fields.
    #[test]
    fn prompt_response_usage_reports_tokens_with_undefined_scope() {
        let run = AiRunId("run_usage_4".into());
        let mut usage = prompt_usage(10, 20, 30);
        usage["thoughtTokens"] = serde_json::json!(4u64);
        usage["cachedReadTokens"] = serde_json::json!(6u64);
        usage["cachedWriteTokens"] = serde_json::json!(7u64);
        let body = prompt_body("end_turn", Some(usage));
        let report = parse_prompt_response_usage(
            &body,
            AiProviderKind::Acp,
            Some(AcpPreset::Opencode),
            &run,
            "sess_p1",
            222,
        )
        .expect("valid prompt usage");
        assert_eq!(report.source, AcpUsageSource::PromptResponse);
        assert_eq!(report.scope, AcpUsageScope::PromptResponseUndefined);
        assert_eq!(report.used, None);
        assert_eq!(report.size, None);
        assert_eq!(report.input_tokens, Some(10));
        assert_eq!(report.output_tokens, Some(20));
        assert_eq!(report.total_tokens, Some(30));
        assert_eq!(report.reasoning_tokens, Some(4));
        assert_eq!(report.cached_read_tokens, Some(6));
        assert_eq!(report.cached_write_tokens, Some(7));
        assert_eq!(report.cost, None);
        assert_eq!(report.session_id, AcpSessionId("sess_p1".into()));
        assert_eq!(report.received_ms, 222);
    }

    /// Treat absent prompt usage as no report while rejecting malformed present
    /// usage instead of recording partial counters.
    #[test]
    fn prompt_response_usage_rejects_malformed_reports() {
        let run = AiRunId("run_usage_5".into());
        assert!(parse_prompt_response_usage(
            &prompt_body("end_turn", None),
            AiProviderKind::Acp,
            None,
            &run,
            "sess_p",
            1,
        )
        .is_none());
        assert!(parse_prompt_response_usage(
            &prompt_body("end_turn", Some(serde_json::Value::Null)),
            AiProviderKind::Acp,
            None,
            &run,
            "sess_p",
            1,
        )
        .is_none());
        for bad in [
            serde_json::json!({ "outputTokens": 1u64, "totalTokens": 1u64 }),
            serde_json::json!({ "inputTokens": -1, "outputTokens": 1u64, "totalTokens": 1u64 }),
            serde_json::json!({ "inputTokens": 1.5, "outputTokens": 1u64, "totalTokens": 1u64 }),
            serde_json::json!({
                "inputTokens": 9_007_199_254_740_992u64,
                "outputTokens": 1u64,
                "totalTokens": 1u64,
            }),
            serde_json::json!({
                "inputTokens": 1u64,
                "outputTokens": 1u64,
                "totalTokens": 1u64,
                "thoughtTokens": -2,
            }),
        ] {
            assert!(
                parse_prompt_response_usage(
                    &prompt_body("end_turn", Some(bad.clone())),
                    AiProviderKind::Acp,
                    None,
                    &run,
                    "sess_p",
                    1,
                )
                .is_none(),
                "{bad}"
            );
        }
        let mut minimal = prompt_usage(1, 2, 3);
        assert!(parse_prompt_response_usage(
            &prompt_body("cancelled", Some(minimal.clone())),
            AiProviderKind::Acp,
            None,
            &run,
            "sess_p",
            5,
        )
        .is_some());
        minimal["thoughtTokens"] = serde_json::Value::Null;
        assert!(parse_prompt_response_usage(
            &prompt_body("cancelled", Some(minimal)),
            AiProviderKind::Acp,
            None,
            &run,
            "sess_p",
            6,
        )
        .expect("null optional stays absent")
        .reasoning_tokens
        .is_none());
    }

    /// Map wire sources to their honest scopes and read the ACP preset from the
    /// request provider without touching wire metadata.
    #[test]
    fn usage_source_scope_and_preset_labels() {
        assert_eq!(
            usage_scope_for_source(AcpUsageSource::UsageUpdate),
            AcpUsageScope::Session
        );
        assert_eq!(
            usage_scope_for_source(AcpUsageSource::PromptResponse),
            AcpUsageScope::PromptResponseUndefined
        );
        let acp = AiProviderConfig {
            kind: AiProviderKind::Acp,
            acp: Some(AcpConfig {
                preset: AcpPreset::Copilot,
                argv: None,
                selections: None,
            }),
            openai: None,
            anthropic: None,
            connection_id: None,
        };
        assert_eq!(acp_preset_of(&acp), Some(AcpPreset::Copilot));
        let http = AiProviderConfig {
            kind: AiProviderKind::OpenaiCompatible,
            acp: None,
            openai: Some(OpenAiConfig {
                endpoint: "https://api.example.com/v1".into(),
                model: "m".into(),
            }),
            anthropic: None,
            connection_id: None,
        };
        assert_eq!(acp_preset_of(&http), None);
    }

    /// Build one minimal session-scoped usage report for registry tests.
    fn registry_usage(run: &str, session: &str, received: u64) -> ReportedUsage {
        ReportedUsage {
            provider: AiProviderKind::Acp,
            preset: Some(AcpPreset::Codex),
            run_id: AiRunId(run.into()),
            session_id: AcpSessionId(session.into()),
            source: AcpUsageSource::UsageUpdate,
            scope: AcpUsageScope::Session,
            used: Some(9),
            size: Some(11),
            input_tokens: None,
            output_tokens: None,
            total_tokens: None,
            cached_read_tokens: None,
            cached_write_tokens: None,
            reasoning_tokens: None,
            cost: None,
            received_ms: received,
        }
    }

    /// Replace the latest report per run without summing, reset new runs to a
    /// fresh scope, and keep snapshots ordered and bounded.
    #[test]
    fn usage_registry_replaces_resets_and_bounds() {
        let registry = UsageRegistry::new();
        let run = AiRunId("run_store_1".into());
        registry.record(registry_usage("run_store_1", "sess_a", 10));
        let mut second = registry_usage("run_store_1", "sess_a", 20);
        second.used = Some(30);
        registry.record(second);
        let kept = registry.get(&run).expect("latest");
        assert_eq!(kept.used, Some(30));
        assert_eq!(kept.received_ms, 20);
        registry.reset_for_run(&run);
        assert!(registry.get(&run).is_none());
        registry.record(registry_usage("run_store_1", "sess_a", 30));
        assert!(registry.get(&run).is_some());
        for index in 0..(MAX_USAGE_ENTRIES + 5) {
            registry.record(registry_usage(
                &format!("run_bound_{index}"),
                &format!("sess_{index}"),
                100 + index as u64,
            ));
        }
        let snapshot = registry.snapshot();
        assert_eq!(snapshot.len(), MAX_USAGE_ENTRIES);
        assert!(snapshot
            .windows(2)
            .all(|pair| pair[0].received_ms <= pair[1].received_ms));
        assert!(registry.get(&AiRunId("run_bound_0".into())).is_none());
    }

    /// Keep context/cost and undefined-scope token observations separate through final response.
    #[test]
    fn usage_registry_retains_context_after_prompt_response() {
        let registry = UsageRegistry::new();
        let run = AiRunId("run_sources".into());
        let context = parse_usage_update_notification(
            &usage_note(
                "session_a",
                serde_json::json!(100),
                serde_json::json!(1000),
                Some(serde_json::json!({"amount": 1.25, "currency": "USD"})),
            ),
            "session_a",
            AiProviderKind::Acp,
            Some(AcpPreset::Codex),
            &run,
            10,
        )
        .unwrap();
        let tokens = parse_prompt_response_usage(
            &prompt_body("end_turn", Some(prompt_usage(12, 4, 16))),
            AiProviderKind::Acp,
            Some(AcpPreset::Codex),
            &run,
            "session_a",
            20,
        )
        .unwrap();
        registry.record(context.clone());
        registry.record(tokens.clone());
        assert_eq!(registry.snapshot(), vec![context, tokens]);

        registry.record(registry_usage("run_other", "session_b", 30));
        registry.record(registry_usage("run_sources", "session_other", 40));
        assert_eq!(registry.snapshot().len(), 4);
        registry.reset_for_run(&run);
        let remaining = registry.snapshot();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].run_id.0, "run_other");
    }

    /// Serialize safe counters as JSON numbers and omit unreported fields without zero filling.
    #[test]
    fn usage_ipc_counters_are_json_numbers() {
        let mut usage = registry_usage("run_numbers", "session_a", 1234);
        usage.used = Some(JS_SAFE_INTEGER_MAX);
        let value = serde_json::to_value(&usage).unwrap();
        assert_eq!(value["used"].as_u64(), Some(JS_SAFE_INTEGER_MAX));
        assert_eq!(value["receivedMs"].as_u64(), Some(1234));
        assert!(value.get("inputTokens").is_none());
        assert!(value.get("cost").is_none());
        assert_eq!(
            serde_json::from_value::<ReportedUsage>(value).unwrap(),
            usage
        );
    }

    /// Stream usage events live without settling the run; done, error, and
    /// cancelled remain the only single terminal deliveries.
    #[test]
    fn terminal_gate_keeps_usage_nonterminal() {
        let run_id = AiRunId("run_usage_gate".into());
        let usage = registry_usage("run_usage_gate", "sess_g", 1);
        let mut gate = TerminalGate::new();
        let mut live = Vec::new();
        gate.push(
            AiStreamEvent::Started(StreamStarted {
                run_id: run_id.clone(),
            }),
            &mut |event| live.push(event),
        );
        gate.push(
            AiStreamEvent::Usage(StreamUsage {
                run_id: run_id.clone(),
                usage: usage.clone(),
            }),
            &mut |event| live.push(event),
        );
        assert_eq!(live.len(), 2);
        assert!(matches!(live[1], AiStreamEvent::Usage(_)));
        gate.push(gate_done(&run_id), &mut |event| live.push(event));
        assert_eq!(live.len(), 2);
        let terminal = gate.settle(&Ok(()), &run_id);
        assert!(matches!(terminal, AiStreamEvent::Done(_)));
        let roundtrip: AiStreamEvent = serde_json::from_value(
            serde_json::to_value(AiStreamEvent::Usage(StreamUsage {
                run_id: run_id.clone(),
                usage,
            }))
            .unwrap(),
        )
        .unwrap();
        assert!(matches!(roundtrip, AiStreamEvent::Usage(_)));
        assert!(!matches!(roundtrip, AiStreamEvent::Done(_)));
    }
}
