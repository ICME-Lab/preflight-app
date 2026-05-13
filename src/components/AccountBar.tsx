import { useCallback, useEffect, useState } from "react";
import { api } from "../tauri";
import type { MeResponse } from "../types";
import icmeLogo from "../assets/icme-logo.png";

interface Props {
  me: MeResponse | null;
  hasKey: boolean | null;
  loading: boolean;
  onRefresh: () => void;
  onOpenHookSettings: () => void;
  onLogout: () => void | Promise<void>;
}

// Top-up rate: $5 buys 500 credits, so $0.01 per credit.
const USD_PER_CREDIT = 5 / 500;

function formatUsd(credits: number): string {
  return `$${(credits * USD_PER_CREDIT).toFixed(2)}`;
}

function maskKey(k: string): string {
  if (k.length <= 12) return "•".repeat(k.length);
  return `${k.slice(0, 6)}${"•".repeat(8)}${k.slice(-4)}`;
}

export default function AccountBar({ me, hasKey, loading, onRefresh, onOpenHookSettings, onLogout }: Props) {
  const credits = typeof me?.credits === "number" ? me.credits : null;
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => {
    if (!hasKey) {
      setApiKey(null);
      return;
    }
    api.getApiKey().then(setApiKey).catch(() => setApiKey(null));
  }, [hasKey]);

  const copy = useCallback(async () => {
    if (!apiKey) return;
    await navigator.clipboard.writeText(apiKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }, [apiKey]);

  return (
    <header className="topbar">
      <div className="brand">
        <img src={icmeLogo} alt="ICME Labs" className="brand-logo" />
        <span className="brand-product">Preflight</span>
      </div>
      <div className="topbar-right">
        {hasKey && apiKey && (
          <div className="api-key">
            <span className="label">api key</span>
            <code className="value">{revealed ? apiKey : maskKey(apiKey)}</code>
            <button
              className="link"
              onClick={() => setRevealed((r) => !r)}
              title={revealed ? "Hide" : "Reveal"}
            >
              {revealed ? "hide" : "show"}
            </button>
            <button className="link" onClick={copy}>
              {copied ? "copied" : "copy"}
            </button>
          </div>
        )}
        {hasKey && (
          <div
            className="credits"
            title={
              credits != null
                ? `${me?.username ?? ""}\nValued at top-up rate ($5 / 500 credits = $0.01 each).`
                : (me?.username ?? "")
            }
          >
            <span className="label">credits</span>
            <span className="value">
              {credits ?? "-"}
              {credits != null && (
                <span className="usd"> ≈ {formatUsd(credits)}</span>
              )}
            </span>
          </div>
        )}
        <button className="blue" onClick={onOpenHookSettings} disabled={!hasKey}>Claude Code Hook</button>
        <button onClick={onRefresh} disabled={loading}>
          {loading ? "…" : "Refresh"}
        </button>
        {hasKey && !confirmLogout && (
          <button className="link danger" onClick={() => setConfirmLogout(true)}>
            Log out
          </button>
        )}
      </div>
      {confirmLogout && (
        <div className="logout-warning">
          <div className="warn-head">
            Logging out removes <code>ICME_API_KEY</code> from <code>~/.icme/env</code>.
            <b> The Preflight API does not let you recover this key.</b>
          </div>
          {apiKey && (
            <div className="warn-key">
              <span className="muted small">your key:</span>
              <code>{revealed ? apiKey : maskKey(apiKey)}</code>
              <button className="link" onClick={() => setRevealed((r) => !r)}>
                {revealed ? "hide" : "show"}
              </button>
              <button className="link" onClick={copy}>{copied ? "copied" : "copy"}</button>
            </div>
          )}
          <div className="muted small">
            This will also run <code>npx icme-claude-preflight uninstall</code> to remove the
            Claude Code hook entry from your settings.
          </div>
          <div className="warn-actions">
            <button onClick={() => setConfirmLogout(false)} disabled={loggingOut}>Cancel</button>
            <button
              className="danger"
              disabled={loggingOut}
              onClick={async () => {
                setLoggingOut(true);
                try {
                  await onLogout();
                } finally {
                  setLoggingOut(false);
                  setConfirmLogout(false);
                }
              }}
            >
              {loggingOut ? "Logging out..." : "I saved my key, log out"}
            </button>
          </div>
        </div>
      )}
    </header>
  );
}
