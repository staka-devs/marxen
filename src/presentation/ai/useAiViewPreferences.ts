import { useCallback, useState } from "react";
import type { AiViewPreferencesStore } from "../../application/ai/view-preferences-port";
import type { AiViewPreferences } from "../../contracts/ai-view-preferences";
import { defaultAiViewPreferences, normalizeAiViewPreferences } from "../../domain/ai-view-preferences";

/** Own shared AI view state and expose storage failure without changing any native AI state. */
export function useAiViewPreferences(store?: AiViewPreferencesStore) {
  const [preferences, setPreferences] = useState(() => {
    try { return normalizeAiViewPreferences(store?.load()); }
    catch { return defaultAiViewPreferences(); }
  });
  const [saveFailed, setSaveFailed] = useState(false);
  /** Apply a view-only change for this session and persist it through the injected port. */
  const updatePreferences = useCallback((next: AiViewPreferences) => {
    const normalized = normalizeAiViewPreferences(next);
    setPreferences(normalized);
    try { setSaveFailed(store?.save(normalized) === false); }
    catch { setSaveFailed(true); }
  }, [store]);
  return { preferences, updatePreferences, saveFailed };
}
