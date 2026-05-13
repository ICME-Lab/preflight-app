import { useCallback, useEffect, useState } from "react";
import { api } from "../tauri";

interface Props {
  onClose: () => void;
  onComplete: () => void;
}

export default function LoginModal({ onClose, onComplete }: Props) {
  const [key, setKey] = useState("");
  const [hookKey, setHookKey] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getHookEnvApiKey().then(setHookKey).catch(() => setHookKey(null));
  }, []);

  const submit = useCallback(async (value: string) => {
    const v = value.trim();
    if (!v) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.saveApiKey(v);
      onComplete();
    } catch (e) {
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  }, [onComplete]);

  return (
    <div className="modal-backdrop" onClick={submitting ? undefined : onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Log in with existing API key</h3>
          {!submitting && <button className="link" onClick={onClose}>close</button>}
        </div>

        <p className="muted">
          Paste a key that starts with <code>sk-smt-</code>. We'll save it to{" "}
          <code>~/.icme/env</code> and use it for all subsequent requests.
        </p>

        {hookKey && (
          <div className="card" style={{ borderColor: "var(--accent)" }}>
            <div className="card-title">Existing key found in <code>~/.icme/env</code></div>
            <div className="muted small">
              Looks like a CLI install left credentials in the canonical file. Use it?
            </div>
            <div className="row" style={{ marginTop: 6 }}>
              <button
                className="primary"
                onClick={() => submit(hookKey)}
                disabled={submitting}
              >
                {submitting ? "Importing..." : "Use this key"}
              </button>
            </div>
          </div>
        )}

        <div className="card-title" style={{ marginTop: 8 }}>Or paste a key</div>
        <input
          type="password"
          autoFocus
          placeholder="sk-smt-..."
          value={key}
          onChange={(e) => setKey(e.target.value)}
          disabled={submitting}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
        />
        <div className="row">
          <button
            className="primary"
            onClick={() => submit(key)}
            disabled={!key.trim() || submitting}
          >
            {submitting ? "Saving..." : "Log in"}
          </button>
        </div>
        {error && <div className="error inline">{error}</div>}
      </div>
    </div>
  );
}
