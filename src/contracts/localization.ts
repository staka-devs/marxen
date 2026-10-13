import type { japaneseMessages } from "./localization-messages";
import type { Language } from "./language";
import type { AiError } from "./ai-contracts";

/** Translation keys are stable source messages, as in gettext message identifiers. */
export type MessageKey = keyof typeof japaneseMessages;
/** Extract every named interpolation slot from a literal catalog template. */
type Slots<Text extends string> = Text extends `${string}{{${infer Slot}}}${infer Rest}` ? Slot | Slots<Rest> : never;
/** Keys usable as static labels without interpolation parameters. */
export type LabelKey = { [Key in MessageKey]: [Slots<typeof japaneseMessages[Key]>] extends [never] ? Key : never }[MessageKey];
/** Values accepted by a message's exact interpolation contract. */
export type MessageParameters<Key extends MessageKey> = Record<Slots<typeof japaneseMessages[Key]>, string | number>;
/** Require a parameters object only for messages that contain interpolation slots. */
export type MessageArguments<Key extends MessageKey> = [Slots<typeof japaneseMessages[Key]>] extends [never] ? [] : [parameters: MessageParameters<Key>];
/** Translate a catalog key with every required interpolation parameter. */
export type Translator = <Key extends MessageKey>(key: Key, ...args: MessageArguments<Key>) => string;
/** Build an isolated translator for the selected language. */
export type TranslatorFactory = (language: Language) => Translator;

/** Locale-independent message retained in UI state until it is rendered. */
export interface MessageDescriptor {
  key: MessageKey;
  parameters?: Record<string, LocalizedText | number>;
}
/** Ordered message parts compose localized annotations with opaque backend data. */
export interface MessageSequence {
  parts: LocalizedText[];
}
/** Retain a structured failure and render its explanation in the active language. */
export interface LocalizedComputation {
  /** Compute presentation text from an explicitly supplied translator. */
  format(translator: Translator): string;
}
/** Explain a structured failure without translating its opaque detail fields. */
export type ErrorFormatter = (cause: unknown, translator: Translator) => string;
/** Opaque backend text or a known frontend-generated catalog message. */
export type LocalizedText = string | MessageDescriptor | MessageSequence | LocalizedComputation;
/** Interpolation contract for retained messages, including nested translated annotations. */
export type DescriptorArguments<Key extends MessageKey> = [Slots<typeof japaneseMessages[Key]>] extends [never] ? [] : [parameters: Record<Slots<typeof japaneseMessages[Key]>, LocalizedText | number>];
/** Capture a typed message without binding it to the current display language. */
export type MessageFactory = <Key extends MessageKey>(key: Key, ...args: DescriptorArguments<Key>) => MessageDescriptor;
/** Frontend failure metadata accompanies the existing AI wire error without changing its protocol fields. */
export type FrontendAiError = AiError & { frontendMessage: LocalizedText };
