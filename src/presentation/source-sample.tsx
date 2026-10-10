import { useEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";

const sample = "# Marxen へようこそ\n\nこれは読み取り専用の表示サンプルです。\n文書の編集・保存は、実 Neovim の接続後に利用できます。\n\n- 日本語と Unicode: 東京 😀\n- Markdownを保持する Markdown 編集\n- Rust が文書と保存を管理\n";

/**
 * Static read-only CodeMirror sample for style checks without Neovim.
 *
 * Mounts once with Markdown and line numbers; editing stays disabled.
 */
export function SourceSample() {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: sample,
        extensions: [markdown(), lineNumbers(), EditorState.readOnly.of(true), EditorView.editable.of(false), EditorView.lineWrapping,
          EditorView.contentAttributes.of({ "aria-label": "読み取り専用の Markdown サンプル", "aria-readonly": "true", role: "textbox", tabindex: "0" }),
          EditorView.theme({ "&": { backgroundColor: "transparent", fontSize: "14px" }, ".cm-content": { fontFamily: "ui-monospace, monospace", padding: "20px 0" }, ".cm-gutters": { backgroundColor: "transparent", border: "none", color: "#949084" }, ".cm-line": { padding: "2px 16px" }, "&.cm-focused": { outline: "2px solid #6b8067", outlineOffset: "4px" } }),
        ],
      }),
    });
    return () => view.destroy();
  }, []);
  return <div ref={host} className="overflow-hidden rounded-lg border border-border bg-background" />;
}
