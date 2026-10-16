//! Decode advertised model controls and apply exact choices before prompting.
use super::acp::AgentConn;
use crate::contracts::ai::{AcpChoice, AcpConfigOption, AcpSelection, AiError};
use crate::domain::ai::PermissionAnswer;
use serde_json::{json, Value};

/// Decode supported select controls, flattening grouped ACP choices without inventing models.
pub(super) fn read_options(reply: &Value) -> Result<Vec<AcpConfigOption>, AiError> {
    let Some(raw) = reply
        .pointer("/result/configOptions")
        .filter(|value| !value.is_null())
    else {
        let Some(models) = reply.pointer("/result/models") else {
            return Ok(Vec::new());
        };
        let current_value = text(models, "currentModelId")?;
        let choices = models
            .get("availableModels")
            .and_then(Value::as_array)
            .ok_or_else(|| invalid("モデル候補が配列ではありません"))?;
        let options = choices
            .iter()
            .map(|choice| {
                Ok(AcpChoice {
                    value: text(choice, "modelId")?,
                    name: text(choice, "name")?,
                })
            })
            .collect::<Result<Vec<_>, AiError>>()?;
        if options.is_empty() {
            return Ok(Vec::new());
        }
        if !options.iter().any(|choice| choice.value == current_value) {
            return Err(invalid("エージェントの現在値がモデル候補にありません"));
        }
        return Ok(vec![AcpConfigOption {
            id: "model".into(),
            name: "Model".into(),
            category: "model".into(),
            current_value,
            options,
        }]);
    };
    let entries = raw
        .as_array()
        .ok_or_else(|| invalid("configOptions が配列ではありません"))?;
    let mut result = Vec::new();
    for entry in entries {
        let category = entry
            .get("category")
            .and_then(Value::as_str)
            .unwrap_or_else(|| match entry.get("id").and_then(Value::as_str) {
                Some("model") => "model",
                Some("reasoning_effort" | "thought_level") => "thought_level",
                _ => "",
            });
        if !matches!(category, "model" | "thought_level")
            || entry.get("type").and_then(Value::as_str) != Some("select")
        {
            continue;
        }
        let id = text(entry, "id")?;
        let name = text(entry, "name")?;
        let current_value = text(entry, "currentValue")?;
        let raw_choices = entry
            .get("options")
            .and_then(Value::as_array)
            .ok_or_else(|| invalid("モデル候補が配列ではありません"))?;
        let mut options = Vec::new();
        for choice in raw_choices {
            if let Some(group) = choice.get("options").and_then(Value::as_array) {
                for item in group {
                    options.push(read_choice(item)?);
                }
            } else {
                options.push(read_choice(choice)?);
            }
        }
        if options.is_empty() || !options.iter().any(|choice| choice.value == current_value) {
            return Err(invalid("エージェントの現在値がモデル候補にありません"));
        }
        if result
            .iter()
            .any(|option: &AcpConfigOption| option.id == id)
        {
            return Err(invalid("設定 ID が重複しています"));
        }
        result.push(AcpConfigOption {
            id,
            name,
            category: category.to_owned(),
            current_value,
            options,
        });
    }
    Ok(result)
}

/// Read a bounded protocol string, rejecting malformed or excessively large labels.
fn text(value: &Value, key: &str) -> Result<String, AiError> {
    let value = value
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && s.len() <= 4096 && !s.contains('\0'))
        .ok_or_else(|| invalid("エージェントのモデル設定を読み取れません"))?;
    Ok(value.to_owned())
}

/// Decode one advertised select value and its display label.
fn read_choice(value: &Value) -> Result<AcpChoice, AiError> {
    Ok(AcpChoice {
        value: text(value, "value")?,
        name: text(value, "name")?,
    })
}

/// Return a bounded configuration failure before a prompt can be sent.
fn invalid(detail: &str) -> AiError {
    AiError::InvalidConfig {
        detail: detail.to_owned(),
    }
}

