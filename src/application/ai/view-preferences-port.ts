import type { AiViewPreferences } from "../../contracts/ai-view-preferences";

/** Persistence port for view state; no native AI connection operations are exposed. */
export interface AiViewPreferencesStore {
  /** Load validated view preferences or defaults. */
  load(): AiViewPreferences;
  /** Save view preferences and report whether storage accepted the write. */
  save(preferences: AiViewPreferences): boolean;
}
