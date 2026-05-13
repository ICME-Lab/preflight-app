import { useCallback, useEffect, useRef, useState } from "react";
import { api, listenSse, newStreamId } from "../tauri";
import type { CheckResult, LogEntry, PolicySummary, SseEvent } from "../types";
import { usePolicyRulesCache } from "../hooks/usePolicyRulesCache";
import { formatSmt, highlightSmt } from "../utils/smt";
import AddScenarioModal from "./AddScenarioModal";

interface Props {
  policy: PolicySummary;
  nickname?: string;
  isHidden: boolean;
  onNicknameChange: (next: string) => void;
  onCheck: (entry: LogEntry) => void;
  onCheckUpdate: (id: string, patch: Partial<LogEntry>) => void;
  onPolicyDetail?: (id: string, patch: Partial<PolicySummary>) => void;
  onHide: (id: string) => void;
  onUnhide: (id: string) => void;
}

const PARSED_KEYS = ["rules_parsed", "rulesParsed", "parsed_rules", "parsedRules"];
const SMT_KEYS = ["smt", "smtlib", "smt_lib", "smtLib", "compiled", "smt_content"];

function deepFind<T>(detail: unknown, keys: string[], pred: (v: unknown) => v is T): T | null {
  if (!detail || typeof detail !== "object") return null;
  const stack: unknown[] = [detail];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object") continue;
    if (Array.isArray(cur)) {
      for (const v of cur) stack.push(v);
      continue;
    }
    const obj = cur as Record<string, unknown>;
    for (const k of keys) {
      if (k in obj && pred(obj[k])) return obj[k] as T;
    }
    for (const v of Object.values(obj)) stack.push(v);
  }
  return null;
}

function ruleAsText(r: unknown): string {
  let raw: string;
  if (typeof r === "string") {
    raw = r;
  } else if (r && typeof r === "object") {
    const o = r as Record<string, unknown>;
    raw = "";
    for (const k of ["text", "description", "natural_language", "naturalLanguage", "english", "rule", "content"]) {
      const v = o[k];
      if (typeof v === "string" && v.length > 0) { raw = v; break; }
    }
    if (!raw) raw = JSON.stringify(r);
  } else {
    raw = String(r);
  }
  // Strip API-provided "Rule N:" / "Rule N -" prefixes; we render our own numbering.
  return raw.replace(/^\s*rule\s*\d+\s*[:.\-)]?\s*/i, "").trim();
}

function extractParsedRules(detail: unknown): unknown[] | null {
  return deepFind<unknown[]>(detail, PARSED_KEYS, (v): v is unknown[] => Array.isArray(v) && v.length > 0);
}

function extractSmt(detail: unknown): string | null {
  return deepFind<string>(detail, SMT_KEYS, (v): v is string => typeof v === "string" && v.length > 0);
}

