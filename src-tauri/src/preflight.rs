use base64::Engine;
use eventsource_stream::Eventsource;
use futures_util::StreamExt;
use reqwest::{header, Client, Response, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::RwLock;

#[derive(Debug, thiserror::Error)]
pub enum PreflightError {
    #[error("missing ICME_API_KEY (run signup or set it in ~/.icme/.env)")]
    MissingApiKey,
    #[error("http error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("api error {status}: {body}")]
    Api { status: u16, body: String },
    #[error("sse stream error: {0}")]
    Sse(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
}

impl serde::Serialize for PreflightError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

/// A single entry from the server's `accepts` array, parsed.
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct PaymentRequirements {
    pub scheme: String,
    pub network: String,    // e.g. "eip155:8453"
    pub chain_id: u64,
    pub asset: String,
    pub pay_to: String,
    pub amount: String,
    pub max_timeout_seconds: u64,
    pub token_name: String,
    pub token_version: String,
    pub raw: Value,
}

impl PaymentRequirements {
    pub fn from_value(v: Value) -> Result<Self, String> {
        let get_str = |key: &str| -> Result<String, String> {
            v.get(key)
                .and_then(|x| x.as_str())
                .map(|s| s.to_string())
                .ok_or_else(|| format!("missing field '{}'", key))
        };
        let scheme = get_str("scheme")?;
        let network = get_str("network")?;
        let asset = get_str("asset")?;
        let pay_to = get_str("payTo")?;
        let amount = v
            .get("amount")
            .and_then(|x| x.as_str().map(|s| s.to_string()).or_else(|| x.as_u64().map(|n| n.to_string())))
            .ok_or_else(|| "missing 'amount'".to_string())?;
        let max_timeout_seconds = v
            .get("maxTimeoutSeconds")
            .and_then(|x| x.as_u64())
            .unwrap_or(300);
        let chain_id = network
            .strip_prefix("eip155:")
            .and_then(|s| s.parse::<u64>().ok())
            .ok_or_else(|| format!("unsupported network '{}'", network))?;
        let token_name = v
            .get("extra")
            .and_then(|e| e.get("name"))
            .and_then(|n| n.as_str())
            .unwrap_or("USD Coin")
            .to_string();
        let token_version = v
            .get("extra")
            .and_then(|e| e.get("version"))
            .and_then(|n| n.as_str())
            .unwrap_or("2")
            .to_string();
        Ok(Self {
            scheme,
            network,
            chain_id,
            asset,
            pay_to,
            amount,
            max_timeout_seconds,
            token_name,
            token_version,
            raw: v,
        })
    }
}

#[derive(Clone)]
pub struct PreflightClient {
    http: Client,
    base: String,
    api_key: Arc<RwLock<Option<String>>>,
}

/// Canonical env file shared between the app and the Claude Code hook.
/// Follows the `~/.aws/credentials` / `~/.kube/config` convention: the
/// containing directory `~/.icme/` is hidden, so files inside don't repeat
/// the leading dot.
fn icme_env_path() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|h| {
        let mut p = PathBuf::from(h);
        p.push(".icme");
        p.push("env");
        p
    })
}

fn legacy_dotenv_path() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|h| {
        let mut p = PathBuf::from(h);
        p.push(".icme");
        p.push(".env");
        p
    })
}

/// Backwards-compat alias.
pub fn icme_hook_env_path() -> Option<PathBuf> {
    icme_env_path()
}

/// Migrate `~/.icme/.env` to `~/.icme/env`. Keys present in the legacy file
/// overwrite the canonical file (the app's most recent state wins).
fn migrate_legacy_env() {
    let (Some(new), Some(legacy)) = (icme_env_path(), legacy_dotenv_path()) else { return; };
    if !legacy.exists() { return; }
    if let Ok(vars) = read_env_file(&legacy) {
        for (k, v) in &vars {
            let _ = write_env_var(&new, k, v);
        }
    }
    let _ = std::fs::remove_file(&legacy);
}

pub fn icme_hook_script_path() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|h| {
        let mut p = PathBuf::from(h);
        p.push(".icme");
        p.push("preflight-hook.sh");
        p
    })
}