/// Verify each requested choice against this session and require an exact agent acknowledgment.
pub(super) fn apply_selections(
    conn: &mut AgentConn,
    session_id: &str,
    reply: &Value,
    selected: &[AcpSelection],
) -> Result<(), AiError> {
    let mut options = read_options(reply)?;
    let legacy_models = reply
        .pointer("/result/configOptions")
        .is_none_or(Value::is_null)
        && reply.pointer("/result/models").is_some();
    // Apply the model first, then validate dependent reasoning choices against the new complete list.
    let mut ordered = selected.iter().collect::<Vec<_>>();
    ordered.sort_by_key(|selection| {
        options
            .iter()
            .find(|option| option.id == selection.id)
            .map(|option| option.category != "model")
            .unwrap_or(true)
    });
    for selection in ordered {
        let option = options.iter().find(|option| option.id == selection.id).ok_or_else(|| invalid("指定したモデル設定をこのエージェントは公開していません。候補を再取得してください"))?;
        if !option
            .options
            .iter()
            .any(|choice| choice.value == selection.value)
        {
            return Err(invalid(
                "指定したモデル・推論強度は利用できません。候補を再取得してください",
            ));
        }
        if option.current_value == selection.value {
            continue;
        }
        let id = conn.fresh_id();
        if legacy_models {
            conn.roundtrip(json!({"jsonrpc":"2.0","id":id,"method":"session/set_model","params":{"sessionId":session_id,"modelId":selection.value}}), PermissionAnswer::Deny, &mut |_| {})?;
            for option in &mut options {
                if option.id == selection.id {
                    option.current_value = selection.value.clone();
                }
            }
            continue;
        }
        let response = conn.roundtrip(
            json!({"jsonrpc":"2.0","id":id,"method":"session/set_config_option",
            "params":{"sessionId":session_id,"configId":selection.id,"value":selection.value}}),
            PermissionAnswer::Deny,
            &mut |_| {},
        )?;
        options = read_options(&response)?;
        if !options
            .iter()
            .any(|option| option.id == selection.id && option.current_value == selection.value)
        {
            return Err(invalid(
                "エージェントが指定モデル・推論強度を適用しませんでした",
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    /// Preserve real grouped choices and ignore unsupported controls.
    #[test]
    fn decodes_grouped_model_choices() {
        let reply = json!({"result":{"configOptions":[{"id":"model","name":"Model","category":"model","type":"select","currentValue":"m2","options":[{"group":"g","name":"Group","options":[{"value":"m1","name":"First"},{"value":"m2","name":"Second"}]}]},{"id":"flag","type":"boolean","category":"other","currentValue":true}]}});
        let result = read_options(&reply).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].options[1].value, "m2");
    }
    /// Fail malformed advertised defaults instead of fabricating a selected model.
    #[test]
    fn rejects_unknown_current_model() {
        assert!(read_options(&json!({"result":{"configOptions":[{"id":"model","name":"Model","category":"model","type":"select","currentValue":"missing","options":[{"value":"m1","name":"One"}]}]}})).is_err());
        assert!(read_options(&json!({"result":{"configOptions":{}}})).is_err());
    }
    /// Decode the real OpenCode v2 session shape: `model` plus `effort`
    /// (`thought_level`) are kept, `mode` is ignored without error.
    #[test]
    fn decodes_opencode_model_and_effort_ignoring_mode() {
        let reply = json!({"result":{
        "sessionId":"ses_test",
        "configOptions":[
            {"id":"model","name":"Model","category":"model","type":"select",
             "currentValue":"opencode-go/muse-spark-1.3-contributor",
             "options":[
                {"value":"opencode-go/claude-haiku-5-5","name":"opencode-go/Claude Haiku 5.5"},
                {"value":"opencode-go/muse-spark-1.3-contributor","name":"opencode-go/Muse Spark 1.3 Contributor"}]},
            {"id":"effort","name":"Effort","description":"Available effort levels","category":"thought_level","type":"select",
             "currentValue":"default",
             "options":[
                {"value":"low","name":"Low"},{"value":"high","name":"High"},
                {"value":"xhigh","name":"Xhigh"},{"value":"default","name":"Default"}]},
            {"id":"mode","name":"Session Mode","category":"mode","type":"select",
             "currentValue":"build",
             "options":[{"value":"build","name":"Build"},{"value":"plan","name":"Plan"}]}
        ]}});
        let result = read_options(&reply).unwrap();
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].id, "model");
        assert_eq!(
            result[0].current_value,
            "opencode-go/muse-spark-1.3-contributor"
        );
        assert!(result[0]
            .options
            .iter()
            .any(|choice| choice.value == "opencode-go/muse-spark-1.3-contributor"));
        assert_eq!(result[1].id, "effort");
        assert_eq!(result[1].category, "thought_level");
        assert!(result[1]
            .options
            .iter()
            .any(|choice| choice.value == "xhigh"));
    }
    /// Decode the real codex-acp session shape: `model` plus `reasoning_effort`
    /// (`thought_level`) are kept, `fast-mode`/`mode`/`collaboration_mode` and the
    /// newer top-level `models`/`modes` objects are ignored without error.
    #[test]
    fn decodes_codex_model_and_reasoning_effort_ignoring_extensions() {
        let reply = json!({"result":{
        "sessionId":"sess-codex",
        "models":{"availableModels":[{"modelId":"gpt-6-sol[low]","name":"6 Sol (low)"}],"currentModelId":"gpt-6-sol[low]"},
        "modes":{"availableModes":[{"id":"agent","name":"Auto review"}],"currentModeId":"agent"},
        "configOptions":[
            {"id":"mode","name":"Mode","category":"mode","type":"select",
             "currentValue":"agent",
             "options":[{"value":"agent","name":"Auto review"}]},
            {"id":"model","name":"Model","description":"Model Codex uses","category":"model","type":"select",
             "currentValue":"gpt-6-sol",
             "options":[
                {"value":"gpt-6-sol","name":"6 Sol","description":"Previous workhorse"},
                {"value":"gpt-6-luna","name":"6 Luna","description":"Fast"}]},
            {"id":"reasoning_effort","name":"Reasoning effort","category":"thought_level","type":"select",
             "currentValue":"low",
             "options":[
                {"value":"low","name":"Low"},{"value":"xhigh","name":"Xhigh"},
                {"value":"max","name":"Max"}]},
            {"id":"fast-mode","name":"Fast mode","category":"model_config","type":"select",
             "currentValue":"off",
             "options":[{"value":"off","name":"Off"},{"value":"on","name":"On"}]}
        ]}});
        let result = read_options(&reply).unwrap();
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].id, "model");
        assert_eq!(result[0].current_value, "gpt-6-sol");
        assert_eq!(result[1].id, "reasoning_effort");
        assert!(result[1]
            .options
            .iter()
            .any(|choice| choice.value == "xhigh"));
    }
}
