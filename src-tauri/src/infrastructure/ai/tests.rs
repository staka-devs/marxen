//! AI protocol and lifecycle regression fixtures.
use super::acp::*;
use super::credentials::*;
use crate::application::ai::credentials::*;
use crate::application::ai::runs::*;
use crate::contracts::ai::*;
use crate::domain::ai::*;
use std::path::Path;
use std::sync::atomic::AtomicBool;
mod regression {
    use super::*;
    use crate::contracts::{DocumentId, Revision, Utf16Offset, Utf16Range};

    fn context() -> PromptContext {
        PromptContext {
            document_id: DocumentId("doc_01".into()),
            revision: Revision(7),
            ranges: vec![Utf16Range {
                start: Utf16Offset(1),
                end: Utf16Offset(3),
            }],
            text: "a😀日本語".into(),
        }
    }

    fn acp_request() -> AiPromptRequest {
        AiPromptRequest {
            provider: AiProviderConfig {
                kind: AiProviderKind::Acp,
                acp: Some(AcpConfig {
                    preset: AcpPreset::Codex,
                    argv: None,
                }),
                openai: None,
                anthropic: None,
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

    #[test]
    fn handles_accept_valid_and_reject_bad() {
        assert!(validate_handle("copy_01", "x").is_ok());
        for bad in ["", "has space", "doc/1", "文書", &"x".repeat(129)] {
            assert!(validate_handle(bad, "x").is_err(), "{bad}");
        }
    }

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

    #[test]
    fn preset_argv_resolution_is_strict() {
        let codex = AcpConfig {
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
            preset: AcpPreset::Custom,
            argv: None,
        };
        assert!(resolve_acp_argv(&custom_missing).is_err());
        let preset_with_argv = AcpConfig {
            preset: AcpPreset::Opencode,
            argv: Some(AcpArgv {
                command: "x".into(),
                args: vec![],
            }),
        };
        assert!(resolve_acp_argv(&preset_with_argv).is_err());
        let custom = AcpConfig {
            preset: AcpPreset::Custom,
            argv: Some(AcpArgv {
                command: "my-agent".into(),
                args: vec!["--stdio".into()],
            }),
        };
        assert!(resolve_acp_argv(&custom).is_ok());
        let empty_command = AcpConfig {
            preset: AcpPreset::Custom,
            argv: Some(AcpArgv {
                command: String::new(),
                args: vec![],
            }),
        };
        assert!(resolve_acp_argv(&empty_command).is_err());
    }

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
        };
        assert!(validate_provider_config(&openai).is_ok());
        openai.acp = Some(AcpConfig {
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
        };
        assert!(matches!(
            validate_provider_config(&disabled),
            Err(AiError::InvalidConfig { .. })
        ));
        let mut enabled = disabled.clone();
        enabled.anthropic.as_mut().expect("set").enabled = true;
        assert!(validate_provider_config(&enabled).is_ok());
    }

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
        };
        http.session_id = Some(AcpSessionId("sess_1".into()));
        assert!(validate_prompt_request(&http).is_err());
        // Zero contexts are allowed for general questions.
        let mut bare = acp_request();
        bare.contexts.clear();
        assert!(validate_prompt_request(&bare).is_ok());
    }

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
        fn fill_buf(&mut self) -> std::io::Result<&[u8]> {
            Ok(self.data)
        }

        fn consume(&mut self, amount: usize) {
            self.data = &self.data[amount.min(self.data.len())..];
        }
    }

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

    #[test]
    fn acp_builders_and_update_parsing_keep_protocol_shape() {
        let init = acp_initialize(1);
        assert_eq!(init["method"], "initialize");
        assert_eq!(init["params"]["protocolVersion"], 1);
        assert_eq!(init["params"]["clientInfo"]["name"], "marxen");
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

    #[test]
    fn wire_rejects_claude_presets_and_tags_cancellation() {
        let rejected: Result<AcpPreset, _> = serde_json::from_str("\"claude_code\"");
        assert!(rejected.is_err());
        let value = serde_json::to_value(AiError::RequestCancelled).unwrap();
        assert_eq!(value, serde_json::json!({"code": "request_cancelled"}));
        let roundtrip: AiError = serde_json::from_value(value).unwrap();
        assert_eq!(roundtrip, AiError::RequestCancelled);
    }

    fn history_message(role: ChatRole, text: &str) -> ChatHistoryMessage {
        ChatHistoryMessage {
            role,
            text: text.into(),
        }
    }

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
        };
        let body = anthropic_body(&openai, "m");
        let messages = body["messages"].as_array().expect("messages");
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[0]["content"], "1件目の質問");
        assert_eq!(messages[1]["content"], "1件目の回答");
    }
}
