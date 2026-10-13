import type { SystemLocaleSource } from "../../application/language/ports";

/** Read the embedding browser's primary locale without exposing platform globals to application rules. */
function readSystemLocale(): string {
  return globalThis.navigator?.language || "en-US";
}

/** Host-locale adapter injected by the composition root. */
export const systemLocaleSource: SystemLocaleSource = {
  read: readSystemLocale,
};