fn load_env_vars() {
    migrate_legacy_env();
    if let Some(p) = icme_env_path() {
        if p.exists() {
            let _ = dotenvy::from_path(&p);
        }
    }
}

impl PreflightClient {
    pub fn from_env() -> Self {
        load_env_vars();
        let api_key = std::env::var("ICME_API_KEY")
            .ok()
            .filter(|s| !s.trim().is_empty());
        let base = std::env::var("ICME_API_BASE")
            .unwrap_or_else(|_| "https://api.icme.io/v1".to_string());
        let http = Client::builder()
            .timeout(Duration::from_secs(60))
            .user_agent("preflight-app/0.1")
            .build()
            .expect("reqwest client");
        Self {
            http,
            base,
            api_key: Arc::new(RwLock::new(api_key)),
        }
    }

    pub async fn has_key(&self) -> bool {
        self.api_key.read().await.is_some()
    }

    pub async fn api_key_clone(&self) -> Option<String> {
        self.api_key.read().await.clone()
    }

    async fn key(&self) -> Result<String, PreflightError> {
        self.api_key
            .read()
            .await
            .clone()
            .ok_or(PreflightError::MissingApiKey)
    }

    pub async fn set_key(&self, key: String) {
        *self.api_key.write().await = Some(key);
    }

    pub async fn clear_key(&self) {
        *self.api_key.write().await = None;
    }

    async fn get_json(&self, path: &str) -> Result<Value, PreflightError> {
        let url = format!("{}{}", self.base, path);
        let key = self.key().await?;
        let resp = self
            .http
            .get(&url)
            .header("X-API-Key", key)
            .header(header::ACCEPT, "application/json")
            .send()
            .await?;
        json_or_err(resp).await
    }

    async fn post_json(&self, path: &str, payload: Value) -> Result<Value, PreflightError> {
        let url = format!("{}{}", self.base, path);
        let key = self.key().await?;
        let resp = self
            .http
            .post(&url)
            .header("X-API-Key", key)
            .header(header::ACCEPT, "application/json")
            .json(&payload)
            .send()
            .await?;
        json_or_err(resp).await
    }

    pub async fn me(&self) -> Result<Value, PreflightError> {
        self.get_json("/me").await
    }

    pub async fn list_policies(&self) -> Result<Value, PreflightError> {
        self.get_json("/me/policies").await
    }

    pub async fn policy_scenarios(&self, id: &str) -> Result<Value, PreflightError> {
        self.get_json(&format!("/policy/{}/scenarios", id)).await
    }

    pub async fn policy_rules(&self, id: &str) -> Result<Value, PreflightError> {
        self.get_json(&format!("/policy/{}", id)).await
    }

    pub async fn submit_scenario_feedback(
        &self,
        policy_id: &str,
        guard_content: &str,
        approved: bool,
        annotation: Option<&str>,
    ) -> Result<Value, PreflightError> {
        let mut payload = serde_json::json!({
            "policy_id": policy_id,
            "guard_content": guard_content,
            "approved": approved,
        });
        if let Some(a) = annotation {
            payload["annotation"] = Value::String(a.to_string());
        }
        self.post_json("/submitScenarioFeedback", payload).await
    }

    pub async fn check_relevance(&self, policy_id: &str, action: &str) -> Result<Value, PreflightError> {
        self.post_json(
            "/checkRelevance",
            serde_json::json!({ "policy_id": policy_id, "action": action }),
        )
        .await
    }

