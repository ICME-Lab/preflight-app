mod preflight;
mod signer;

use preflight::{
    append_activity_entry, clear_activity_log_file, icme_hook_env_path, icme_hook_script_path,
    read_activity_log, read_api_key_from_hook_env, read_env_file, read_hook_script,
    remove_api_key_from_disk, save_api_key_to_disk, strip_preflight_from_claude_settings,
    write_env_var, PreflightClient, PreflightError,
};
use chrono::Utc;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, BufReader};
use serde_json::{json, Value};
use signer::{random_nonce_hex, random_session_id, SignerConfig, SignerOutcome};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};

struct AppState {
    client: PreflightClient,
}

#[tauri::command]
async fn has_api_key(state: State<'_, AppState>) -> Result<bool, PreflightError> {
    Ok(state.client.has_key().await)
}

#[tauri::command]
async fn get_api_key(state: State<'_, AppState>) -> Result<Option<String>, PreflightError> {
    Ok(state.client.api_key_clone().await)
}

#[tauri::command]
async fn get_me(state: State<'_, AppState>) -> Result<Value, PreflightError> {
    state.client.me().await
}

#[tauri::command]
async fn list_policies(state: State<'_, AppState>) -> Result<Value, PreflightError> {
    state.client.list_policies().await
}

#[tauri::command]
async fn get_policy_scenarios(
    state: State<'_, AppState>,
    policy_id: String,
) -> Result<Value, PreflightError> {
    state.client.policy_scenarios(&policy_id).await
}

#[tauri::command]
async fn get_policy_rules(
    state: State<'_, AppState>,
    policy_id: String,
) -> Result<Value, PreflightError> {
    state.client.policy_rules(&policy_id).await
}

#[tauri::command]
async fn submit_scenario_feedback(
    state: State<'_, AppState>,
    policy_id: String,
    guard_content: String,
    approved: bool,
    annotation: Option<String>,
) -> Result<Value, PreflightError> {
    state
        .client
        .submit_scenario_feedback(&policy_id, &guard_content, approved, annotation.as_deref())
        .await
}

#[tauri::command]
async fn check_relevance(
    state: State<'_, AppState>,
    policy_id: String,
    action: String,
) -> Result<Value, PreflightError> {
    state.client.check_relevance(&policy_id, &action).await
}

#[tauri::command]
async fn check_action(
    state: State<'_, AppState>,
    policy_id: String,
    action: String,
) -> Result<Value, PreflightError> {
    let result = state.client.check_prod(&policy_id, &action).await?;
    let verdict = result.get("result").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let blocked = result
        .get("blocked")
        .and_then(|v| v.as_bool())
        .unwrap_or(verdict == "UNSAT");
    let reason = result
        .get("reason")
        .and_then(|v| v.as_str())
        .or_else(|| result.get("detail").and_then(|v| v.as_str()))
        .unwrap_or("")
        .to_string();
    let check_id = result
        .get("check_id")
        .and_then(|v| v.as_str())
        .or_else(|| result.get("proof_id").and_then(|v| v.as_str()))
        .unwrap_or("")
        .to_string();
    let entry = serde_json::json!({
        "ts": Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        "source": "app",
        "tool": Value::Null,
        "input": action,
        "plain_english": action,
        "result": verdict,
        "detail": reason,
        "check_id": check_id,
        "policy_id": policy_id,
        "blocked": blocked,
    });
    append_activity_entry(&entry);
    Ok(result)
}

#[tauri::command]
async fn check_action_sse(
    app: AppHandle,
    state: State<'_, AppState>,
    stream_id: String,
    policy_id: String,
    action: String,
) -> Result<(), PreflightError> {
    state.client.check_it_sse(&app, &stream_id, &policy_id, &action).await
}

#[tauri::command]
async fn make_rules_sse(
    app: AppHandle,
    state: State<'_, AppState>,
    stream_id: String,
    policy_text: String,
) -> Result<(), PreflightError> {
    state.client.make_rules_sse(&app, &stream_id, &policy_text).await
}

