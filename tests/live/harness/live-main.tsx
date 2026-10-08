// Dev-only harness for live-widget browser tests (never shipped: no build
// entry references it, so `vite build` and Tauri packages exclude it).
import { useCallback, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { CodeMirrorEditor, type EditorSelection, type ExternalCursor } from "../../../src/components/editor/CodeMirrorEditor";
import type { TextEdit } from "../../../src/shared/contracts";
import { DEFAULT_EDITOR_PREFERENCES, type EditorPreferences } from "../../../src/lib/editor-preferences";
import "../../../src/styles.css";

export const SAMPLE = [
  "# ライブ見出し",
  "",
  "段落の **太字** と `code`。",
  "",
  "- [ ] 未完了タスク",
  "- [x] 完了タスク",
  "",
  "| 項目 | 値 |",
  "| --- | --- |",
  "| 日本語 | **太字** |",
  "| A\\|B | `x|y` |",
  "",
  "> [!NOTE]",
  "> 補足情報。",
  "",
  "脚注の参照[^live]。",
  "",
  "[^live]: 脚注の定義文。",
  "",
  "```mermaid",
  "flowchart LR",
  "    A --> [",
  "```",
  "",
  '<div id="location">利用者HTML</div>',
  "",
  "末尾の段落。",
  "",
].join("\n");

function applyEditsToText(before: string, edits: TextEdit[]): string {
  const ordered = [...edits].sort((a, b) => b.range.start - a.range.start);
  let out = before;
  for (const edit of ordered) {
    out = out.slice(0, edit.range.start) + edit.text + out.slice(edit.range.end);
  }
  return out;
}

interface HarnessApi {
  setValue: (text: string) => void;
  getValue: () => string;
  getEdits: () => TextEdit[][];
  clearEdits: () => void;
  getSelection: () => EditorSelection | null;
  /** Shell cursor echo with its own sequence (ExternalCursor seq seam). */
  echoCursor: (anchor: number, head: number) => void;
  /** Relative sources the fake image resolver was asked for. */
  imageCalls: () => string[];
  setPreferences: (preferences: Partial<EditorPreferences>) => void;
  setVimMode: (mode: string) => void;
}

declare global {
  interface Window {
    __harness: HarnessApi;
  }
}

function Harness() {
  const [value, setValue] = useState(SAMPLE);
  const [edits, setEdits] = useState<TextEdit[][]>([]);
  const [selection, setSelection] = useState<EditorSelection | null>(null);
  const [cursor, setCursor] = useState<ExternalCursor | null>(null);
  const [preferences, setPreferences] = useState(DEFAULT_EDITOR_PREFERENCES);
  const [vimMode, setVimMode] = useState("insert");
  const valueRef = useRef(value);
  valueRef.current = value;
  const editsRef = useRef(edits);
  editsRef.current = edits;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const seqRef = useRef(0);
  const imageCallsRef = useRef<string[]>([]);
  // Stand-in for the UI-owned Rust loader: resolves after a delay so stale
  // passes can be observed, and records every requested relative source.
  const resolveImage = useCallback((src: string) => {
    imageCallsRef.current.push(src);
    return new Promise<string | null>((done) => {
      setTimeout(() => done(src.includes("missing") ? null : "data:image/png;base64,aG9uZXk="), 400);
    });
  }, []);

  window.__harness = {
    setValue: (text: string) => setValue(text),
    getValue: () => valueRef.current,
    getEdits: () => editsRef.current,
    clearEdits: () => setEdits([]),
    getSelection: () => selectionRef.current,
    echoCursor: (anchor: number, head: number) => {
      seqRef.current += 1;
      setCursor({ anchor, head, seq: seqRef.current });
    },
    imageCalls: () => [...imageCallsRef.current],
    setPreferences: (next) => setPreferences((previous) => ({ ...previous, ...next })),
    setVimMode,
  };

  return (
    <div style={{ padding: 16, maxWidth: 900 }}>
      <CodeMirrorEditor
        value={value}
        ariaLabel="ライブハーネス"
        testId="harness-editor"
        livePreview
        preferences={preferences}
        vimMode={vimMode}
        externalCursor={cursor}
        resolveImage={resolveImage}
        onGuiEdits={(list) => {
          setEdits((prev) => [...prev, list]);
          // Simulate the backend round-trip synchronously for tests.
          setValue((prev) => applyEditsToText(prev, list));
        }}
        onSelectionChange={setSelection}
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