    /// Run an action check the same way the Claude Code hook does:
    /// `/v1/checkIt` (SSE), parse the final `data:` line, then collapse
    /// `result` + `ar_result` into a definitive SAT/UNSAT verdict.
    ///
    /// `/v1/checkItProd` is intentionally avoided here: its top-level
    /// `result` returns SAT for some policies even when AR finds a
    /// contradiction, so the in-app verdict was diverging from the hook.
    pub async fn check_prod(&self, policy_id: &str, action: &str) -> Result<Value, PreflightError> {
        let url = format!("{}/checkIt", self.base);
        let key = self.key().await?;
        let resp = self
            .http
            .post(&url)
            .header("X-API-Key", key)
            .header(header::ACCEPT, "text/event-stream")
            .json(&serde_json::json!({ "policy_id": policy_id, "action": action }))
            .send()
            .await?;
        let status = resp.status();
        let body = resp.text().await?;
        if !status.is_success() {
            return Err(PreflightError::Api { status: status.as_u16(), body });
        }

        // Pull the last `data: {...}` line out of the SSE stream. Fall back to
        // treating the whole body as JSON if no SSE markers are present.
        let payload = if body.lines().any(|l| l.starts_with("data: ")) {
            body.lines()
                .filter_map(|l| l.strip_prefix("data: "))
                .last()
                .unwrap_or("")
                .to_string()
        } else {
            body.clone()
        };

        let mut value: Value = serde_json::from_str(&payload)
            .map_err(|_| PreflightError::Api {
                status: status.as_u16(),
                body: format!("could not parse final SSE payload: {}", payload),
            })?;

        let top_result = value.get("result").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let ar_result = value.get("ar_result").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let blocked = top_result == "UNSAT" || ar_result == "UNSAT";
        let final_result = if blocked { "UNSAT" } else { "SAT" };

        // Normalize the response so the frontend can render verdict/blocked/reason
        // without caring about the underlying endpoint quirks.
        if let Some(obj) = value.as_object_mut() {
            obj.insert("result".to_string(), Value::String(final_result.to_string()));
            obj.insert("blocked".to_string(), Value::Bool(blocked));
            if !obj.contains_key("reason") {
                if let Some(d) = obj.get("detail").cloned() {
                    obj.insert("reason".to_string(), d);
                }
            }
        }
        Ok(value)
    }

    pub async fn proof_meta(&self, id: &str) -> Result<Value, PreflightError> {
        self.get_json(&format!("/proof/{}", id)).await
    }

    /// Step 1 of signup: POST /createUserX402 with username, parse the 402 payment requirements.
    pub async fn signup_quote(&self, username: &str) -> Result<PaymentRequirements, PreflightError> {
        let url = format!("{}/createUserX402", self.base);
        let resp = self
            .http
            .post(&url)
            .header(header::ACCEPT, "application/json")
            .header(header::CONTENT_TYPE, "application/json")
            .json(&serde_json::json!({ "username": username }))
            .send()
            .await?;
        let status = resp.status();
        let body = resp.text().await?;
        let json: Value = serde_json::from_str(&body)
            .map_err(|_| PreflightError::Api { status: status.as_u16(), body: body.clone() })?;

        if status.is_success() {
            // Account already exists (unlikely on first signup) — return as if it were a quote with no payment needed.
            return Err(PreflightError::Api {
                status: status.as_u16(),
                body: format!("Server returned 200 instead of 402 on signup_quote: {}", body),
            });
        }
        if status != StatusCode::PAYMENT_REQUIRED {
            return Err(PreflightError::Api { status: status.as_u16(), body });
        }

        let accepts = json
            .get("accepts")
            .and_then(|v| v.as_array())
            .ok_or_else(|| PreflightError::Api {
                status: status.as_u16(),
                body: format!("402 response missing 'accepts' array: {}", body),
            })?;

        let chosen = accepts
            .iter()
            .find(|a| {
                a.get("scheme").and_then(|s| s.as_str()) == Some("exact")
                    && a.get("network").and_then(|n| n.as_str())
                        .map(|n| n.starts_with("eip155"))
                        .unwrap_or(false)
            })
            .or_else(|| accepts.first())
            .ok_or_else(|| PreflightError::Api {
                status: status.as_u16(),
                body: "402 response had empty accepts array".into(),
            })?;

        PaymentRequirements::from_value(chosen.clone()).map_err(|e| PreflightError::Api {
            status: status.as_u16(),
            body: format!("Could not parse PaymentRequirements: {} (raw: {})", e, body),
        })
    }

