import { createInstance } from "i18next";
import type { Language } from "../../contracts/language";
import type { MessageArguments, MessageKey, Translator } from "../../contracts/localization";
import { englishMessages, englishPlurals, japaneseMessages, regionalMessages } from "../../contracts/localization-messages";
import { intlLocale } from "../../domain/language";

/** Create an isolated, synchronously initialized i18next catalog without network loading. */
export function createTranslator(language: Language): Translator {
  const base = intlLocale(language);
  const overlay = language === "ja-JP-x-kansai" || language === "ja-JP-x-tokushima" ? regionalMessages[language] : {};
  const engine = createInstance();
  const catalog = base === "en-US" ? { ...englishMessages, ...englishPlurals } : { ...japaneseMessages, ...overlay };
  const formattedCatalog = Object.fromEntries(Object.entries(catalog).map(([key, value]) => [key, value.replaceAll("{{count}}", "{{count, number}}") ]));
  void engine.init({
    lng: base,
    fallbackLng: false,
    initAsync: false,
    keySeparator: false,
    nsSeparator: false,
    interpolation: { escapeValue: false },
    resources: { [base]: { translation: formattedCatalog } },
  });
  /** Validate and interpolate the exact catalog message, formatting numbers with the basic locale. */
  function translate<Key extends MessageKey>(key: Key, ...args: MessageArguments<Key>): string {
    if (!(key in japaneseMessages)) throw new Error(`Unknown localization key: ${key}`);
    const parameters = args[0] as Record<string, string | number> | undefined;
    const expected = [...japaneseMessages[key].matchAll(/\{\{([^}]+)\}\}/g)].map(match => match[1]);
    for (const name of expected) if (!parameters || !(name in parameters)) throw new Error(`Missing localization parameter: ${name}`);
    for (const name of Object.keys(parameters ?? {})) if (!expected.includes(name)) throw new Error(`Unexpected localization parameter: ${name}`);
    const formatted = Object.fromEntries(Object.entries(parameters ?? {}).map(([name, value]) => [name, typeof value === "number" && name !== "count" ? new Intl.NumberFormat(base).format(value) : value]));
    return engine.t(key, formatted);
  }
  return translate;
}
