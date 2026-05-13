import type { PolicySummary } from "../types";

interface Props {
  policies: PolicySummary[];
  policyNames: Record<string, string>;
  hiddenSet: Set<string>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  showHidden: boolean;
  hiddenCount: number;
  onToggleHidden: () => void;
}

function labelFor(p: PolicySummary, nickname?: string): { label: string; isNickname: boolean } {
  if (nickname && nickname.length > 0) return { label: nickname, isNickname: true };
  const raw = p.policy_text ?? p.text;
  const t = (typeof raw === "string" && raw.length > 0)
    ? raw
    : `Policy ${p.id.slice(0, 8)}`;
  return { label: t.length > 80 ? t.slice(0, 77) + "..." : t, isNickname: false };
}

export default function PoliciesList({
  policies, policyNames, hiddenSet, selectedId, onSelect, onNew,
  showHidden, hiddenCount, onToggleHidden,
}: Props) {
  return (
    <div className="policies">
      <div className="policies-header">
        <span>Policies ({policies.length})</span>
        <span style={{ display: "flex", gap: 8 }}>
          {hiddenCount > 0 && (
            <button className="link" onClick={onToggleHidden}>
              {showHidden ? "hide hidden" : `show hidden (${hiddenCount})`}
            </button>
          )}
          <button className="link" onClick={onNew}>+ new</button>
        </span>
      </div>
      {policies.length === 0 && (
        <div className="empty small">No policies yet.</div>
      )}
      <ul>
        {policies.map((p) => {
          const { label, isNickname } = labelFor(p, policyNames[p.id]);
          const isHidden = hiddenSet.has(p.id);
          const classes = [
            p.id === selectedId ? "selected" : "",
            isHidden ? "hidden-policy" : "",
          ].filter(Boolean).join(" ");
          return (
            <li
              key={p.id}
              className={classes}
              onClick={() => onSelect(p.id)}
            >
              <div className={`policy-text ${isNickname ? "nickname" : ""}`}>
                {isHidden && <span className="hidden-tag">hidden</span>}
                {label}
              </div>
              <div className="policy-meta">
                {p.rule_count != null && <span>{p.rule_count} rules</span>}
                {p.id && <span className="id">{p.id.slice(0, 8)}</span>}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