    /// Step 2 of signup: POST /createUserX402 with the signed PaymentPayload in the PAYMENT-SIGNATURE header.
    pub async fn signup_finalize(
        &self,
        username: &str,
        requirements: &PaymentRequirements,
        authorization: &Value,
        signature: &str,
    ) -> Result<Value, PreflightError> {
        let payload = serde_json::json!({
            "x402Version": 2,
            "accepted": requirements.raw,
            "payload": {
                "signature": signature,
                "authorization": authorization,
            },
        });
        let header_val = base64::engine::general_purpose::STANDARD.encode(payload.to_string());

        let url = format!("{}/createUserX402", self.base);
        let resp = self
            .http
            .post(&url)
            .header(header::ACCEPT, "application/json")
            .header(header::CONTENT_TYPE, "application/json")
            .header("PAYMENT-SIGNATURE", header_val)
            .json(&serde_json::json!({ "username": username }))
            .send()
            .await?;
        let status = resp.status();
        let body = resp.text().await?;
        if !status.is_success() {
            return Err(PreflightError::Api { status: status.as_u16(), body });
        }
        Ok(serde_json::from_str(&body)?)
    }

    /// Stream `/checkIt` SSE events and emit them as `preflight://check` Tauri events.
    pub async fn check_it_sse(
        &self,
        app: &AppHandle,
        stream_id: &str,
        policy_id: &str,
        action: &str,
    ) -> Result<(), PreflightError> {
        let url = format!("{}/checkIt", self.base);
        let key = self.key().await?;
        let resp = self
            .http
            .post(&url)
            .header("X-API-Key", key)
            .header(header::ACCEPT, "text/event-stream")
            .json(&serde_json::json!({ "policy_id": policy_id, "action": action }))
            .send()
            .await?;
        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let body = resp.text().await.unwrap_or_default();
            return Err(PreflightError::Api { status, body });
        }
        stream_sse(app, "preflight://check", stream_id, resp).await
    }

    /// Stream `/makeRules` SSE events as `preflight://make-rules` Tauri events.
    pub async fn make_rules_sse(
        &self,
        app: &AppHandle,
        stream_id: &str,
        policy_text: &str,
    ) -> Result<(), PreflightError> {
        let url = format!("{}/makeRules", self.base);
        let key = self.key().await?;
        let resp = self
            .http
            .post(&url)
            .header("X-API-Key", key)
            .header(header::ACCEPT, "text/event-stream")
            .json(&serde_json::json!({ "policy": policy_text }))
            .send()
            .await?;
        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let body = resp.text().await.unwrap_or_default();
            return Err(PreflightError::Api { status, body });
        }
        stream_sse(app, "preflight://make-rules", stream_id, resp).await
    }

    /// Stream `/refinePolicy` SSE events as `preflight://refine-policy` Tauri events.
    pub async fn refine_policy_sse(
        &self,
        app: &AppHandle,
        stream_id: &str,
        policy_id: &str,
    ) -> Result<(), PreflightError> {
        let url = format!("{}/refinePolicy", self.base);
        let key = self.key().await?;
        let resp = self
            .http
            .post(&url)
            .header("X-API-Key", key)
            .header(header::ACCEPT, "text/event-stream")
            .json(&serde_json::json!({ "policy_id": policy_id }))
            .send()
            .await?;
        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let body = resp.text().await.unwrap_or_default();
            return Err(PreflightError::Api { status, body });
        }
        stream_sse(app, "preflight://refine-policy", stream_id, resp).await
    }
}

