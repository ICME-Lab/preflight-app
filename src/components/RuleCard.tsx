import { useState } from "react";
import { formatSmt, highlightSmt } from "../utils/smt";

interface Props {
  index: number;
  rule: unknown;
}

function pickStr(o: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

function extractParts(rule: unknown): {
  name?: string;
  description?: string;
  smt?: string;
  rest?: Record<string, unknown>;
} {
  if (typeof rule === "string") return { smt: rule };
  if (!rule || typeof rule !== "object") return { description: String(rule) };
  const o = { ...(rule as Record<string, unknown>) };
  const name = pickStr(o, "name", "id", "rule_id", "ruleId", "label");
  const description = pickStr(o, "description", "explanation", "english", "natural_language", "naturalLanguage");
  const smt = pickStr(o, "smt", "smtlib", "smt_lib", "body", "expression", "expr", "formula", "rule");
  for (const k of [
    "name", "id", "rule_id", "ruleId", "label",
    "description", "explanation", "english", "natural_language", "naturalLanguage",
    "smt", "smtlib", "smt_lib", "body", "expression", "expr", "formula", "rule",
  ]) {
    delete o[k];
  }
  return { name, description, smt, rest: Object.keys(o).length > 0 ? o : undefined };
}

export default function RuleCard({ index, rule }: Props) {
  const [copied, setCopied] = useState(false);
  const { name, description, smt, rest } = extractParts(rule);
  const formatted = smt ? formatSmt(smt) : null;
  const tokens = formatted ? highlightSmt(formatted) : null;

  const copy = async () => {
    if (!formatted) return;
    await navigator.clipboard.writeText(formatted);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  void index;
  return (
    <li className="rule-item">
      {name && <div className="rule-name">{name}</div>}
      {description ? (
        <div className="rule-desc">{description}</div>
      ) : !formatted ? (
        <div className="muted small">(no description or SMT body)</div>
      ) : null}
      {tokens && (
        <details className="rule-smt">
          <summary>
            <span>SMT formula</span>
            {formatted && (
              <button
                className="link rule-copy"
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); copy(); }}
              >
                {copied ? "copied" : "copy"}
              </button>
            )}
          </summary>
          <pre className="smt">
            <code>
              {tokens.map((t, i) => (
                <span key={i} className={`smt-${t.kind}`}>{t.text}</span>
              ))}
            </code>
          </pre>
        </details>
      )}
      {rest && (
        <details className="rule-extra">
          <summary>more fields</summary>
          <ul>
            {Object.entries(rest).map(([k, v]) => (
              <li key={k}>
                <span className="rule-extra-k">{k}</span>
                <code>{typeof v === "string" ? v : JSON.stringify(v)}</code>
              </li>
            ))}
          </ul>
        </details>
      )}
    </li>
  );
}