#[tauri::command]
async fn refine_policy_sse(
    app: AppHandle,
    state: State<'_, AppState>,
    stream_id: String,
    policy_id: String,
) -> Result<(), PreflightError> {
    state.client.refine_policy_sse(&app, &stream_id, &policy_id).await
}

#[tauri::command]
async fn get_proof(state: State<'_, AppState>, proof_id: String) -> Result<Value, PreflightError> {
    state.client.proof_meta(&proof_id).await
}

#[tauri::command]
async fn read_activity(limit: Option<usize>) -> Result<Vec<Value>, PreflightError> {
    read_activity_log(limit.unwrap_or(500))
}

#[tauri::command]
async fn get_hook_status() -> Result<Value, PreflightError> {
    let script = icme_hook_script_path();
    let env = icme_hook_env_path();
    let script_present = script.as_ref().map(|p| p.exists()).unwrap_or(false);
    let env_map = match env.as_ref() {
        Some(p) => read_env_file(p).unwrap_or_default(),
        None => Default::default(),
    };
    let enabled = env_map
        .get("ICME_HOOK_ENABLED")
        .map(|v| matches!(v.as_str(), "true" | "TRUE" | "1" | "yes" | "YES"))
        .unwrap_or(true);
    let policy_id = env_map.get("ICME_POLICY_ID").cloned();
    Ok(serde_json::json!({
        "installed": script_present,
        "script_path": script.map(|p| p.to_string_lossy().to_string()),
        "env_path": env.map(|p| p.to_string_lossy().to_string()),
        "enabled": enabled,
        "policy_id": policy_id,
    }))
}

#[tauri::command]
async fn set_hook_enabled(enabled: bool) -> Result<(), PreflightError> {
    let path = icme_hook_env_path().ok_or_else(|| std::io::Error::new(
        std::io::ErrorKind::NotFound,
        "HOME not set",
    ))?;
    write_env_var(&path, "ICME_HOOK_ENABLED", if enabled { "true" } else { "false" })
}

#[tauri::command]
async fn set_hook_policy(policy_id: String) -> Result<(), PreflightError> {
    let path = icme_hook_env_path().ok_or_else(|| std::io::Error::new(
        std::io::ErrorKind::NotFound,
        "HOME not set",
    ))?;
    write_env_var(&path, "ICME_POLICY_ID", &policy_id)
}

async fn run_icme_preflight(app: &AppHandle, subcommand: &str, channel: &str) -> Result<i32, PreflightError> {
    let mut cmd = tokio::process::Command::new("npx");
    cmd.args(["--yes", "icme-claude-preflight", subcommand])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut path = std::env::var("PATH").unwrap_or_default();
    for extra in ["/opt/homebrew/bin", "/usr/local/bin"] {
        if !path.split(':').any(|s| s == extra) {
            path.push(':');
            path.push_str(extra);
        }
    }
    cmd.env("PATH", path);

    let mut child = cmd
        .spawn()
        .map_err(|e| PreflightError::Sse(format!("could not spawn npx: {}", e)))?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let app_out = app.clone();
    let app_err = app.clone();
    let channel_out = channel.to_string();
    let channel_err = channel.to_string();
    let _ = app.emit(channel, serde_json::json!({ "stream": "info", "line": format!("Running: npx --yes icme-claude-preflight {}", subcommand) }));

    let out_handle = tokio::spawn(async move {
        if let Some(s) = stdout {
            let mut reader = BufReader::new(s).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                let _ = app_out.emit(&channel_out, serde_json::json!({ "stream": "stdout", "line": line }));
            }
        }
    });
    let err_handle = tokio::spawn(async move {
        if let Some(s) = stderr {
            let mut reader = BufReader::new(s).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                let _ = app_err.emit(&channel_err, serde_json::json!({ "stream": "stderr", "line": line }));
            }
        }
    });

    let status = child
        .wait()
        .await
        .map_err(|e| PreflightError::Sse(format!("wait failed: {}", e)))?;
    let _ = out_handle.await;
    let _ = err_handle.await;
    let code = status.code().unwrap_or(-1);
    let _ = app.emit(channel, serde_json::json!({ "stream": "info", "line": format!("Process exited with status {}", code) }));
    Ok(code)
}

