import { japaneseMessages } from "../contracts/localization-messages";
import type { DescriptorArguments, ErrorFormatter, LocalizedComputation, LocalizedText, MessageArguments, MessageDescriptor, MessageKey, MessageSequence, Translator } from "../contracts/localization";

/** Format standard Japanese for isolated presentation tests and unprovided contexts. */
export function japaneseTranslator<Key extends MessageKey>(key: Key, ...args: MessageArguments<Key>): string {
  const values = args[0] as Record<string, string | number> | undefined;
  return japaneseMessages[key].replace(/\{\{([^}]+)\}\}/g, (_match, name: string) => {
    if (!values || !(name in values)) throw new Error(`Missing localization parameter: ${name}`);
    return typeof values[name] === "number" ? new Intl.NumberFormat("ja-JP").format(values[name]) : String(values[name]);
  });
}

/** Capture the catalog key and values so notifications can follow later locale changes. */
export function localizedMessage<Key extends MessageKey>(key: Key, ...args: DescriptorArguments<Key>): MessageDescriptor {
  return { key, parameters: args[0] as Record<string, LocalizedText | number> | undefined };
}

/** Compose translated annotations and unchanged data without rewriting their text. */
export function localizedParts(...parts: LocalizedText[]): MessageSequence {
  return { parts };
}

/** Retain a structured failure for locale changes instead of freezing its translated explanation. */
export function localizedFailure(cause: unknown, describe: ErrorFormatter): LocalizedComputation {
  return {
    /** Format the retained failure with the translator chosen by its presentation owner. */
    format: (t) => describe(cause, t),
  };
}

/** Render known frontend messages while preserving opaque backend and authored text verbatim. */
export function renderLocalizedText(text: LocalizedText, t: Translator): string {
  if (typeof text === "string") return text;
  if ("parts" in text) return text.parts.map(part => renderLocalizedText(part, t)).join("");
  if ("format" in text) return text.format(t);
  const parameters = text.parameters && Object.fromEntries(Object.entries(text.parameters).map(([name, value]) => [name, typeof value === "string" || typeof value === "number" ? value : renderLocalizedText(value, t)]));
  return (t as (key: MessageKey, parameters?: Record<string, string | number>) => string)(text.key, parameters);
}
