use axum::{
    body::Body,
    extract::{Query, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{oneshot, Mutex};

const SIGNER_HTML: &str = include_str!("../assets/signer.html");

/// EIP-712 config we hand to the browser page.
#[derive(Debug, Clone, Serialize)]
pub struct SignerConfig {
    pub chain_id: u64,
    pub chain_hex: String,        // e.g. "0x2105"
    pub token_name: String,
    pub token_version: String,
    pub token_address: String,
    pub amount: String,           // base units (decimal string)
    pub amount_display: String,   // human readable, e.g. "5.00 USDC"
    pub pay_to: String,
    pub valid_after: String,
    pub valid_before: String,
    pub nonce: String,
    pub session_id: String,
}

#[derive(Debug, Deserialize)]
pub struct SignResult {
    pub from: String,
    pub signature: String,
    pub session_id: String,
}

#[derive(Debug, Deserialize)]
pub struct SignFailure {
    pub reason: String,
    pub session_id: String,
}

pub enum SignerOutcome {
    Signed { from: String, signature: String },
    Failed(String),
}

struct ServerState {
    config: SignerConfig,
    tx: Mutex<Option<oneshot::Sender<SignerOutcome>>>,
}

/// Start the local signer server. Returns the bound port and a future that
/// resolves with the signing result.
pub async fn serve(
    config: SignerConfig,
) -> Result<(u16, oneshot::Receiver<SignerOutcome>), std::io::Error> {
    let (tx, rx) = oneshot::channel();
    let state = Arc::new(ServerState {
        config,
        tx: Mutex::new(Some(tx)),
    });

    let app = Router::new()
        .route("/sign", get(serve_signer_page))
        .route("/sign/config", get(serve_config))
        .route("/sign/result", post(receive_signature))
        .route("/sign/cancel", post(receive_cancel))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();

    tokio::spawn(async move {
        let _ = axum::serve(listener, app)
            .with_graceful_shutdown(async {
                tokio::time::sleep(Duration::from_secs(360)).await;
            })
            .await;
    });

    Ok((port, rx))
}

async fn serve_signer_page() -> impl IntoResponse {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .body(Body::from(SIGNER_HTML))
        .unwrap()
}

#[derive(Deserialize)]
struct ConfigQuery {
    #[allow(dead_code)]
    session_id: Option<String>,
}

async fn serve_config(
    State(state): State<Arc<ServerState>>,
    Query(_q): Query<ConfigQuery>,
) -> Json<SignerConfig> {
    Json(state.config.clone())
}

async fn receive_signature(
    State(state): State<Arc<ServerState>>,
    Json(payload): Json<SignResult>,
) -> Result<Json<Value>, StatusCode> {
    if payload.session_id != state.config.session_id {
        return Err(StatusCode::BAD_REQUEST);
    }
    let mut slot = state.tx.lock().await;
    if let Some(tx) = slot.take() {
        let _ = tx.send(SignerOutcome::Signed {
            from: payload.from,
            signature: payload.signature,
        });
        Ok(Json(serde_json::json!({"ok": true})))
    } else {
        Err(StatusCode::CONFLICT)
    }
}

async fn receive_cancel(
    State(state): State<Arc<ServerState>>,
    Json(payload): Json<SignFailure>,
) -> Result<Json<Value>, StatusCode> {
    if payload.session_id != state.config.session_id {
        return Err(StatusCode::BAD_REQUEST);
    }
    let mut slot = state.tx.lock().await;
    if let Some(tx) = slot.take() {
        let _ = tx.send(SignerOutcome::Failed(payload.reason));
    }
    Ok(Json(serde_json::json!({"ok": true})))
}

pub fn random_nonce_hex() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    format!("0x{}", hex::encode(bytes))
}

pub fn random_session_id() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}