export default function PolicyDetail({ policy, nickname, isHidden, onNicknameChange, onCheck, onCheckUpdate, onPolicyDetail, onHide, onUnhide }: Props) {
  const [nameDraft, setNameDraft] = useState<string>(nickname ?? "");
  const [editingName, setEditingName] = useState(false);
  const [confirmHide, setConfirmHide] = useState(false);
  const [scenarioFeedback, setScenarioFeedback] = useState<Record<string, "approved" | "rejected" | "saving">>({});
  const [scenarioErr, setScenarioErr] = useState<string | null>(null);
  const [action, setAction] = useState("");
  const [checking, setChecking] = useState(false);
  const [lastResult, setLastResult] = useState<CheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAddScenario, setShowAddScenario] = useState(false);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [annotation, setAnnotation] = useState("");
  const [refining, setRefining] = useState(false);
  const [refineProgress, setRefineProgress] = useState<{ kind: string; text: string }[]>([]);
  const [refineDone, setRefineDone] = useState(false);
  const refineUnlistenRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    setNameDraft(nickname ?? "");
    setEditingName(false);
  }, [policy.id, nickname]);

  const commitName = () => {
    onNicknameChange(nameDraft);
    setEditingName(false);
  };

  const doHide = useCallback(() => {
    onHide(policy.id);
    setConfirmHide(false);
  }, [policy.id, onHide]);

  function scenarioKey(s: unknown, i: number): string {
    if (s && typeof s === "object") {
      const o = s as Record<string, unknown>;
      const k = o.id ?? o.scenario_id ?? o.scenarioId ?? o.guard_content ?? o.guardContent;
      if (typeof k === "string" && k.length > 0) return k;
    }
    return `idx-${i}`;
  }

  function scenarioContent(s: unknown): string {
    if (typeof s === "string") return s;
    if (s && typeof s === "object") {
      const o = s as Record<string, unknown>;
      for (const k of ["guard_content", "guardContent", "scenario", "content", "action", "text"]) {
        const v = o[k];
        if (typeof v === "string" && v.length > 0) return v;
      }
      return JSON.stringify(s);
    }
    return String(s);
  }

  const submitFeedback = useCallback(async (s: unknown, key: string, approved: boolean, annotationText?: string) => {
    setScenarioErr(null);
    setScenarioFeedback((prev) => ({ ...prev, [key]: "saving" }));
    try {
      const content = scenarioContent(s);
      await api.submitScenarioFeedback(policy.id, content, approved, annotationText);
      setScenarioFeedback((prev) => ({ ...prev, [key]: approved ? "approved" : "rejected" }));
      setRejecting(null);
      setAnnotation("");
    } catch (e) {
      setScenarioErr(String(e));
      setScenarioFeedback((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    }
  }, [policy.id]);

  const startRefine = useCallback(async () => {
    if (refining) return;
    setRefining(true);
    setRefineProgress([]);
    setRefineDone(false);
    setScenarioErr(null);
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
      setRefineProgress((p) => [...p, { kind: ev.event, text: summary }]);
      const k = ev.event.toLowerCase();
      if (k === "done") setRefineDone(true);
      if (k === "error") setScenarioErr(summary);
    };
    try {
      refineUnlistenRef.current = await listenSse("preflight://refine-policy", streamId, handle);
      await api.refinePolicySse(streamId, policy.id);
    } catch (e) {
      setScenarioErr(String(e));
    } finally {
      setRefining(false);
    }
  }, [refining, policy.id]);

  useEffect(() => {
    return () => { refineUnlistenRef.current?.(); };
  }, []);

  const handleScenarioSaved = useCallback((newItem: unknown) => {
    setScenarios((prev) => prev ? [newItem, ...prev] : [newItem]);
    setShowAddScenario(false);
  }, []);

  const runCheck = useCallback(async () => {
    if (!action.trim() || checking) return;
    setError(null);
    setLastResult(null);
    setChecking(true);
    const id = `c_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const label = (policy.policy_text ?? policy.text ?? policy.id).slice(0, 60);
    onCheck({
      id,
      ts: Date.now(),
      policy_id: policy.id,
      policy_label: label,
      action,
      result: "PENDING",
    });
    try {
      const res = await api.check(policy.id, action);
      setLastResult(res);
      onCheckUpdate(id, {
        result: (res.result as LogEntry["result"]) ?? (res.blocked ? "UNSAT" : "SAT"),
        blocked: res.blocked,
        reason: res.reason,
        proof_id: res.proof_id,
        raw: res,
      });
    } catch (e) {
      const msg = String(e);
      setError(msg);
      onCheckUpdate(id, { result: "ERROR", reason: msg });
    } finally {
      setChecking(false);
    }
  }, [policy, action, checking, onCheck, onCheckUpdate]);
  const [scenarios, setScenarios] = useState<unknown[] | null>(null);
  const [scenariosErr, setScenariosErr] = useState<string | null>(null);
  const [rulesResp, setRulesResp] = useState<unknown | null>(null);
  const [rulesErr, setRulesErr] = useState<string | null>(null);
  const [rulesLoading, setRulesLoading] = useState(true);
  const { cache: rulesCache } = usePolicyRulesCache();

  useEffect(() => {
    setScenarios(null);
    setScenariosErr(null);
    setRulesResp(null);
    setRulesErr(null);
    setRulesLoading(true);
    let cancelled = false;

    api
      .scenarios(policy.id)
      .then((s) => {
        if (cancelled) return;
        if (Array.isArray(s)) setScenarios(s);
        else if (s && typeof s === "object" && "scenarios" in (s as object))
          setScenarios((s as { scenarios: unknown[] }).scenarios);
        else setScenarios([]);
      })
      .catch((e) => !cancelled && setScenariosErr(String(e)));

    api
      .policyRules(policy.id)
      .then((r) => {
        if (cancelled) return;
        console.log(`[policy/${policy.id}] response`, r);
        setRulesResp(r);
      })
      .catch((e) => !cancelled && setRulesErr(String(e)))
      .finally(() => !cancelled && setRulesLoading(false));

    return () => {
      cancelled = true;
    };
  }, [policy.id]);

  // Heads-up the parent if the list summary already carries policy_text, so the sidebar updates.
  useEffect(() => {
    if (!onPolicyDetail) return;
    if (policy.policy_text || policy.text) return;
    // nothing else to backfill from current detail wiring
  }, [policy, onPolicyDetail]);

  const cachedRaw = rulesCache[policy.id]?.raw;
  const parsedRules = extractParsedRules(rulesResp) ?? extractParsedRules(cachedRaw);
  const smt = extractSmt(rulesResp) ?? extractSmt(cachedRaw);
  const fromCache = !extractParsedRules(rulesResp) && !!extractParsedRules(cachedRaw);
  const rulesNotFound = !!rulesErr && /api error 404/i.test(rulesErr);
  const smtFormatted = smt ? formatSmt(smt) : null;
  const smtTokens = smtFormatted ? highlightSmt(smtFormatted) : null;

  const text = policy.policy_text ?? policy.text ?? `Policy ${policy.id.slice(0, 8)}`;
  const displayName = nickname ?? "";

  return (
    <div className="policy-detail">
      <div className="policy-head">
        {editingName ? (
          <input
            className="name-input"
            autoFocus
            value={nameDraft}
            placeholder="Nickname (local only)"
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitName();
              if (e.key === "Escape") {
                setNameDraft(nickname ?? "");
                setEditingName(false);
              }
            }}
          />
        ) : (
          <h2
            className="policy-name"
            title={displayName ? "Click to rename" : "Click to add a nickname"}
            onClick={() => setEditingName(true)}
          >
            {displayName || <span className="muted">Add a nickname</span>}
            <button className="link" onClick={(e) => { e.stopPropagation(); setEditingName(true); }} style={{ marginLeft: 8, fontSize: 12 }}>
              edit
            </button>
          </h2>
        )}
        <div className="policy-text-line">{text}</div>
        <div className="policy-sub">
          <span>id: <code>{policy.id}</code></span>
          {policy.rule_count != null && <span>{policy.rule_count} rules</span>}
          {policy.created_at && <span>{new Date(policy.created_at).toLocaleString()}</span>}
          <span className="policy-actions">
            {isHidden ? (
              <button className="link" onClick={() => onUnhide(policy.id)} title="Bring this policy back to the visible list">
                Unhide policy
              </button>
            ) : !confirmHide ? (
              <button className="link danger" onClick={() => setConfirmHide(true)} title="Hide locally; the policy stays on the server">
                Hide policy
              </button>
            ) : (
              <>
                <span className="muted">Hide locally?</span>
                <button className="danger" onClick={doHide}>Yes, hide</button>
                <button onClick={() => setConfirmHide(false)}>Cancel</button>
              </>
            )}
          </span>
        </div>
        {isHidden && (
          <div className="muted small" style={{ marginTop: 4 }}>
            This policy is hidden locally. It still exists on Preflight; the API doesn't support deletion.
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-title">Test an action</div>
        <textarea
          placeholder="e.g. Send 5 USDC to 0xabc... on Base"
          value={action}
          rows={3}
          onChange={(e) => setAction(e.target.value)}
          disabled={checking}
        />
        <div className="row">
          <button onClick={runCheck} disabled={!action.trim() || checking} className="primary">
            {checking ? "Checking..." : "Check"}
          </button>
          <button onClick={() => setAction("")} disabled={checking || !action}>Clear</button>
        </div>
        {error && <div className="error inline">{error}</div>}
        {lastResult && (
          <div className={`result ${lastResult.blocked ? "blocked" : "allowed"}`}>
            <div className="result-head">
              <span className="verdict">{lastResult.result ?? (lastResult.blocked ? "UNSAT" : "SAT")}</span>
              <span className="badge">{lastResult.blocked ? "BLOCKED" : "ALLOWED"}</span>
              {lastResult.proof_id && (
                <span className="proof">proof: <code>{String(lastResult.proof_id).slice(0, 12)}…</code></span>
              )}
            </div>
            {lastResult.reason && <div className="reason">{lastResult.reason}</div>}
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-title">
          Rules
          {fromCache && (
            <span className="muted small" style={{ marginLeft: 8, textTransform: "none", letterSpacing: 0 }}>
              cached from compile time
            </span>
          )}
        </div>

        {rulesLoading && !parsedRules && <div className="muted">Loading...</div>}

        {parsedRules && parsedRules.length > 0 && (
          <ol className="rules-list">
            {parsedRules.map((r, i) => (
              <li key={i} className="rule-item">
                <span className="rule-num">{i + 1}.</span>
                <span className="rule-text">{ruleAsText(r)}</span>
              </li>
            ))}
          </ol>
        )}

        {smtTokens && (
          <details className="rule-smt" style={{ marginTop: 10 }}>
            <summary>
              <span>SMT formula</span>
              <span className="toggle-label" />
            </summary>
            <pre className="smt">
              <code>
                {smtTokens.map((t, i) => (
                  <span key={i} className={`smt-${t.kind}`}>{t.text}</span>
                ))}
              </code>
            </pre>
          </details>
        )}

        {!rulesLoading && !parsedRules && rulesNotFound && (
          <div className="muted small">
            The Preflight API doesn't expose compiled rules for existing policies.
            {policy.rule_count != null && <> The compiler reported <b>{policy.rule_count}</b> rules. </>}
            Recompile a similar policy to capture and display its rules locally.
          </div>
        )}

        {!rulesLoading && !parsedRules && !rulesNotFound && rulesErr && (
          <div className="error inline">{rulesErr}</div>
        )}

        {!rulesLoading && !parsedRules && !rulesErr && rulesResp != null && (
          <details className="rule-extra" style={{ marginTop: 6 }}>
            <summary>view server response</summary>
            <pre style={{ fontSize: 11, overflow: "auto", maxHeight: 240, background: "var(--panel-2)", padding: 8, borderRadius: 6, marginTop: 6 }}>
              {JSON.stringify(rulesResp, null, 2)}
            </pre>
          </details>
        )}
      </div>

      <div className="card">
        <div className="card-title">
          Scenarios
          <button
            className="link"
            style={{ marginLeft: 8 }}
            onClick={() => setShowAddScenario(true)}
          >
            + add scenario
          </button>
        </div>
        {scenariosErr && <div className="error inline">{scenariosErr}</div>}
        {scenarios === null && !scenariosErr && <div className="muted">Loading...</div>}

        {scenarioErr && <div className="error inline">{scenarioErr}</div>}

        {scenarios && scenarios.length === 0 && (
          <div className="muted small">No scenarios yet.</div>
        )}
        {scenarios && scenarios.length > 0 && (
          <ul className="scenarios">
            {scenarios.map((s, i) => {
              const key = scenarioKey(s, i);
              const content = scenarioContent(s);
              const fb = scenarioFeedback[key];
              const isRejecting = rejecting === key;
              return (
                <li key={key} className={fb ? `fb-${fb}` : ""}>
                  <div className="scenario-content">{content}</div>
                  <div className="scenario-actions">
                    {fb === "approved" && <span className="tag approved">approved</span>}
                    {fb === "rejected" && <span className="tag rejected">rejected</span>}
                    {fb === "saving" && <span className="muted small">saving...</span>}
                    {!fb && !isRejecting && (
                      <>
                        <button onClick={() => submitFeedback(s, key, true)}>Approve</button>
                        <button onClick={() => { setRejecting(key); setAnnotation(""); }}>Reject</button>
                      </>
                    )}
                  </div>
                  {isRejecting && (
                    <div className="reject-form">
                      <input
                        type="text"
                        autoFocus
                        placeholder="Why? e.g. 'rule 1 violated: /tmp is outside research'"
                        value={annotation}
                        onChange={(e) => setAnnotation(e.target.value)}
                      />
                      <button
                        onClick={() => submitFeedback(s, key, false, annotation)}
                        disabled={!annotation.trim()}
                        className="danger"
                      >
                        Submit reject
                      </button>
                      <button onClick={() => { setRejecting(null); setAnnotation(""); }}>Cancel</button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <div className="row" style={{ marginTop: 12 }}>
          <button
            onClick={startRefine}
            disabled={refining}
            title="Rebuild this policy using the queued reject feedback"
          >
            {refining ? "Refining..." : refineDone ? "Refine again" : "Refine policy"}
          </button>
          {refineDone && (
            <span className="status success" style={{ padding: "6px 10px", fontSize: 12 }}>
              Refined. Click a policy to reload.
            </span>
          )}
        </div>
        {refineProgress.length > 0 && (
          <div className="card progress" style={{ marginTop: 8 }}>
            <div className="card-title">Refinement progress</div>
            <ul>
              {refineProgress.map((p, i) => (
                <li key={i}>
                  <span className={`tag ${p.kind.toLowerCase()}`}>{p.kind}</span>
                  <span className="msg">{p.text}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {showAddScenario && (
        <AddScenarioModal
          policyId={policy.id}
          onClose={() => setShowAddScenario(false)}
          onSaved={handleScenarioSaved}
        />
      )}
    </div>
  );
}
