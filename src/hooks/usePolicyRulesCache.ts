import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "preflight-app:policy-rules";

export interface CachedRules {
  capturedAt: number;
  raw: unknown;
}

type CacheMap = Record<string, CachedRules>;

function load(): CacheMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as CacheMap) : {};
  } catch {
    return {};
  }
}

export function usePolicyRulesCache() {
  const [cache, setCache] = useState<CacheMap>(() => load());

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
    } catch {
      // ignore
    }
  }, [cache]);

  const save = useCallback((policyId: string, raw: unknown) => {
    setCache((prev) => ({ ...prev, [policyId]: { capturedAt: Date.now(), raw } }));
  }, []);

  const clear = useCallback(() => {
    setCache({});
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  }, []);

  return { cache, save, clear };
}

// Pull a policy_id out of an SSE 'done' payload. Tries common field names.
export function extractPolicyId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  for (const k of ["policy_id", "policyId", "id"]) {
    const v = p[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

// Try to pull a rules array from a cached SSE done payload.
export function extractCachedRules(cached: CachedRules | undefined): unknown[] | null {
  if (!cached) return null;
  const raw = cached.raw;
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  for (const k of ["rules", "compiled_rules", "compiledRules", "smt_rules", "smtRules", "smtlib", "smt_lib"]) {
    const v = r[k];
    if (Array.isArray(v)) return v;
    if (typeof v === "string" && v.length > 0) return [v];
  }
  return null;
}
