import { createContext, useCallback, useContext, useMemo, useRef, type ReactNode } from "react";
import type { Language } from "../../contracts/language";
import type { MessageFactory, Translator, TranslatorFactory } from "../../contracts/localization";
import { japaneseTranslator, localizedMessage } from "../../domain/localization";

interface I18nValue {
  language: Language;
  /** Translate a catalog key to the active language. */
  t: Translator;
  /** Retain a typed frontend message independently of the active language. */
  message: MessageFactory;
}

const I18nContext = createContext<I18nValue>({ language: "ja-JP", t: japaneseTranslator, message: localizedMessage });

/** Supply reactive locale context without remounting editor or workspace state. */
export function I18nProvider({ language, createTranslator, children }: { language: Language; createTranslator: TranslatorFactory; children: ReactNode }) {
  const engine = useMemo(() => createTranslator(language), [language, createTranslator]);
  const engineRef = useRef(engine);
  engineRef.current = engine;
  /** Let asynchronous callbacks use the latest language without changing their run dependencies. */
  const translate = useCallback<Translator>((key, ...args) => engineRef.current(key, ...args), []);
  const value = useMemo<I18nValue>(() => ({ language, t: translate, message: localizedMessage }), [language, translate]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** Read active language and typed translation lookup. */
export function useI18n(): I18nValue {
  return useContext(I18nContext);
}
