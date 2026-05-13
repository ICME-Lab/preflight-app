import { useCallback, useEffect, useRef, useState } from "react";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { api } from "../tauri";
import type { PolicySummary } from "../types";

const DOCS_URL = "https://docs.icme.io/documentation/getting-started/cryptographic-guardrails-for-claude-code";

interface Props {
  onClose: () => void;
  policies: PolicySummary[];
  policyNames: Record<string, string>;
}

interface HookStatus {
  installed: boolean;
  script_path: string | null;
  env_path: string | null;
  enabled: boolean;
  policy_id: string | null;
}

interface LogLine {
  stream: "stdout" | "stderr" | "info";
  line: string;
}

function labelFor(p: PolicySummary, nickname?: string): string {
  if (nickname) return nickname;
  const raw = p.policy_text ?? p.text;
  if (typeof raw === "string" && raw.length > 0) {
    return raw.length > 60 ? raw.slice(0, 57) + "..." : raw;
  }
  return `Policy ${p.id.slice(0, 8)}`;
}

export default function HookSettings({ onClose, policies, policyNames }: Props) {
  const [status, setStatus] = useState<HookStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [log, setLog] = useState<LogLine[]>([]);
  const [script, setScript] = useState<string | null>(null);
  const [scriptLoaded, setScriptLoaded] = useState(false);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const logEndRef = useRef<HTMLDivElement | null>(null);

  const loadScript = useCallback(async () => {
    try {
      const s = await api.getHookScript();
      setScript(s);
    } catch {
      setScript(null);
    } finally {
      setScriptLoaded(true);
    }
  }, []);

  const refresh = useCallback(async () => {
    setErr(null);
    try {
      setStatus(await api.getHookStatus());
    } catch (e) {
      setErr(String(e));
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { loadScript(); }, [loadScript]);

  useEffect(() => {
    let cancelled = false;
    listen<LogLine>("install://line", (e) => {
      if (cancelled) return;
      setLog((prev) => [...prev, e.payload].slice(-500));
    }).then((un) => {
      if (cancelled) un();
      else unlistenRef.current = un;
    });
    return () => {
      cancelled = true;
      unlistenRef.current?.();
    };
  }, []);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [log.length]);

  const toggleEnabled = useCallback(async (next: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      await api.setHookEnabled(next);
      await refresh();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const pickPolicy = useCallback(async (id: string) => {
    setBusy(true);
    setErr(null);
    try {
      await api.setHookPolicy(id);
      await refresh();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const runInstall = useCallback(async () => {
    setLog([]);
    setInstalling(true);
    setErr(null);
    try {
      const code = await api.installClaudePreflight();
      setLog((prev) => [...prev, { stream: "info", line: `Exit: ${code}` }]);
      await refresh();
    } catch (e) {
      setErr(String(e));
    } finally {
      setInstalling(false);
    }
  }, [refresh]);

  const runUninstall = useCallback(async () => {
    setLog([]);
    setInstalling(true);
    setErr(null);
    try {
      const code = await api.uninstallClaudePreflight();
      setLog((prev) => [...prev, { stream: "info", line: `Exit: ${code}` }]);
      await refresh();
      await loadScript();
    } catch (e) {
      setErr(String(e));
    } finally {
      setInstalling(false);
    }
  }, [refresh, loadScript]);

  return (
    <div className="modal-backdrop" onClick={installing ? undefined : onClose}>
      <div className="modal hook-settings" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Claude Code Hook</h3>
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <button
              className="link"
              onClick={() => { openExternal(DOCS_URL).catch(() => {}); }}
              title={DOCS_URL}
            >
              docs ↗
            </button>
            {!installing && <button className="link" onClick={onClose}>close</button>}
          </div>
        </div>

        {err && <div className="error inline">{err}</div>}

        {status === null ? (
          <div className="muted">Loading...</div>
        ) : (
          <>
            <div className="card">
              <div className="card-title">Installation</div>
              <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <div>
                    <b>{status.installed ? "Installed" : "Not installed"}</b>
                  </div>
                  {status.script_path && (
                    <code className="muted small">{status.script_path}</code>
                  )}
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={runInstall} disabled={installing}>
                    {installing ? "Running..." : status.installed ? "Reinstall" : "Install"}
                  </button>
                  {status.installed && (
                    <button className="danger" onClick={runUninstall} disabled={installing}>
                      Uninstall
                    </button>
                  )}
                </div>
              </div>
            </div>

            <div className="card">
              <div className="card-title">Status</div>
              <div className="hook-status-row">
                {status.enabled ? (
                  <>
                    <span className="hook-state enabled">✓ ENABLED</span>
                    <button
                      className="danger"
                      onClick={() => toggleEnabled(false)}
                      disabled={busy || !status.installed}
                    >
                      Disable
                    </button>
                  </>
                ) : (
                  <>
                    <span className="hook-state disabled">DISABLED</span>
                    <button
                      className="blue"
                      onClick={() => toggleEnabled(true)}
                      disabled={busy || !status.installed}
                    >
                      Enable
                    </button>
                  </>
                )}
              </div>
              <div className="muted small" style={{ marginTop: 8 }}>
                When disabled, the hook script exits immediately and allows every tool call.
                Writes <code>ICME_HOOK_ENABLED</code> to <code>~/.icme/env</code>.
              </div>
            </div>

            <div className="card">
              <div className="card-title">Active policy</div>
              <select
                value={status.policy_id ?? ""}
                onChange={(e) => pickPolicy(e.target.value)}
                disabled={busy || !status.installed || policies.length === 0}
              >
                <option value="" disabled>
                  {policies.length === 0 ? "No policies yet" : "Select a policy..."}
                </option>
                {policies.map((p) => (
                  <option key={p.id} value={p.id}>
                    {labelFor(p, policyNames[p.id])} ({p.id.slice(0, 8)})
                  </option>
                ))}
              </select>
              {status.policy_id && (
                <div className="muted small" style={{ marginTop: 4 }}>
                  Current: <code>{status.policy_id}</code>
                </div>
              )}
            </div>

            {log.length > 0 && (
              <div className="card">
                <div className="card-title">Install log</div>
                <div className="install-log">
                  {log.map((l, i) => {
                    const isError = l.stream === "stderr" && /^(npm error|error:|Error:)/i.test(l.line);
                    const cls = l.stream === "info" ? "info" : isError ? "error" : "";
                    return (
                      <div key={i} className={`log-line ${cls}`}>{l.line}</div>
                    );
                  })}
                  <div ref={logEndRef} />
                </div>
              </div>
            )}

            <div className="card">
              <div className="card-title">
                Hook script
                <button className="link" style={{ marginLeft: 8 }} onClick={loadScript}>
                  reload
                </button>
              </div>
              {!scriptLoaded ? (
                <div className="muted">Loading...</div>
              ) : script === null ? (
                <div className="muted small">
                  No <code>~/.icme/preflight-hook.sh</code> found. Install above to create it.
                </div>
              ) : (
                <details className="rule-smt">
                  <summary>
                    <span>{status.script_path ?? "preflight-hook.sh"} ({script.split("\n").length} lines)</span>
                    <span className="toggle-label" />
                  </summary>
                  <pre className="hook-script"><code>{script}</code></pre>
                </details>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