#[tauri::command]
async fn install_claude_preflight(app: AppHandle) -> Result<i32, PreflightError> {
    run_icme_preflight(&app, "init", "install://line").await
}

#[tauri::command]
async fn uninstall_claude_preflight(app: AppHandle) -> Result<i32, PreflightError> {
    let code = run_icme_preflight(&app, "uninstall", "install://line").await?;
    // Belt-and-braces: also strip any leftover preflight entries from Claude's
    // settings.json / settings.local.json in case the CLI doesn't cover both.
    strip_preflight_from_claude_settings();
    Ok(code)
}

#[derive(Debug, thiserror::Error)]
enum SignupError {
    #[error(transparent)]
    Preflight(#[from] PreflightError),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("signing timed out")]
    Timeout,
    #[error("signing cancelled: {0}")]
    Cancelled(String),
    #[error("could not open browser: {0}")]
    Browser(String),
    #[error("server returned no api_key: {0}")]
    NoApiKey(String),
}

impl serde::Serialize for SignupError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

fn human_amount(base_units: &str, token: &str) -> String {
    // USDC / USDT / DAI on Base are 6 decimals; default to that.
    let n: u128 = base_units.parse().unwrap_or(0);
    let whole = n / 1_000_000;
    let frac = n % 1_000_000;
    format!("{}.{:06} {}", whole, frac, token)
}

#[tauri::command]
async fn signup(
    state: State<'_, AppState>,
    app: AppHandle,
    username: String,
) -> Result<Value, SignupError> {
    let username = username.trim().to_string();
    if username.is_empty() {
        return Err(SignupError::Cancelled("username is empty".into()));
    }

    // 1. Get payment quote (402 response).
    let req = state.client.signup_quote(&username).await?;

    // 2. Build authorization params (nonce, validAfter, validBefore).
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let valid_after = now.saturating_sub(60); // small back-window for clock skew
    let valid_before = now + req.max_timeout_seconds.min(600);
    let nonce = random_nonce_hex();
    let session_id = random_session_id();

    let config = SignerConfig {
        chain_id: req.chain_id,
        chain_hex: format!("0x{:x}", req.chain_id),
        token_name: req.token_name.clone(),
        token_version: req.token_version.clone(),
        token_address: req.asset.clone(),
        amount: req.amount.clone(),
        amount_display: human_amount(&req.amount, &req.token_name),
        pay_to: req.pay_to.clone(),
        valid_after: valid_after.to_string(),
        valid_before: valid_before.to_string(),
        nonce: nonce.clone(),
        session_id: session_id.clone(),
    };

    // 3. Spawn the local signer server.
    let (port, rx) = signer::serve(config).await?;
    let url = format!("http://127.0.0.1:{}/sign?s={}", port, session_id);

    // 4. Open the user's default browser.
    open::that(&url).map_err(|e| SignupError::Browser(e.to_string()))?;

    // 5. Wait for the signature (cap at 10 minutes).
    let outcome = tokio::time::timeout(Duration::from_secs(600), rx)
        .await
        .map_err(|_| SignupError::Timeout)?
        .map_err(|_| SignupError::Cancelled("signer channel closed".into()))?;

    let (from, signature) = match outcome {
        SignerOutcome::Signed { from, signature } => (from, signature),
        SignerOutcome::Failed(reason) => return Err(SignupError::Cancelled(reason)),
    };

    let _ = app.emit("signup://signed-by", &from);

    // 6. Build the authorization object and call finalize.
    let authorization = json!({
        "from": from,
        "to": req.pay_to,
        "value": req.amount,
        "validAfter": valid_after.to_string(),
        "validBefore": valid_before.to_string(),
        "nonce": nonce,
    });

    let result = state
        .client
        .signup_finalize(&username, &req, &authorization, &signature)
        .await?;

    // 7. Extract api_key, persist, and update in-memory client.
    let api_key = result
        .get("api_key")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| SignupError::NoApiKey(result.to_string()))?;

    save_api_key_to_disk(&api_key).map_err(PreflightError::from)?;
    state.client.set_key(api_key.clone()).await;

    Ok(result)
}