async fn json_or_err(resp: Response) -> Result<Value, PreflightError> {
    let status = resp.status();
    let body = resp.text().await?;
    if !status.is_success() {
        return Err(PreflightError::Api { status: status.as_u16(), body });
    }
    Ok(serde_json::from_str(&body)?)
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SseEvent {
    pub stream_id: String,
    pub event: String,
    pub data: Value,
}

async fn stream_sse(
    app: &AppHandle,
    channel: &str,
    stream_id: &str,
    resp: Response,
) -> Result<(), PreflightError> {
    let mut stream = resp.bytes_stream().eventsource();
    while let Some(item) = stream.next().await {
        match item {
            Ok(ev) => {
                let kind = if ev.event.is_empty() { "message".to_string() } else { ev.event.clone() };
                let data: Value = serde_json::from_str(&ev.data).unwrap_or(Value::String(ev.data));
                let payload = SseEvent { stream_id: stream_id.to_string(), event: kind.clone(), data };
                let _ = app.emit(channel, payload);
                if kind.eq_ignore_ascii_case("done") || kind.eq_ignore_ascii_case("error") {
                    break;
                }
            }
            Err(e) => return Err(PreflightError::Sse(e.to_string())),
        }
    }
    Ok(())
}

/// Read `KEY=VALUE` lines from an env file, returning a map.
pub fn read_env_file(path: &Path) -> Result<std::collections::HashMap<String, String>, PreflightError> {
    let mut map = std::collections::HashMap::new();
    if !path.exists() {
        return Ok(map);
    }
    let text = std::fs::read_to_string(path)?;
    for line in text.lines() {
        let line = line.trim_start();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some(eq) = line.find('=') {
            let k = line[..eq].trim().to_string();
            let mut v = line[eq + 1..].trim().to_string();
            if (v.starts_with('"') && v.ends_with('"')) || (v.starts_with('\'') && v.ends_with('\'')) {
                v = v[1..v.len() - 1].to_string();
            }
            map.insert(k, v);
        }
    }
    Ok(map)
}

/// Write a `KEY=VALUE` line to the env file, replacing any existing line with the same key
/// while preserving the rest. Creates parent dirs and chmods 0600 on Unix.
pub fn write_env_var(path: &Path, key: &str, value: &str) -> Result<(), PreflightError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut lines: Vec<String> = if path.exists() {
        std::fs::read_to_string(path)?
            .lines()
            .filter(|l| !l.trim_start().starts_with(&format!("{}=", key)))
            .map(|l| l.to_string())
            .collect()
    } else {
        Vec::new()
    };
    lines.push(format!("{}={}", key, value));
    let mut contents = lines.join("\n");
    contents.push('\n');
    std::fs::write(path, contents)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(path)?.permissions();
        perms.set_mode(0o600);
        std::fs::set_permissions(path, perms)?;
    }
    Ok(())
}

fn remove_key_from_file(path: &Path, key: &str) -> Result<(), PreflightError> {
    if !path.exists() {
        return Ok(());
    }
    let prefix = format!("{}=", key);
    let kept: Vec<String> = std::fs::read_to_string(path)?
        .lines()
        .filter(|l| !l.trim_start().starts_with(&prefix))
        .map(String::from)
        .collect();
    let mut contents = kept.join("\n");
    if !contents.is_empty() {
        contents.push('\n');
    }
    std::fs::write(path, contents)?;
    Ok(())
}

/// Remove the `ICME_API_KEY=` line from `~/.icme/env`, preserving other lines.
pub fn remove_api_key_from_disk() -> Result<(), PreflightError> {
    let path = icme_env_path().ok_or_else(|| std::io::Error::new(
        std::io::ErrorKind::NotFound,
        "HOME not set",
    ))?;
    remove_key_from_file(&path, "ICME_API_KEY")
}

/// Return the ICME_API_KEY currently stored in `~/.icme/env`, if any.
pub fn read_api_key_from_hook_env() -> Option<String> {
    let path = icme_hook_env_path()?;
    let map = read_env_file(&path).ok()?;
    map.get("ICME_API_KEY").cloned().filter(|s| !s.trim().is_empty())
}

/// Return the contents of `~/.icme/preflight-hook.sh` if it exists.
pub fn read_hook_script() -> Option<String> {
    let path = icme_hook_script_path()?;
    std::fs::read_to_string(&path).ok()
}

pub fn icme_activity_log_path() -> Option<PathBuf> {
    if let Ok(custom) = std::env::var("ICME_LOG_FILE") {
        if !custom.is_empty() {
            return Some(PathBuf::from(custom));
        }
    }
    std::env::var_os("HOME").map(|h| {
        let mut p = PathBuf::from(h);
        p.push(".icme");
        p.push("preflight-activity.log");
        p
    })
}

/// Delete the activity log file (best-effort).
pub fn clear_activity_log_file() {
    if let Some(path) = icme_activity_log_path() {
        let _ = std::fs::remove_file(&path);
    }
}

fn claude_settings_paths() -> Vec<PathBuf> {
    let home = match std::env::var_os("HOME") { Some(h) => h, None => return vec![] };
    let mut base = PathBuf::from(home);
    base.push(".claude");
    let mut out = Vec::new();
    let mut a = base.clone(); a.push("settings.json"); out.push(a);
    let mut b = base; b.push("settings.local.json"); out.push(b);
    out
}

