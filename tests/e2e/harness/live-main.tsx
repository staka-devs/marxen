// Dev-only harness for live-widget browser tests (never shipped: no build
// entry references it, so `vite build` and Tauri packages exclude it).
import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { CodeMirrorEditor, type EditorSelection } from "../../../src/components/editor/CodeMirrorEditor";
import type { TextEdit } from "../../../src/shared/contracts";
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
  const valueRef = useRef(value);
  valueRef.current = value;
  const editsRef = useRef(edits);
  editsRef.current = edits;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  window.__harness = {
    setValue: (text: string) => setValue(text),
    getValue: () => valueRef.current,
    getEdits: () => editsRef.current,
    clearEdits: () => setEdits([]),
    getSelection: () => selectionRef.current,
  };

  return (
    <div style={{ padding: 16, maxWidth: 900 }}>
      <CodeMirrorEditor
        value={value}
        ariaLabel="ライブハーネス"
        testId="harness-editor"
        livePreview
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
