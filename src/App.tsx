import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./tauri";
import type { LogEntry, MeResponse, PolicySummary } from "./types";
import { normalizePolicy } from "./types";
import AccountBar from "./components/AccountBar";
import PoliciesList from "./components/PoliciesList";
import PolicyDetail from "./components/PolicyDetail";
import CreatePolicyModal from "./components/CreatePolicyModal";
import ActivityLog from "./components/ActivityLog";
import SignupModal from "./components/SignupModal";
import LoginModal from "./components/LoginModal";
import HookSettings from "./components/HookSettings";
import { usePolicyNames } from "./hooks/usePolicyNames";
import { usePolicyHidden } from "./hooks/usePolicyHidden";
import { usePolicyRulesCache } from "./hooks/usePolicyRulesCache";

export default function App() {
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [me, setMe] = useState<MeResponse | null>(null);
  const [policies, setPolicies] = useState<PolicySummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [signingUp, setSigningUp] = useState(false);
  const [loggingIn, setLoggingIn] = useState(false);
  const [showHookSettings, setShowHookSettings] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const { names: policyNames, setName: setPolicyName, clear: clearPolicyNames } = usePolicyNames();
  const { hiddenSet, hide: hidePolicy, unhide: unhidePolicy, hiddenCount, clear: clearHidden } = usePolicyHidden();
  const { clear: clearRulesCache } = usePolicyRulesCache();
  const [showHidden, setShowHidden] = useState(false);
  const [hookInstalled, setHookInstalled] = useState<boolean | null>(null);
  const [hookEnabled, setHookEnabled] = useState<boolean | null>(null);

  const refreshHookStatus = useCallback(async () => {
    try {
      const s = await api.getHookStatus();
      setHookInstalled(s.installed);
      setHookEnabled(s.enabled);
    } catch {
      // ignore — banner just won't show
    }
  }, []);

  useEffect(() => {
    refreshHookStatus();
    const id = window.setInterval(refreshHookStatus, 10000);
    return () => window.clearInterval(id);
  }, [refreshHookStatus]);

  const refresh = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const keyPresent = await api.hasApiKey();
      setHasKey(keyPresent);
      if (!keyPresent) return;
      const [meResp, polsResp] = await Promise.all([api.me(), api.listPolicies()]);
      setMe(meResp);
      const rawList: unknown[] = Array.isArray(polsResp)
        ? polsResp
        : (polsResp as { policies?: unknown[] })?.policies ?? [];
      const list = rawList
        .map(normalizePolicy)
        .filter((p): p is PolicySummary => p !== null);
      if (rawList.length > 0 && list.length === 0) {
        console.warn("listPolicies returned items but none had an id field:", rawList[0]);
      }
      setPolicies(list);
      if (!selectedId && list.length > 0) setSelectedId(list[0].id);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [selectedId]);

  useEffect(() => {
    refresh();
  }, []);

  const visiblePolicies = useMemo(
    () => showHidden ? policies : policies.filter((p) => !hiddenSet.has(p.id)),
    [policies, hiddenSet, showHidden],
  );

  const selected = useMemo(
    () => policies.find((p) => p.id === selectedId) ?? null,
    [policies, selectedId],
  );

  const appendLog = useCallback((entry: LogEntry) => {
    setLog((prev) => [{ ...entry, source: entry.source ?? "app" }, ...prev].slice(0, 500));
  }, []);

  const updateLog = useCallback((id: string, patch: Partial<LogEntry>) => {
    setLog((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  }, []);

  // Tail the hook's local activity log every 3s and merge new entries.
  useEffect(() => {
    let cancelled = false;
    let seen = new Set<string>();
    const pull = async () => {
      try {
        const entries = await api.readActivity(500);
        if (cancelled) return;
        const fresh: LogEntry[] = [];
        for (const raw of entries) {
          if (!raw || typeof raw !== "object") continue;
          const e = raw as Record<string, unknown>;
          const checkId = typeof e.check_id === "string" ? e.check_id : "";
          const tsIso = typeof e.ts === "string" ? e.ts : "";
          const key = `hook:${checkId || tsIso}:${typeof e.input === "string" ? e.input.slice(0, 40) : ""}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const tsMs = tsIso ? Date.parse(tsIso) || Date.now() : Date.now();
          const tool = typeof e.tool === "string" ? e.tool : undefined;
          const action = (typeof e.plain_english === "string" && e.plain_english) ||
            (typeof e.input === "string" && e.input) ||
            "(no input)";
          const rawResult = typeof e.result === "string" ? e.result : "";
          const result: LogEntry["result"] =
            rawResult === "SAT" ? "SAT" :
            rawResult === "UNSAT" ? "UNSAT" :
            rawResult ? "ERROR" : undefined;
          fresh.push({
            id: `hook-${key}`,
            ts: tsMs,
            policy_id: typeof e.policy_id === "string" ? e.policy_id : "",
            policy_label: typeof e.policy_id === "string" ? `hook (${e.policy_id.slice(0, 8)})` : "hook",
            action: tool ? `${tool}: ${action}` : action,
            result,
            blocked: typeof e.blocked === "boolean" ? e.blocked : (rawResult === "UNSAT"),
            reason: typeof e.detail === "string" && e.detail.length > 0 ? e.detail : undefined,
            proof_id: typeof e.check_id === "string" ? e.check_id : undefined,
            source: "hook",
            tool,
            raw: e,
          });
        }
        if (fresh.length > 0) {
          setLog((prev) => {
            const knownIds = new Set(prev.map((p) => p.id));
            const additions = fresh.filter((f) => !knownIds.has(f.id));
            if (additions.length === 0) return prev;
            return [...additions, ...prev]
              .sort((a, b) => b.ts - a.ts)
              .slice(0, 500);
          });
        }
      } catch {
        // ignore; log file may not exist yet
      }
    };
    // First read uses Set seeding by replaying all entries silently the first time.
    (async () => {
      try {
        const initial = await api.readActivity(500);
        if (cancelled) return;
        for (const raw of initial) {
          if (!raw || typeof raw !== "object") continue;
          const e = raw as Record<string, unknown>;
          const checkId = typeof e.check_id === "string" ? e.check_id : "";
          const tsIso = typeof e.ts === "string" ? e.ts : "";
          const key = `hook:${checkId || tsIso}:${typeof e.input === "string" ? e.input.slice(0, 40) : ""}`;
          seen.add(key);
        }
        // Seed the log with historical entries on first load.
        setLog((prev) => {
          if (prev.length > 0) return prev;
          return initial
            .map((raw): LogEntry | null => {
              if (!raw || typeof raw !== "object") return null;
              const e = raw as Record<string, unknown>;
              const checkId = typeof e.check_id === "string" ? e.check_id : "";
              const tsIso = typeof e.ts === "string" ? e.ts : "";
              const tsMs = tsIso ? Date.parse(tsIso) || Date.now() : Date.now();
              const tool = typeof e.tool === "string" ? e.tool : undefined;
              const action = (typeof e.plain_english === "string" && e.plain_english) ||
                (typeof e.input === "string" && e.input) ||
                "(no input)";
              const rawResult = typeof e.result === "string" ? e.result : "";
              const result: LogEntry["result"] =
                rawResult === "SAT" ? "SAT" :
                rawResult === "UNSAT" ? "UNSAT" :
                rawResult ? "ERROR" : undefined;
              return {
                id: `hook-hook:${checkId || tsIso}:${typeof e.input === "string" ? e.input.slice(0, 40) : ""}`,
                ts: tsMs,
                policy_id: typeof e.policy_id === "string" ? e.policy_id : "",
                policy_label: typeof e.policy_id === "string" ? `hook (${e.policy_id.slice(0, 8)})` : "hook",
                action: tool ? `${tool}: ${action}` : action,
                result,
                blocked: typeof e.blocked === "boolean" ? e.blocked : (rawResult === "UNSAT"),
                reason: typeof e.detail === "string" && e.detail.length > 0 ? e.detail : undefined,
                proof_id: typeof e.check_id === "string" ? e.check_id : undefined,
                source: "hook",
                tool,
                raw: e,
              };
            })
            .filter((x): x is LogEntry => x !== null)
            .sort((a, b) => b.ts - a.ts)
            .slice(0, 500);
        });
      } catch {
        // ignore
      }
    })();
    const id = window.setInterval(pull, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  const patchPolicy = useCallback((id: string, patch: Partial<PolicySummary>) => {
    setPolicies((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }, []);

  const onHidePolicy = useCallback((id: string) => {
    hidePolicy(id);
    if (selectedId === id) {
      const idx = policies.findIndex((p) => p.id === id);
      const visible = policies.filter((p) => p.id !== id && !hiddenSet.has(p.id));
      const replacement = visible[idx] ?? visible[idx - 1] ?? visible[0] ?? null;
      setSelectedId(replacement?.id ?? null);
    }
  }, [hidePolicy, selectedId, policies, hiddenSet]);

  return (
    <div className="app">
      <AccountBar
        me={me}
        hasKey={hasKey}
        loading={loading}
        onRefresh={refresh}
        onOpenHookSettings={() => setShowHookSettings(true)}
        onLogout={async () => {
          try {
            await api.logout();
          } catch (e) {
            setError(String(e));
          }
          setMe(null);
          setPolicies([]);
          setSelectedId(null);
          setHasKey(false);
          setLog([]);
          clearHidden();
          clearPolicyNames();
          clearRulesCache();
        }}
      />

      {error && <div className="banner error">{error}</div>}
      {hasKey === false && (
        <div className="banner warn">
          No API key found in <code>~/.icme/env</code>.{" "}
          <button className="link" onClick={() => setLoggingIn(true)}>Log in with existing key</button>{" "}
          or{" "}
          <button className="link" onClick={() => setSigningUp(true)}>create a new account</button>.
        </div>
      )}
      {hasKey && hookInstalled && hookEnabled === true && (
        <div className="banner hook-on">
          <span className="dot" /> <b>Claude Code Hook is enabled.</b> Tool calls run through your active policy.{" "}
          <button className="link" onClick={() => setShowHookSettings(true)}>Open hook settings</button>
        </div>
      )}
      {hasKey && hookInstalled && hookEnabled === false && (
        <div className="banner hook-off">
          <span className="dot" /> <b>Claude Code Hook is disabled.</b> Tool calls aren't being checked against any policy.{" "}
          <button className="link" onClick={() => setShowHookSettings(true)}>Open hook settings</button>
        </div>
      )}

      <div className="main">
        <aside className="sidebar">
          <PoliciesList
            policies={visiblePolicies}
            policyNames={policyNames}
            hiddenSet={hiddenSet}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onNew={() => setCreating(true)}
            showHidden={showHidden}
            hiddenCount={hiddenCount}
            onToggleHidden={() => setShowHidden((s) => !s)}
          />
        </aside>

        <section className="content">
          {selected ? (
            <PolicyDetail
              policy={selected}
              nickname={policyNames[selected.id]}
              isHidden={hiddenSet.has(selected.id)}
              onNicknameChange={(n) => setPolicyName(selected.id, n)}
              onCheck={appendLog}
              onCheckUpdate={updateLog}
              onPolicyDetail={patchPolicy}
              onHide={onHidePolicy}
              onUnhide={unhidePolicy}
            />
          ) : (
            <div className="empty">
              {hasKey ? "Select or create a policy on the left." : "Set your API key to begin."}
            </div>
          )}
          <ActivityLog entries={log} />
        </section>
      </div>

      {creating && (
        <CreatePolicyModal
          onClose={() => setCreating(false)}
          onCreated={async () => {
            setCreating(false);
            await refresh();
          }}
        />
      )}

      {signingUp && (
        <SignupModal
          onClose={() => setSigningUp(false)}
          onComplete={async () => {
            setSigningUp(false);
            await refresh();
          }}
        />
      )}

      {loggingIn && (
        <LoginModal
          onClose={() => setLoggingIn(false)}
          onComplete={async () => {
            setLoggingIn(false);
            await refresh();
          }}
        />
      )}

      {showHookSettings && (
        <HookSettings
          onClose={() => { setShowHookSettings(false); refreshHookStatus(); }}
          policies={policies}
          policyNames={policyNames}
        />
      )}
    </div>
  );
}
