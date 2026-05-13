import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "preflight-app:policy-names";

function load(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function usePolicyNames() {
  const [names, setNames] = useState<Record<string, string>>(() => load());

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(names));
    } catch {
      // localStorage full or unavailable; tolerate silently
    }
  }, [names]);

  const setName = useCallback((id: string, name: string) => {
    setNames((prev) => {
      const trimmed = name.trim();
      const next = { ...prev };
      if (trimmed.length === 0) delete next[id];
      else next[id] = trimmed;
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    setNames({});
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  }, []);

  return { names, setName, clear };
}
