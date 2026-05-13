import { useState } from "react";
import type { LogEntry } from "../types";

interface Props {
  entries: LogEntry[];
}

function verdictClass(e: LogEntry): string {
  if (e.result === "PENDING") return "pending";
  if (e.result === "ERROR") return "error";
  if (e.blocked || e.result === "UNSAT") return "blocked";
  return "allowed";
}

function fmt(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function fmtFull(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString();
}

export default function ActivityLog({ entries }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="card log">
      <div className="card-title">
        Activity log <span className="muted small">({entries.length})</span>
      </div>
      {entries.length === 0 && (
        <div className="muted">No actions checked yet this session.</div>
      )}
      <ul>
        {entries.map((e) => {
          const isOpen = expanded.has(e.id);
          return (
            <li
              key={e.id}
              className={`${verdictClass(e)}${isOpen ? " open" : ""}`}
              onClick={() => toggle(e.id)}
              title={isOpen ? "Click to collapse" : "Click to expand"}
            >
              <span className="chev">{isOpen ? "▾" : "▸"}</span>
              <span className="ts" title={fmtFull(e.ts)}>{fmt(e.ts)}</span>
              <span className="verdict-tag">{e.result ?? "?"}</span>
              <span className="action">
                {e.source === "hook" && <span className="src-tag" title="from the Claude Code hook">hook</span>}
                {e.action}
              </span>
              <span className="policy-tag" title={e.policy_label}>
                {e.policy_label.slice(0, 28)}{e.policy_label.length > 28 ? "…" : ""}
              </span>
              {isOpen && (
                <div className="log-detail">
                  {e.reason && (
                    <div className="detail-row">
                      <span className="k">reason</span>
                      <span className="v">{e.reason}</span>
                    </div>
                  )}
                  <div className="detail-row">
                    <span className="k">policy</span>
                    <span className="v">{e.policy_label}</span>
                  </div>
                  <div className="detail-row">
                    <span className="k">policy_id</span>
                    <code className="v">{e.policy_id || "(none)"}</code>
                  </div>
                  {e.tool && (
                    <div className="detail-row">
                      <span className="k">tool</span>
                      <code className="v">{e.tool}</code>
                    </div>
                  )}
                  {e.proof_id && (
                    <div className="detail-row">
                      <span className="k">check_id</span>
                      <code className="v">{e.proof_id}</code>
                    </div>
                  )}
                  <div className="detail-row">
                    <span className="k">timestamp</span>
                    <span className="v">{fmtFull(e.ts)}</span>
                  </div>
                  <div className="detail-row">
                    <span className="k">source</span>
                    <span className="v">{e.source ?? "app"}</span>
                  </div>
                  <details className="detail-row raw">
                    <summary className="k">raw</summary>
                    <pre>{JSON.stringify(e.raw ?? e, null, 2)}</pre>
                  </details>
                </div>
              )}
              {!isOpen && e.reason && <div className="reason">{e.reason}</div>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
