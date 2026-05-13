import { useEffect, useRef, useState } from "react";
import { api, listenSse, newStreamId } from "../tauri";
import type { SseEvent } from "../types";
import { extractPolicyId, usePolicyRulesCache } from "../hooks/usePolicyRulesCache";

interface Props {
  onClose: () => void;
  onCreated: () => void;
}

interface ProgressLine {
  kind: string;
  text: string;
}

const AUTO_CLOSE_MS = 1200;

export default function CreatePolicyModal({ onClose, onCreated }: Props) {
  const [rules, setRules] = useState<string[]>([""]);
  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState<ProgressLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const { save: cacheRules } = usePolicyRulesCache();
  const unlistenRef = useRef<(() => void) | null>(null);
  const closeTimer = useRef<number | null>(null);

  const updateRule = (i: number, value: string) => {
    setRules((prev) => prev.map((r, idx) => (idx === i ? value : r)));
  };
  const addRule = () => setRules((prev) => [...prev, ""]);
  const removeRule = (i: number) => {
    setRules((prev) => (prev.length === 1 ? prev : prev.filter((_, idx) => idx !== i)));
  };

  const composedText = rules
    .map((r) => r.trim())
    .filter((r) => r.length > 0)
    .map((r, i) => {
      const stripped = r.replace(/^\s*\d+[.):\-]\s*/, "");
      return `${i + 1}. ${stripped}`;
    })
    .join("\n");
  const hasAnyRule = composedText.length > 0;

  useEffect(() => {
    return () => {
      unlistenRef.current?.();
      if (closeTimer.current != null) window.clearTimeout(closeTimer.current);
    };
  }, []);

  // When the SSE stream signals done, briefly show success then auto-close + refresh.
  useEffect(() => {
    if (!done) return;
    closeTimer.current = window.setTimeout(() => {
      onCreated();
    }, AUTO_CLOSE_MS);
    return () => {
      if (closeTimer.current != null) window.clearTimeout(closeTimer.current);
    };
  }, [done, onCreated]);

  const submit = async () => {
    if (!hasAnyRule || submitting) return;
    setSubmitting(true);
    setProgress([]);
    setError(null);
    setDone(false);

    const streamId = newStreamId();
    const handle = (ev: SseEvent) => {
      const data = ev.data;
      const summary =
        typeof data === "string"
          ? data
          : data && typeof data === "object"
          ? (() => {
              const o = data as Record<string, unknown>;
              return (o.message as string) || (o.step as string) || JSON.stringify(o);
            })()
          : String(data);
      setProgress((p) => [...p, { kind: ev.event, text: summary }]);
      const k = ev.event.toLowerCase();
      if (k === "done") {
        console.log("[makeRules done payload]", data);
        const pid = extractPolicyId(data);
        if (pid) cacheRules(pid, data);
        setDone(true);
      }
      if (k === "error") setError(summary);
    };

    try {
      unlistenRef.current = await listenSse("preflight://make-rules", streamId, handle);
      await api.makeRulesSse(streamId, composedText);
    } catch (e) {
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={done ? undefined : onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>New policy</h3>
          {!done && <button className="link" onClick={onClose}>close</button>}
        </div>

        <p className="muted">
          Plain English. Preflight will compile it to formal logic. Costs 300 credits (≈ $3.00).
        </p>

        <div className="card" style={{ marginBottom: 8 }}>
          <div className="card-title">How to write a policy</div>
          <ul className="policy-tips">
            <li>One rule per box. We'll number them when we submit.</li>
            <li>Each rule has <b>exactly one condition</b> and <b>exactly one outcome</b>.</li>
            <li>Use "if ..., then ... is permitted/not permitted" phrasing.</li>
          </ul>
          <details>
            <summary className="muted small">example</summary>
            <pre className="policy-example">{`1. If the transfer amount exceeds 1000 USDC, then the transfer is not permitted.
2. If the recipient address is not in the approved registry, then the transfer is not permitted.
3. If more than 3 transfers have occurred within the last 60 seconds, then the transfer is not permitted.`}</pre>
          </details>
        </div>

        <div className="rules-input">
          {rules.map((r, i) => (
            <div key={i} className="rule-input">
              <span className="rule-num">{i + 1}.</span>
              <textarea
                placeholder={`If ..., then ... is not permitted.`}
                rows={2}
                value={r}
                onChange={(e) => updateRule(i, e.target.value)}
                disabled={submitting || done}
              />
              {rules.length > 1 && !done && (
                <button
                  className="link rule-remove"
                  onClick={() => removeRule(i)}
                  disabled={submitting}
                  title="Remove this rule"
                >
                  ×
                </button>
              )}
            </div>
          ))}
          {!done && (
            <button
              className="link add-rule"
              onClick={addRule}
              disabled={submitting}
            >
              + add rule
            </button>
          )}
        </div>

        <div className="row">
          <button className="primary" onClick={submit} disabled={!hasAnyRule || submitting || done}>
            {done ? "Done" : submitting ? "Compiling..." : "Compile policy"}
          </button>
        </div>

        {error && <div className="error inline">{error}</div>}

        {done && (
          <div className="status success" style={{ marginTop: 10 }}>
            Policy compiled. Refreshing your policies...
          </div>
        )}

        {progress.length > 0 && (
          <div className="card progress">
            <div className="card-title">Compilation</div>
            <ul>
              {progress.map((p, i) => (
                <li key={i}>
                  <span className={`tag ${p.kind.toLowerCase()}`}>{p.kind}</span>
                  <span className="msg">{p.text}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