#[tauri::command]
async fn save_api_key(state: State<'_, AppState>, api_key: String) -> Result<String, PreflightError> {
    let path = save_api_key_to_disk(&api_key)?;
    state.client.set_key(api_key).await;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
async fn get_hook_env_api_key() -> Result<Option<String>, PreflightError> {
    Ok(read_api_key_from_hook_env())
}

#[tauri::command]
async fn get_hook_script() -> Result<Option<String>, PreflightError> {
    Ok(read_hook_script())
}

/// Stripe-card signup: kick off /createUserCard, open Stripe Checkout in the
/// user's default browser, then poll /session/{id} until the server returns
/// a completed payment + api_key. On success, the key is saved to disk and
/// loaded into the in-memory client (same as the MetaMask flow).
#[tauri::command]
async fn signup_card(
    state: State<'_, AppState>,
    app: AppHandle,
    username: String,
) -> Result<Value, SignupError> {
    let _ = app;
    let username = username.trim().to_string();
    if username.is_empty() {
        return Err(SignupError::Cancelled("username is empty".into()));
    }

    let resp = state.client.create_user_card(&username).await?;

    let checkout_url = pick_str(&resp, &["checkout_url", "checkoutUrl", "url"]).ok_or_else(|| {
        SignupError::NoApiKey(format!("server response missing checkout_url: {}", resp))
    })?;
    let session_id = pick_str(&resp, &["session_id", "sessionId", "id"]).ok_or_else(|| {
        SignupError::NoApiKey(format!("server response missing session_id: {}", resp))
    })?;

    open::that(&checkout_url).map_err(|e| SignupError::Browser(e.to_string()))?;

    // Poll for up to 15 minutes. Stripe Checkout sessions expire after that
    // anyway, and most users complete within a minute.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15 * 60);
    loop {
        if std::time::Instant::now() > deadline {
            return Err(SignupError::Timeout);
        }
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        let session = match state.client.poll_session(&session_id).await {
            Ok(s) => s,
            Err(_) => continue, // transient network error; keep polling
        };
        let status = pick_str(&session, &["status", "state"]).unwrap_or_default();
        if status.eq_ignore_ascii_case("complete") || status.eq_ignore_ascii_case("succeeded") {
            let api_key = pick_str(&session, &["api_key", "apiKey"])
                .ok_or_else(|| SignupError::NoApiKey(session.to_string()))?;
            save_api_key_to_disk(&api_key).map_err(PreflightError::from)?;
            state.client.set_key(api_key.clone()).await;
            return Ok(session);
        }
    }
}

fn pick_str(v: &Value, keys: &[&str]) -> Option<String> {
    if let Some(obj) = v.as_object() {
        for k in keys {
            if let Some(s) = obj.get(*k).and_then(|x| x.as_str()) {
                if !s.is_empty() {
                    return Some(s.to_string());
                }
            }
        }
    }
    None
}

#[tauri::command]
async fn logout(state: State<'_, AppState>, app: AppHandle) -> Result<i32, PreflightError> {
    state.client.clear_key().await;
    remove_api_key_from_disk()?;
    clear_activity_log_file();
    // Ask the CLI to uninstall first; then do our own JSON pass over Claude's
    // settings to make sure the PreToolUse entry is gone (the CLI sometimes
    // leaves it behind, depending on which file it was written to).
    let code = run_icme_preflight(&app, "uninstall", "logout://line").await.unwrap_or(-1);
    strip_preflight_from_claude_settings();
    Ok(code)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let client = PreflightClient::from_env();
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(AppState { client })
        .setup(|app| {
            #[cfg(debug_assertions)]
            {
                let _ = app.get_webview_window("main");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            has_api_key,
            get_api_key,
            get_me,
            list_policies,
            get_policy_scenarios,
            get_policy_rules,
            submit_scenario_feedback,
            check_relevance,
            check_action,
            check_action_sse,
            make_rules_sse,
            refine_policy_sse,
            get_proof,
            read_activity,
            get_hook_status,
            set_hook_enabled,
            set_hook_policy,
            install_claude_preflight,
            uninstall_claude_preflight,
            signup,
            signup_card,
            logout,
            save_api_key,
            get_hook_env_api_key,
            get_hook_script,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
