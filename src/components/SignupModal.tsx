import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";

interface Props {
  onClose: () => void;
  onComplete: () => void;
}

interface SignupResult {
  api_key?: string;
  credits?: number;
  message?: string;
  user_id?: string;
  username?: string;
  [k: string]: unknown;
}

type Phase = "form" | "running" | "done" | "error";

interface ParsedError {
  kind: "insufficient_funds" | "rejected" | "timeout" | "other";
  message: string;
  serverReason?: string;
}

const USERNAME_RE = /^[a-z0-9]([a-z0-9-]{1,30}[a-z0-9])?$/;
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

function parseError(raw: string): ParsedError {
  // The Rust SignupError serializes via Display, often like:
  //   "api error 402: {"accepts":..., "error":"Verification failed: insufficient_funds", ...}"
  let serverReason: string | undefined;
  const jsonStart = raw.indexOf("{");
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(raw.slice(jsonStart));
      if (parsed && typeof parsed === "object" && typeof parsed.error === "string") {
        serverReason = parsed.error;
      }
    } catch {
      // ignore
    }
  }

  if (/insufficient_funds/i.test(raw)) {
    return { kind: "insufficient_funds", message: raw, serverReason };
  }
  if (/User rejected|User denied|action_rejected/i.test(raw)) {
    return { kind: "rejected", message: raw, serverReason };
  }
  if (/timed out|timeout/i.test(raw)) {
    return { kind: "timeout", message: raw, serverReason };
  }
  return { kind: "other", message: raw, serverReason };
}

export default function SignupModal({ onClose, onComplete }: Props) {
  const [phase, setPhase] = useState<Phase>("form");
  const [username, setUsername] = useState("");
  const [error, setError] = useState<ParsedError | null>(null);
  const [result, setResult] = useState<SignupResult | null>(null);
  const [signerAddress, setSignerAddress] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const unlistenRef = useRef<UnlistenFn | null>(null);

  useEffect(() => {
    let cancelled = false;
    listen<string>("signup://signed-by", (e) => {
      if (!cancelled) setSignerAddress(e.payload);
    }).then((un) => {
      if (cancelled) un();
      else unlistenRef.current = un;
    });
    return () => {
      cancelled = true;
      unlistenRef.current?.();
    };
  }, []);

  const isValid = USERNAME_RE.test(username);

  const submit = useCallback(async () => {
    if (!isValid) return;
    setError(null);
    setResult(null);
    setPhase("running");
    try {
      const res = await invoke<SignupResult>("signup", { username });
      setResult(res);
      setPhase("done");
    } catch (e) {
      setError(parseError(String(e)));
      setPhase("error");
    }
  }, [isValid, username]);

  const copyAddr = useCallback(async () => {
    if (!signerAddress) return;
    await navigator.clipboard.writeText(signerAddress);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [signerAddress]);

  return (
    <div className="modal-backdrop" onClick={phase === "running" ? undefined : onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Create Preflight account</h3>
          {phase !== "running" && (
            <button className="link" onClick={onClose}>close</button>
          )}
        </div>

        {phase === "form" && (
          <>
            <p>
              Sign up with $5.00 USDC on Base. You'll get an API key and 325 starter credits.
              MetaMask will pop up in your browser to sign an EIP-3009 authorization; no on-chain
              transaction yet, just a signature.
            </p>
            <div className="card-title" style={{ marginTop: 8 }}>Username</div>
            <input
              autoFocus
              value={username}
              onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
              placeholder="my-agent"
            />
            <div className="muted small" style={{ marginTop: 4 }}>
              Lowercase letters, digits, dashes. 3-32 characters. Cannot be changed later.
            </div>
            <div className="row">
              <button className="primary" onClick={submit} disabled={!isValid}>
                Continue with MetaMask
              </button>
            </div>
          </>
        )}

        {phase === "running" && (
          <>
            <p>
              Your browser should have opened a new tab. Connect MetaMask, switch to Base if
              prompted, and approve the signature for <b>$5.00 USDC</b>.
            </p>
            <div className="card progress">
              <div className="card-title">Waiting for signature...</div>
              <p className="muted small">
                If the tab didn't open, check that your default browser has MetaMask installed.
                You can also paste this URL into MetaMask's built-in browser on mobile.
              </p>
              {signerAddress && (
                <div className="muted small" style={{ marginTop: 8 }}>
                  Signed by <code>{signerAddress}</code>. Submitting to the server...
                </div>
              )}
            </div>
          </>
        )}

        {phase === "done" && result && (
          <>
            <p>
              <b>Account created.</b> API key saved to <code>~/.icme/env</code>.
            </p>
            <div className="card">
              <div className="row" style={{ justifyContent: "space-between" }}>
                <span className="muted">Username</span>
                <code>{result.username ?? username}</code>
              </div>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <span className="muted">Credits</span>
                <code>{result.credits ?? "-"}</code>
              </div>
              {result.user_id && (
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <span className="muted">User ID</span>
                  <code style={{ fontSize: 11 }}>{result.user_id}</code>
                </div>
              )}
              {signerAddress && (
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <span className="muted">Signer</span>
                  <code style={{ fontSize: 11 }}>{signerAddress}</code>
                </div>
              )}
            </div>
            <div className="row">
              <button className="primary" onClick={onComplete}>Continue</button>
            </div>
          </>
        )}

        {phase === "error" && error && (
          <>
            {error.kind === "insufficient_funds" ? (
              <>
                <p>
                  <b>That wallet doesn't have enough USDC on Base.</b> The signature was valid,
                  but the server saw a balance under $5.00 when it tried to verify the EIP-3009
                  authorization.
                </p>
                {signerAddress && (
                  <div className="card">
                    <div className="card-title">Fund this address</div>
                    <div className="addr-row">
                      <code className="addr">{signerAddress}</code>
                      <button onClick={copyAddr}>{copied ? "Copied" : "Copy"}</button>
                    </div>
                    <div className="muted small" style={{ marginTop: 8 }}>
                      Send at least <b>5 USDC on Base</b> (chain 8453).
                      USDC contract: <code style={{ fontSize: 11 }}>{USDC_BASE}</code>.
                      No ETH needed for gas, the server settles.
                    </div>
                  </div>
                )}
                <p className="muted small" style={{ marginTop: 8 }}>
                  Easy ways to get USDC on Base: Coinbase exchange (direct Base withdrawal),
                  bridge via Across / Bungee / Stargate, or on-ramp via Coinbase Pay / MoonPay.
                </p>
              </>
            ) : error.kind === "rejected" ? (
              <p>You rejected the signature in MetaMask. No problem, try again when ready.</p>
            ) : error.kind === "timeout" ? (
              <p>Signing timed out. The session expired after 10 minutes. Start over to get a fresh signing window.</p>
            ) : (
              <>
                <div className="error inline">{error.serverReason ?? error.message}</div>
                {error.serverReason && (
                  <details style={{ marginTop: 8 }}>
                    <summary className="muted small">Full server response</summary>
                    <pre style={{ fontSize: 11, overflow: "auto", maxHeight: 200 }}>
                      {error.message}
                    </pre>
                  </details>
                )}
              </>
            )}

            <div className="row">
              <button onClick={() => setPhase("form")}>Back</button>
              <button className="primary" onClick={submit} disabled={!isValid}>Retry</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
