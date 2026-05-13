import { useCallback, useState } from "react";
import { api } from "../tauri";

interface Props {
  policyId: string;
  onClose: () => void;
  onSaved: (newItem: unknown) => void;
}

export default function AddScenarioModal({ policyId, onClose, onSaved }: Props) {
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = useCallback(async () => {
    if (!content.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      await api.submitScenarioFeedback(policyId, content, true);
      onSaved({ guard_content: content, _custom: true });
      setContent("");
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }, [content, saving, policyId, onSaved]);

  return (
    <div className="modal-backdrop" onClick={saving ? undefined : onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Add scenario</h3>
          {!saving && <button className="link" onClick={onClose}>close</button>}
        </div>

        <p className="muted">
          Save a test case for this policy. We'll submit it as an approved scenario to{" "}
          <code>POST /v1/submitScenarioFeedback</code>.
        </p>

        <textarea
          autoFocus
          rows={4}
          placeholder="e.g. Send 5 USDC to 0xabc... on Base"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          disabled={saving}
        />
        <div className="row">
          <button
            className="primary"
            onClick={save}
            disabled={!content.trim() || saving}
          >
            {saving ? "Saving..." : "Save scenario"}
          </button>
        </div>
        {error && <div className="error inline">{error}</div>}
      </div>
    </div>
  );
}
