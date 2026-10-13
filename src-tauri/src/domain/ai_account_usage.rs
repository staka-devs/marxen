//! Validate official Codex account limits independently of prompt-token counters.
use crate::contracts::ai::{CodexUsageBucket, UsageCredits, UsageWindow};
use serde_json::Value;

/// Accept a bounded readable bucket identifier or label without terminal controls.
fn label(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?;
    (!text.is_empty() && text.len() <= 256 && !text.chars().any(char::is_control))
        .then(|| text.to_owned())
}

/// Validate one quota window while leaving unreported duration and reset time absent.
fn window(value: Option<&Value>) -> Option<UsageWindow> {
    let value = value?.as_object()?;
    let used_percent = value.get("usedPercent")?.as_f64()?;
    if !used_percent.is_finite() || !(0.0..=100.0).contains(&used_percent) {
        return None;
    }
    Some(UsageWindow {
        used_percent,
        window_duration_mins: value
            .get("windowDurationMins")
            .and_then(Value::as_u64)
            .and_then(|minutes| u32::try_from(minutes).ok()),
        resets_at: value
            .get("resetsAt")
            .and_then(Value::as_u64)
            .filter(|seconds| *seconds <= 8_640_000_000_000),
    })
}

/// Preserve reported credit status and decimal balance without deriving currency or spend.
fn credits(value: Option<&Value>) -> Option<UsageCredits> {
    let value = value?.as_object()?;
    let balance = value
        .get("balance")
        .and_then(Value::as_str)
        .filter(|amount| {
            amount.len() <= 128
                && amount
                    .parse::<f64>()
                    .is_ok_and(|number| number.is_finite() && number >= 0.0)
        });
    Some(UsageCredits {
        has_credits: value.get("hasCredits")?.as_bool()?,
        unlimited: value.get("unlimited")?.as_bool()?,
        balance: balance.map(str::to_owned),
    })
}

/// Parse the multi-bucket view when supplied, otherwise the official legacy single bucket.
/// Unknown account fields are ignored; token counts never become quotas or credit balances.
pub fn parse_codex_rate_limits(result: &Value) -> Vec<CodexUsageBucket> {
    let values: Vec<_> =
        if let Some(buckets) = result.get("rateLimitsByLimitId").and_then(Value::as_object) {
            buckets
                .iter()
                .take(16)
                .map(|(key, value)| (key.as_str(), value))
                .collect()
        } else if let Some(single) = result.get("rateLimits").filter(|value| value.is_object()) {
            vec![("codex", single)]
        } else {
            Vec::new()
        };
    values
        .into_iter()
        .filter_map(|(key, value)| {
            let id = label(value.get("limitId"))
                .or_else(|| label(Some(&Value::String(key.to_owned()))))?;
            let primary = window(value.get("primary"));
            let secondary = window(value.get("secondary"));
            let credits = credits(value.get("credits"));
            if primary.is_none() && secondary.is_none() && credits.is_none() {
                return None;
            }
            Some(CodexUsageBucket {
                id,
                name: label(value.get("limitName")),
                primary,
                secondary,
                credits,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    /// Preserve reported zeroes, duration, reset seconds and decimal credit text.
    fn parses_actual_limit_fields_without_inventing_values() {
        let reports = parse_codex_rate_limits(&json!({"rateLimits": {
            "limitId": "codex", "primary": {"usedPercent": 0, "windowDurationMins": 300, "resetsAt": 1800000000},
            "credits": {"hasCredits": false, "unlimited": false, "balance": "0"}
        }}));
        assert_eq!(reports.len(), 1);
        let first = &reports[0];
        assert_eq!(first.primary.as_ref().unwrap().used_percent, 0.0);
        assert_eq!(
            first.primary.as_ref().unwrap().window_duration_mins,
            Some(300)
        );
        assert_eq!(first.primary.as_ref().unwrap().resets_at, Some(1800000000));
        assert!(first.secondary.is_none());
        assert_eq!(
            first.credits.as_ref().unwrap().balance.as_deref(),
            Some("0")
        );
    }

    #[test]
    /// Keep distinct reported quota buckets and prefer the authoritative multi-bucket view.
    fn keeps_multiple_buckets_separate() {
        let reports = parse_codex_rate_limits(
            &json!({"rateLimits": {"limitId": "obsolete", "primary": {"usedPercent": 99}},
                "rateLimitsByLimitId": {"codex": {"primary": {"usedPercent": 25}}, "other": {"limitName": "Other quota", "secondary": {"usedPercent": 42}}}
            }),
        );
        assert_eq!(reports.len(), 2);
        assert_eq!(reports[0].id, "codex");
        assert_eq!(reports[1].id, "other");
        assert_eq!(reports[1].name.as_deref(), Some("Other quota"));
        assert!(reports[0].primary.as_ref().unwrap().resets_at.is_none());
        assert!(reports[0].credits.is_none());
    }

    #[test]
    /// Drop malformed windows and unknown credit flags without converting absence to zero.
    fn malformed_reports_do_not_become_valid_zeroes() {
        for primary in [
            json!({}),
            json!({"usedPercent": -1}),
            json!({"usedPercent": 101}),
            json!({"usedPercent": "25"}),
        ] {
            assert!(
                parse_codex_rate_limits(&json!({"rateLimits": {"primary": primary}})).is_empty()
            );
        }
        assert!(
            parse_codex_rate_limits(&json!({"rateLimits": {"credits": {"balance": "0"}}}))
                .is_empty()
        );
        assert!(
            parse_codex_rate_limits(&json!({"inputTokens": 100, "outputTokens": 20})).is_empty()
        );
    }

    #[test]
    /// Reject unsafe reset times and decimal balances while retaining other reported fields.
    fn invalid_optional_values_remain_unreported() {
        let reports = parse_codex_rate_limits(
            &json!({"rateLimits": {"primary": {"usedPercent": 12.5, "resetsAt": 9007199254740991_u64, "windowDurationMins": -1},
                "credits": {"hasCredits": true, "unlimited": false, "balance": "NaN"}
            }}),
        );
        let report = &reports[0];
        assert!(report.primary.as_ref().unwrap().resets_at.is_none());
        assert!(report
            .primary
            .as_ref()
            .unwrap()
            .window_duration_mins
            .is_none());
        assert!(report.credits.as_ref().unwrap().balance.is_none());
        assert!(report.credits.as_ref().unwrap().has_credits);
    }
}
