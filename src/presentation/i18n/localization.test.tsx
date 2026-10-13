import { useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider, useI18n } from "./I18nProvider";
import { createTranslator } from "../../infrastructure/localization/i18next-translator";
import { CodeMirrorEditor } from "../editor/CodeMirrorEditor";
import { SettingsPanel } from "../workspace/SettingsPanel";
import AiPanel from "../ai-panel";
import type { Language, LanguagePreference } from "../../contracts/language";
import type { TextEdit } from "../../contracts/contracts";
import type { AiGateway } from "../../application/ports";
import type { AiStreamEvent } from "../../contracts/ai-contracts";
import { NotificationToast } from "../workspace/Notifications";
import { localizedMessage } from "../../domain/localization";

interface EditingSurfaceProps {
  language: Language;
  /** Select the test workspace's language. */
  onLanguage: (language: LanguagePreference) => void;
}

/** Exercise an actual CodeMirror instance with dirty text and reactive settings. */
function EditingSurface({ language, onLanguage }: EditingSurfaceProps) {
  const { t } = useI18n();
  const [text, setText] = useState("# 日本語の本文\n保存前の文書");
  const [dirty, setDirty] = useState(false);
  /** Apply real editor transactions to the test's controlled document. */
  function applyEdits(edits: TextEdit[], before: string): void {
    const after = [...edits].sort((a, b) => b.range.start - a.range.start).reduce((value, edit) => value.slice(0, edit.range.start) + edit.text + value.slice(edit.range.end), before);
    setText(after); setDirty(true);
  }
  return <>
    <CodeMirrorEditor livePreview value={text} ariaLabel={t("{{value0}}の{{value1}}エディタ", { value0: "/日本語/本文.md", value1: "Markdown" })} testId="locale-editor" onGuiEdits={applyEdits} initialSelection={{ anchor: 1, head: 3 }} />
    <output data-testid="locale-dirty">{dirty ? t("未保存") : t("保存済み")}</output>
    <SettingsPanel theme="light" onTheme={() => {}} configPath="" configError={null} onConfigPath={() => {}} onApplyConfig={() => {}} applyingConfig={false} currentConfig={null} onClose={() => {}} languagePreference={language} onLanguagePreference={onLanguage} />
  </>;
}

/** Keep the provider and its workspace children mounted as the language changes. */
function EditingHarness() {
  const [language, setLanguage] = useState<Language>("ja-JP");
  return <I18nProvider language={language} createTranslator={createTranslator}><EditingSurface language={language} onLanguage={(next) => setLanguage(next === "system" ? "ja-JP" : next)} /></I18nProvider>;
}

describe("language switching", () => {
  it("retranslates a visible generated notice while preserving opaque detail text", () => {
    const notice = { id: 1, kind: "info" as const, message: localizedMessage("画像を挿入しました（{{value0}}）。", { value0: "/日本語/画像.png" }) };
    const view = render(<I18nProvider language="ja-JP" createTranslator={createTranslator}><NotificationToast notice={notice} onDismiss={() => {}} /></I18nProvider>);
    expect(screen.getByRole("status")).toHaveTextContent("画像を挿入しました（/日本語/画像.png）。");
    view.rerender(<I18nProvider language="en-US" createTranslator={createTranslator}><NotificationToast notice={notice} onDismiss={() => {}} /></I18nProvider>);
    expect(screen.getByRole("status")).toHaveTextContent("Image inserted (/日本語/画像.png).");
  });
  it("renders English settings and aria without recreating the dirty editor or changing its selection", () => {
    render(<EditingHarness />);
    const editorDOM = screen.getByTestId("locale-editor").querySelector<HTMLElement>(".cm-editor")!;
    const editor = EditorView.findFromDOM(editorDOM)!;
    act(() => editor.dispatch({ changes: { from: 3, to: 3, insert: "未保存" }, selection: { anchor: 2, head: 5 } }));
    const edited = editor.state.doc.toString();
    fireEvent.change(screen.getByLabelText("言語"), { target: { value: "en-US" } });
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeVisible();
    expect(screen.getByLabelText("Search settings")).toBeVisible();
    expect(screen.getByLabelText("Color theme")).toBeVisible();
    expect(screen.getByTestId("locale-dirty")).toHaveTextContent("Unsaved");
    expect(editor.contentDOM).toHaveAttribute("aria-label", "Markdown editor for /日本語/本文.md");
    expect(EditorView.findFromDOM(editorDOM)).toBe(editor);
    for (const language of ["ja-JP-x-kansai", "ja-JP-x-tokushima", "ja-JP", "en-US"]) {
      fireEvent.change(screen.queryByLabelText("Language") ?? screen.getByLabelText("言語"), { target: { value: language } });
      expect(EditorView.findFromDOM(editorDOM)).toBe(editor);
      expect(editor.state.doc.toString()).toBe(edited);
      expect({ anchor: editor.state.selection.main.anchor, head: editor.state.selection.main.head }).toEqual({ anchor: 2, head: 5 });
    }
  });

  it("keeps the active AI request, user input and response data across language switches", async () => {
    let handler!: (event: AiStreamEvent) => void;
    /** Record unexpected cancellation of the ongoing chat. */
    const stop = vi.fn(async () => undefined);
    /** Capture the real panel's streaming callback through its injected gateway. */
    const start = vi.fn<AiGateway["startPrompt"]>(async (_request, onEvent) => { handler = onEvent; return { runId: "locale-run", stop }; });
    const panel = <AiPanel startPrompt={start} contexts={[{ documentId: "doc", revision: 1, ranges: [{ start: 0, end: 2 }], text: "本文" }]} staging={{ copyId: "copy" }} contextLabels={{ doc: "/日本語/本文.md" }} />;
    const view = render(<I18nProvider language="ja-JP" createTranslator={createTranslator}>{panel}</I18nProvider>);
    fireEvent.change(screen.getByLabelText("プロンプト"), { target: { value: "保存しました。という日本語を残す" } });
    fireEvent.click(screen.getByRole("button", { name: "送信" }));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText("プロンプト"), { target: { value: "次の未送信の入力" } });
    for (const language of ["en-US", "ja-JP-x-kansai", "ja-JP-x-tokushima", "en-US"] as Language[]) view.rerender(<I18nProvider language={language} createTranslator={createTranslator}>{panel}</I18nProvider>);
    expect(screen.getByLabelText("Prompt")).toHaveValue("次の未送信の入力");
    expect(screen.getByText("保存しました。という日本語を残す")).toBeVisible();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
    expect(start).toHaveBeenCalledTimes(1); expect(stop).not.toHaveBeenCalled();
    act(() => handler({ type: "usage", payload: { runId: "locale-run", usage: { provider: "acp", runId: "locale-run", sessionId: "session", source: "usage_update", scope: "session", used: 12, size: 100, receivedMs: 1 } } }));
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
    expect(start).toHaveBeenCalledTimes(1); expect(stop).not.toHaveBeenCalled();
    act(() => handler({ type: "done", payload: { runId: "locale-run", proposal: { text: "保存しました。というAIの回答", baseContexts: [] }, sent: [] } }));
    expect(await screen.findByText("保存しました。というAIの回答")).toBeVisible();
    expect(start.mock.calls[0][0].prompt).toBe("保存しました。という日本語を残す");
  });
});