/// Strip every PreToolUse hook entry that references `preflight-hook.sh` from
/// Claude Code's user-scope settings files. Preserves other hooks and any
/// non-hook settings. Removes empty PreToolUse arrays and empty hooks objects.
pub fn strip_preflight_from_claude_settings() {
    for path in claude_settings_paths() {
        if !path.exists() { continue; }
        let text = match std::fs::read_to_string(&path) { Ok(t) => t, Err(_) => continue };
        let mut value: Value = match serde_json::from_str(&text) { Ok(v) => v, Err(_) => continue };

        let mut changed = false;
        let mut drop_hooks = false;

        if let Some(hooks) = value.get_mut("hooks").and_then(|h| h.as_object_mut()) {
            // Walk every event array (PreToolUse, PostToolUse, etc.) but the user only
            // asked about PreToolUse; do all of them to be thorough.
            let keys: Vec<String> = hooks.keys().cloned().collect();
            for event in keys {
                if let Some(entries) = hooks.get_mut(&event).and_then(|e| e.as_array_mut()) {
                    let before = entries.len();
                    entries.retain(|entry| !entry_references_preflight(entry));
                    if entries.len() != before { changed = true; }
                    if entries.is_empty() {
                        hooks.remove(&event);
                        changed = true;
                    }
                }
            }
            if hooks.is_empty() { drop_hooks = true; }
        }

        if drop_hooks {
            if let Some(obj) = value.as_object_mut() {
                obj.remove("hooks");
                changed = true;
            }
        }

        if changed {
            if let Ok(out) = serde_json::to_string_pretty(&value) {
                let mut out = out;
                out.push('\n');
                let _ = std::fs::write(&path, out);
            }
        }
    }
}

fn entry_references_preflight(entry: &Value) -> bool {
    // An entry looks like:
    //   { "matcher": "...", "hooks": [ { "type": "command", "command": "..." } ] }
    // We match if any inner command string contains "preflight-hook.sh".
    if let Some(arr) = entry.get("hooks").and_then(|h| h.as_array()) {
        for h in arr {
            if let Some(cmd) = h.get("command").and_then(|c| c.as_str()) {
                if cmd.contains("preflight-hook.sh") { return true; }
            }
        }
    }
    false
}

/// Append a single JSON line to the activity log. Best-effort, errors are swallowed.
pub fn append_activity_entry(entry: &Value) {
    let path = match icme_activity_log_path() {
        Some(p) => p,
        None => return,
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let line = entry.to_string();
    let mut line_with_newline = line;
    line_with_newline.push('\n');
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        use std::io::Write;
        let _ = f.write_all(line_with_newline.as_bytes());
    }
}

/// Read up to `limit` most-recent JSON lines from the activity log.
/// Lines that fail to parse are skipped.
pub fn read_activity_log(limit: usize) -> Result<Vec<Value>, PreflightError> {
    let path = match icme_activity_log_path() {
        Some(p) => p,
        None => return Ok(vec![]),
    };
    if !path.exists() {
        return Ok(vec![]);
    }
    let text = std::fs::read_to_string(&path)?;
    let mut out: Vec<Value> = Vec::new();
    for line in text.lines().rev() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<Value>(trimmed) {
            out.push(v);
            if out.len() >= limit {
                break;
            }
        }
    }
    out.reverse();
    Ok(out)
}

/// Persist an API key to `~/.icme/.env` with mode 0600.
/// Preserves other keys (e.g. ICME_POLICY_ID) if the file already exists.
pub fn save_api_key_to_disk(api_key: &str) -> Result<PathBuf, PreflightError> {
    let path = icme_env_path().ok_or_else(|| std::io::Error::new(
        std::io::ErrorKind::NotFound,
        "HOME not set",
    ))?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut lines: Vec<String> = if path.exists() {
        std::fs::read_to_string(&path)?
            .lines()
            .filter(|l| !l.trim_start().starts_with("ICME_API_KEY="))
            .map(|l| l.to_string())
            .collect()
    } else {
        Vec::new()
    };
    lines.push(format!("ICME_API_KEY={}", api_key));
    let mut contents = lines.join("\n");
    contents.push('\n');
    std::fs::write(&path, contents)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&path)?.permissions();
        perms.set_mode(0o600);
        std::fs::set_permissions(&path, perms)?;
    }
    Ok(path)
}
