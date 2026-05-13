export interface MeResponse {
  id?: string;
  username?: string;
  credits?: number;
  admin?: boolean;
  [k: string]: unknown;
}

export interface PolicySummary {
  id: string;
  policy_text?: string;
  text?: string;
  rule_count?: number;
  created_at?: string;
  [k: string]: unknown;
}

export function normalizePolicy(raw: unknown): PolicySummary | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const idCandidate = [
    r.id, r.policy_id, r.policyId, r._id, r.uuid, r.uid,
  ].find((v) => typeof v === "string" && v.length > 0);
  if (!idCandidate) return null;
  return {
    ...r,
    id: String(idCandidate),
    policy_text:
      (typeof r.policy_text === "string" && r.policy_text) ||
      (typeof r.text === "string" && r.text) ||
      (typeof r.policy === "string" && r.policy) ||
      undefined,
    rule_count:
      typeof r.rule_count === "number" ? r.rule_count :
      typeof r.ruleCount === "number" ? r.ruleCount : undefined,
    created_at:
      (typeof r.created_at === "string" && r.created_at) ||
      (typeof r.createdAt === "string" && r.createdAt) || undefined,
  };
}

export interface CheckResult {
  check_id?: string;
  result?: "SAT" | "UNSAT" | string;
  blocked?: boolean;
  reason?: string;
  proof_id?: string;
  variables?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface LogEntry {
  id: string;
  ts: number;
  policy_id: string;
  policy_label: string;
  action: string;
  result?: "SAT" | "UNSAT" | "ERROR" | "PENDING";
  blocked?: boolean;
  reason?: string;
  proof_id?: string;
  source?: "app" | "hook";
  tool?: string;
  raw?: unknown;
}

export interface SseEvent {
  stream_id: string;
  event: string;
  data: unknown;
}
