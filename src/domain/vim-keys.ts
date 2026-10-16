// Deterministic DOM-key to Neovim notation serializer (domain).
//
// Pure mapping shared by the shell router and the raw grid view. No Tauri,
// DOM, React, or browser globals: callers pass a plain key record and receive
// wire notation or null for keys the OS or shell owns.

/** Plain key record mirroring the DOM fields the shell reads. */
export interface VimKey {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

/**
 * Named DOM keys normalized before modifiers.
 *
 * `Ctrl+ArrowUp` becomes `<C-Up>`, never `<C-ArrowUp>`.
 */
const NAMED_VIM_KEYS: Record<string, string> = {
  Enter: "CR",
  Backspace: "BS",
  Tab: "Tab",
  Escape: "Esc",
  Delete: "Del",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  " ": "Space",
};

/** DOM keys owned by the platform IME or composition system, never Vim. */
const PLATFORM_IME_KEYS = new Set([
  "KanjiMode",
  "Convert",
  "NonConvert",
  "Hiragana",
  "HiraganaKatakana",
  "Katakana",
  "Zenkaku",
  "Hankaku",
  "ZenkakuHankaku",
  "Romaji",
  "Alphanumeric",
  "ModeChange",
  "HangulMode",
  "JunjaMode",
  "FinalMode",
  "HanjaMode",
  "Eisu",
  "Process",
  "Dead",
  "Unidentified",
]);

/**
 * Serialize a DOM key record to Neovim input notation for `nvim_input`.
 *
 * Returns null for pure modifiers, platform IME keys, and UI-reserved keys
 * the shell filters before calling. Platform IME keys return null before any
 * modifier formatting so the OS default is never prevented. Named keys are
 * normalized before modifiers; multi-character keys (IME-committed text)
 * pass through verbatim. Both the shell router and the raw grid view share
 * this serializer.
 */
export function serializeVimKey(event: VimKey): string | null {
  const { key, ctrlKey, metaKey, altKey, shiftKey } = event;
  if (key === "Control" || key === "Shift" || key === "Alt" || key === "Meta") return null;
  if (PLATFORM_IME_KEYS.has(key)) return null;
  const normalized = NAMED_VIM_KEYS[key] ?? key;
  if (ctrlKey || metaKey) {
    const mod = metaKey ? "D" : "C";
    const base = normalized.length === 1 ? normalized.toLowerCase() : normalized;
    return `<${mod}-${shiftKey ? "S-" : ""}${altKey ? "M-" : ""}${base}>`;
  }
  if (altKey) {
    return `<M-${normalized}>`;
  }
  switch (normalized) {
    case "CR":
      return "<CR>";
    case "BS":
      return "<BS>";
    case "Tab":
      return shiftKey ? "<S-Tab>" : "<Tab>";
    case "Esc":
      return "<Esc>";
    case "Del":
      return "<Del>";
    case "Up":
      return "<Up>";
    case "Down":
      return "<Down>";
    case "Left":
      return "<Left>";
    case "Right":
      return "<Right>";
    case "Home":
      return "<Home>";
    case "End":
      return "<End>";
    case "PageUp":
      return "<PageUp>";
    case "PageDown":
      return "<PageDown>";
    case "Space":
      return " ";
    default:
      if (/^F\d{1,2}$/.test(normalized)) return shiftKey ? `<S-${normalized}>` : `<${normalized}>`;
      return key === "<" ? "<LT>" : key;
  }
}
