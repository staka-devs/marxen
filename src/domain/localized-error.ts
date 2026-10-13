import type { DescriptorArguments, LocalizedText, MessageKey } from "../contracts/localization";
import { japaneseTranslator, localizedMessage, renderLocalizedText } from "./localization";
import type { Translator } from "../contracts/localization";

/** A frontend-generated failure retaining its presentation computation and unchanged data. */
export class LocalizableError extends Error {
  readonly localized: LocalizedText;

  /** Materialize an error message while retaining its locale-independent representation. */
  constructor(localized: LocalizedText, t: Translator = japaneseTranslator) {
    super(renderLocalizedText(localized, t));
    this.name = "LocalizableError";
    this.localized = localized;
  }
}

/** A frontend-generated error with a typed catalog key and interpolation values. */
export class LocalizedError<Key extends MessageKey = MessageKey> extends LocalizableError {

  /** Preserve the standard Japanese error text for callers and a descriptor for localized presentation. */
  constructor(key: Key, ...args: DescriptorArguments<Key>) {
    const localized = localizedMessage(key, ...args);
    super(localized);
    this.name = "LocalizedError";
  }
}

/** Create a typed frontend exception with both current-language text and retained catalog identity. */
export function localizedException<Key extends MessageKey>(t: Translator, key: Key, ...args: DescriptorArguments<Key>): LocalizableError {
  return new LocalizableError(localizedMessage(key, ...args), t);
}

/** Render frontend error descriptors and preserve backend failure details without interpreting their text. */
export function opaqueErrorText(cause: unknown, t: Translator): string {
  if (cause instanceof LocalizableError) return renderLocalizedText(cause.localized, t);
  if (cause instanceof Error) return cause.message;
  return typeof cause === "object" && cause !== null ? JSON.stringify(cause) : String(cause);
}
