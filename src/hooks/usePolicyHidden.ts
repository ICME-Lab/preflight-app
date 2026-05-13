import { useCallback, useEffect, useMemo, useState } from "react";

const STORAGE_KEY = "preflight-app:hidden-policies";

function load(): Record<string, number> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

export function usePolicyHidden() {
  const [hidden, setHidden] = useState<Record<string, number>>(() => load());

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(hidden));
    } catch {
      // ignore
    }
  }, [hidden]);

  const hide = useCallback((id: string) => {
    setHidden((prev) => ({ ...prev, [id]: Date.now() }));
  }, []);

  const unhide = useCallback((id: string) => {
    setHidden((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const isHidden = useCallback((id: string) => Object.prototype.hasOwnProperty.call(hidden, id), [hidden]);

  const hiddenSet = useMemo(() => new Set(Object.keys(hidden)), [hidden]);

  const clear = useCallback(() => {
    setHidden({});
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  }, []);

  return { hidden, hiddenSet, hide, unhide, isHidden, hiddenCount: hiddenSet.size, clear };
}
