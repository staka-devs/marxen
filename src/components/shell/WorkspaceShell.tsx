import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CodeMirrorEditor, type EditorSelection } from "../editor/CodeMirrorEditor";
import { MarkdownPreview } from "../preview/MarkdownPreview";
import { FileTree } from "../workspace/FileTree";
import { Tabs } from "../workspace/Tabs";
import { QuickOpen } from "../workspace/QuickOpen";
import { SearchPanel } from "../workspace/SearchPanel";
import { Outline } from "../workspace/Outline";
import { CommandPalette, type PaletteCommand } from "../workspace/CommandPalette";
import { SettingsPanel } from "../workspace/SettingsPanel";
import { RawGridView } from "../workspace/RawGridView";
import { GuiToolbar } from "../workspace/GuiToolbar";
import { readRuntimeStatus } from "../../lib/runtime";
import type { RuntimeStatus } from "../../shared/contracts";
import type { TextEdit } from "../../shared/contracts";
import {
  formatRange,
  insertImage,
  insertLink,
  insertTable,
  tableAddColumn,
  tableAddRow,
  toggleCheckbox,
  type FormatKind,
} from "../../lib/markdown-gui";
import { SAMPLE_WORKSPACE, type ThemeId, type WorkspaceFile } from "../../lib/workspace";
import { READONLY_MESSAGE, createTransport, isDesktop, type DocumentTransport } from "../../lib/document-client";

export type ViewMode = "live" | "source" | "read" | "split";

interface DocState {
  text: string;
  revision: number;
  dirty: boolean;
  history: string[];
}

function docIdForIndex(index: number): string {
  return `workspace-file-${index}`;
}

function initialDocs(): { docs: Record<string, DocState>; order: string[] } {
  const docs: Record<string, DocState> = {};
  const order: string[] = [];
  for (const file of SAMPLE_WORKSPACE) {
    docs[file.path] = { text: file.text, revision: 0, dirty: false, history: [file.text] };
    order.push(file.path);
  }
  return { docs, order };
}

const MODE_LABEL: Record<ViewMode, string> = {
  live: "ライブ",
  source: "原文",
  read: "閲覧",
  split: "分割",
};

export function WorkspaceShell() {
  const init = useMemo(initialDocs, []);
  const [docs, setDocs] = useState<Record<string, DocState>>(init.docs);
  const [order] = useState<string[]>(init.order);
  const [tabs, setTabs] = useState<string[]>([init.order[0]]);
  const [activePath, setActivePath] = useState<string>(init.order[0]);
  const [viewMode, setViewMode] = useState<ViewMode>("live");
  const [showRaw, setShowRaw] = useState(false);
  const [theme, setTheme] = useState<ThemeId>("light");
  const [quickOpen, setQuickOpen] = useState(false);
  const [palette, setPalette] = useState(false);
  const [settings, setSettings] = useState(false);
  const [configPath, setConfigPath] = useState("");
  const [selections, setSelections] = useState<Record<string, EditorSelection>>({});
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [vimMode, setVimMode] = useState("normal");
  const [notice, setNotice] = useState<string | null>(null);
  const [desktop] = useState(() => isDesktop());
  const transportRef = useRef<DocumentTransport | null>(null);
  if (!transportRef.current) transportRef.current = createTransport();
  const docsRef = useRef(docs);
  docsRef.current = docs;
  const activeRef = useRef(activePath);
  activeRef.current = activePath;

  useEffect(() => {
    let active = true;
    readRuntimeStatus()
      .then((status) => {
        if (active) setRuntime(status);
      })
      .catch(() => {
        if (active) setRuntime({ contractVersion: 1, connection: "error", detail: "接続状態を取得できません。" });
      });
    return () => {
      active = false;
    };
  }, []);

  // Desktop single-actor sync: open the active file on switch (best-effort).
  // Multi-file tabs stay in the frontend until Issue #4 workspace commands land.
  // Issue #4 owns all Rust IPC; no new commands are added here.
  useEffect(() => {
    if (!desktop) return;
    const index = order.indexOf(activePath);
    const current = docsRef.current[activePath];
    if (!current) return;
    transportRef.current
      ?.openDocument(docIdForIndex(Math.max(0, index)), current.text)
      .then((snapshot) => {
        setDocs((prev) => ({
          ...prev,
          [activePath]: { text: snapshot.text, revision: snapshot.revision, dirty: snapshot.dirty, history: [snapshot.text] },
        }));
        transportRef.current
          ?.fetchMode()
          .then((mode) => setVimMode(mode.mode))
          .catch(() => undefined);
      })
      .catch((cause: unknown) => setNotice(cause instanceof Error ? cause.message : String(cause)));
  }, [activePath, desktop, order]);

  const active = docs[activePath];

  // Real Neovim only: browser demo is read-only and never bumps revisions or
  // simulates save success. GUI edits commit ranges/revisions via the actor.
  const applyEdits = useCallback(
    async (path: string, edits: TextEdit[]) => {
      const current = docsRef.current[path];
      if (!current || edits.length === 0) return;
      if (!desktop) {
        setNotice(READONLY_MESSAGE);
        return;
      }
      const index = order.indexOf(path);
      try {
        const next = await transportRef.current?.applyGuiEdits(docIdForIndex(Math.max(0, index)), current.revision, edits);
        if (!next) return;
        setDocs((prev) => ({
          ...prev,
          [path]: { text: next.text, revision: next.revision, dirty: next.dirty, history: [...(prev[path]?.history ?? [current.text]), next.text] },
        }));
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        if (/StaleRevision|contract:/.test(message)) {
          try {
            const latest = await transportRef.current?.fetchSnapshot();
            if (latest) {
              setDocs((prev) => ({ ...prev, [path]: { text: latest.text, revision: latest.revision, dirty: latest.dirty, history: [latest.text] } }));
              setNotice("競合を検出しました。最新の原文に再同期しました。");
              return;
            }
          } catch {
            // fall through to notice
          }
        }
        setNotice(message);
      }
    },
    [desktop, order],
  );

  const openPath = useCallback((path: string) => {
    setTabs((prev) => (prev.includes(path) ? prev : [...prev, path]));
    setActivePath(path);
  }, []);

  const closeTab = useCallback((path: string) => {
    setTabs((prev) => {
      const next = prev.filter((item) => item !== path);
      if (activeRef.current === path && next.length > 0) setActivePath(next[next.length - 1]);
      return next;
    });
  }, []);

  const handleSelection = useCallback(
    (path: string, selection: EditorSelection) => {
      setSelections((prev) => ({ ...prev, [path]: selection }));
      if (!desktop) return;
      const current = docsRef.current[path];
      if (!current) return;
      const index = order.indexOf(path);
      transportRef.current
        ?.reportCursor({ documentId: docIdForIndex(Math.max(0, index)), revision: current.revision, anchor: selection.anchor, head: selection.head })
        .catch(() => undefined);
    },
    [desktop, order],
  );

  const guiAtSelection = useCallback(
    (fn: (text: string, anchor: number, head: number) => TextEdit[]) => {
      if (!desktop) {
        setNotice(READONLY_MESSAGE);
        return;
      }
      const current = docsRef.current[activeRef.current];
      if (!current) return;
      const sel = selections[activeRef.current] ?? { anchor: 0, head: 0 };
      const anchor = Math.min(sel.anchor, current.text.length);
      const head = Math.min(sel.head, current.text.length);
      const start = Math.min(anchor, head);
      const end = Math.max(anchor, head);
      void applyEdits(activeRef.current, fn(current.text, start, end));
    },
    [applyEdits, desktop, selections],
  );

  const handleUndo = useCallback(async () => {
    if (!desktop) {
      setNotice(READONLY_MESSAGE);
      return;
    }
    const path = activeRef.current;
    const current = docsRef.current[path];
    if (!current) return;
    try {
      const next = await transportRef.current?.undoDocument();
      if (next) {
        setDocs((prev) => ({ ...prev, [path]: { text: next.text, revision: next.revision, dirty: next.dirty, history: [...(prev[path]?.history ?? []), next.text] } }));
      }
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause));
    }
  }, [desktop]);

  const handleSave = useCallback(async () => {
    if (!desktop) {
      setNotice(READONLY_MESSAGE);
      return;
    }
    const path = activeRef.current;
    const current = docsRef.current[path];
    if (!current) return;
    const index = order.indexOf(path);
    try {
      await transportRef.current?.saveDocument(docIdForIndex(Math.max(0, index)), current.revision);
      setDocs((prev) => ({ ...prev, [path]: { ...current, dirty: false } }));
      setNotice("保存しました。");
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause));
    }
  }, [desktop, order]);

  const filesForSearch: WorkspaceFile[] = useMemo(
    () => order.map((path) => ({ path, text: docs[path]?.text ?? "" })),
    [order, docs],
  );

  const commands: PaletteCommand[] = useMemo(
    () => [
      { id: "view-live", label: "表示: ライブにする" },
      { id: "view-source", label: "表示: 原文にする" },
      { id: "view-read", label: "表示: 閲覧にする" },
      { id: "view-split", label: "表示: 分割にする" },
      { id: "file-save", label: "ファイル: 保存する" },
      { id: "edit-undo", label: "編集: 元に戻す" },
      { id: "palette-quickopen", label: "移動: ファイルをすばやく開く" },
      { id: "palette-raw", label: "表示: Neovim 原文ビューを切り替える" },
      { id: "palette-settings", label: "設定: 設定を開く" },
    ],
    [],
  );

  const runCommand = useCallback(
    (id: string) => {
      if (id === "view-live") setViewMode("live");
      else if (id === "view-source") setViewMode("source");
      else if (id === "view-read") setViewMode("read");
      else if (id === "view-split") setViewMode("split");
      else if (id === "file-save") void handleSave();
      else if (id === "edit-undo") void handleUndo();
      else if (id === "palette-quickopen") setQuickOpen(true);
      else if (id === "palette-raw") setShowRaw((value) => !value);
      else if (id === "palette-settings") setSettings(true);
    },
    [handleSave, handleUndo],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.key.toLowerCase() === "p" && !event.shiftKey) {
        event.preventDefault();
        setQuickOpen((value) => !value);
      } else if (mod && event.key.toLowerCase() === "p" && event.shiftKey) {
        event.preventDefault();
        setPalette((value) => !value);
      } else if (mod && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void handleSave();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleSave]);

  if (!active) return null;

  return (
    <div data-theme={theme} data-testid="workspace-shell" className="flex min-h-screen bg-background text-foreground">
      <aside className="hidden w-64 shrink-0 flex-col gap-4 border-r border-border bg-card/50 py-4 md:flex" aria-label="サイドバー">
        <FileTree files={order} active={activePath} onOpen={openPath} />
        <SearchPanel files={filesForSearch} onJump={(path: string) => openPath(path)} />
        <Outline text={active.text} onJump={() => undefined} />
      </aside>

      <div className="relative flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
          <div role="group" aria-label="表示モード" className="flex gap-1">
            {(Object.keys(MODE_LABEL) as ViewMode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setViewMode(mode)}
                aria-pressed={viewMode === mode}
                className={`rounded-md px-3 py-1.5 text-sm ${viewMode === mode ? "bg-primary text-primary-foreground" : "border border-border"}`}
              >
                {MODE_LABEL[mode]}
              </button>
            ))}
          </div>
          <button type="button" onClick={() => setShowRaw((value) => !value)} aria-pressed={showRaw} className="rounded-md border border-border px-3 py-1.5 text-sm">
            原文ビュー
          </button>
          <button type="button" onClick={() => setQuickOpen(true)} className="rounded-md border border-border px-3 py-1.5 text-sm">
            クイックオープン
          </button>
          <button type="button" onClick={() => setPalette(true)} className="rounded-md border border-border px-3 py-1.5 text-sm">
            コマンド
          </button>
          <button type="button" onClick={() => setSettings(true)} className="rounded-md border border-border px-3 py-1.5 text-sm">
            設定
          </button>
          <span role="status" className="ml-auto text-xs text-muted-foreground">
            {runtime ? (runtime.connection === "disconnected" ? "Neovim 未接続" : runtime.connection === "connected" ? "Neovim 接続済み" : runtime.detail) : "接続状態を確認中…"}
          </span>
        </header>

        <div className="border-b border-border px-4 pt-2">
          <Tabs tabs={tabs} active={activePath} dirty={Object.fromEntries(Object.entries(docs).map(([path, doc]) => [path, doc.dirty]))} onSelect={setActivePath} onClose={closeTab} />
        </div>

        <div className="space-y-3 px-4 py-3">
          <GuiToolbar
            onFormat={(kind: FormatKind) => guiAtSelection((text, start, end) => formatRange(text, start, end, kind))}
            onCheckbox={() => {
              if (!desktop) {
                setNotice(READONLY_MESSAGE);
                return;
              }
              const current = docsRef.current[activeRef.current];
              if (!current) return;
              const sel = selections[activeRef.current] ?? { anchor: 0, head: 0 };
              void applyEdits(activeRef.current, toggleCheckbox(current.text, Math.min(sel.head, current.text.length)));
            }}
            onTable={() => {
              if (!desktop) {
                setNotice(READONLY_MESSAGE);
                return;
              }
              const current = docsRef.current[activeRef.current];
              if (!current) return;
              const sel = selections[activeRef.current] ?? { anchor: 0, head: 0 };
              void applyEdits(activeRef.current, insertTable(Math.min(sel.head, current.text.length), 2, 2));
            }}
            onTableRow={() => {
              if (!desktop) {
                setNotice(READONLY_MESSAGE);
                return;
              }
              const current = docsRef.current[activeRef.current];
              if (!current) return;
              const sel = selections[activeRef.current] ?? { anchor: 0, head: 0 };
              try {
                void applyEdits(activeRef.current, tableAddRow(current.text, Math.min(sel.head, current.text.length)));
              } catch (cause) {
                setNotice(cause instanceof Error ? cause.message : String(cause));
              }
            }}
            onTableColumn={() => {
              if (!desktop) {
                setNotice(READONLY_MESSAGE);
                return;
              }
              const current = docsRef.current[activeRef.current];
              if (!current) return;
              const sel = selections[activeRef.current] ?? { anchor: 0, head: 0 };
              try {
                void applyEdits(activeRef.current, tableAddColumn(current.text, Math.min(sel.head, current.text.length)));
              } catch (cause) {
                setNotice(cause instanceof Error ? cause.message : String(cause));
              }
            }}
            onLink={() => guiAtSelection((text, start, end) => insertLink(text, start, end, "https://example.com"))}
            onImage={() => guiAtSelection((text, start, end) => insertImage(text, start, end, "images/paste.png"))}
            onUndo={() => void handleUndo()}
            canUndo={active.history.length > 1}
            vimMode={vimMode === "normal" ? "ノーマル" : vimMode}
            disabled={!desktop}
          />
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span data-testid="revision">リビジョン {active.revision}</span>
            <span data-testid="dirty">{active.dirty ? "未保存" : "保存済み"}</span>
            <button type="button" onClick={() => void handleSave()} disabled={!desktop} title={desktop ? undefined : READONLY_MESSAGE} className="rounded-md border border-border px-3 py-1 text-xs disabled:opacity-50">
              保存
            </button>
            {!desktop && <span data-testid="readonly-note">ブラウザ表示は読み取り専用です</span>}
            {notice && (
              <span role="alert" className="rounded-md border border-border px-2 py-1">
                {notice}
              </span>
            )}
          </div>
        </div>

        <main className="grid min-h-0 flex-1 gap-3 px-4 pb-4 md:grid-cols-2" aria-label="編集領域">
          {/* Primary editor stays mounted across live/source/split to retain scroll/cursor. */}
          <div className={viewMode === "read" ? "hidden" : "min-h-80"} aria-hidden={viewMode === "read"}>
            <CodeMirrorEditor
              key={`primary-${activePath}`}
              value={active.text}
              editable={desktop}
              ariaLabel={`${activePath}の原文エディタ`}
              testId="editor-primary"
              initialSelection={selections[activePath] ?? null}
              onGuiEdits={(edits) => void applyEdits(activePath, edits)}
              onSelectionChange={(selection) => handleSelection(activePath, selection)}
            />
          </div>
          {viewMode === "live" && (
            <div className="min-h-80">
              <MarkdownPreview text={active.text} />
            </div>
          )}
          {viewMode === "read" && (
            <div className="min-h-80 md:col-span-2">
              <MarkdownPreview text={active.text} />
            </div>
          )}
          {viewMode === "split" && (
            <div className="min-h-80">
              <CodeMirrorEditor
                key={`secondary-${activePath}`}
                value={active.text}
                editable={desktop}
                ariaLabel={`${activePath}の原文エディタ（分割右）`}
                testId="editor-secondary"
                initialSelection={selections[activePath] ?? null}
                onGuiEdits={(edits) => void applyEdits(activePath, edits)}
                onSelectionChange={(selection) => handleSelection(activePath, selection)}
              />
            </div>
          )}
          {viewMode === "source" && (
            <div className="hidden min-h-80 md:block" aria-label="原文メモ">
              <p className="rounded-lg border border-dashed border-border p-4 text-xs leading-6 text-muted-foreground">
                原文モードではエディタのみを表示します。表示基準の移動（折り返し行の上下・行頭末）はエディタ既定に従い、単語・テキストオブジェクト・マクロなど原文基準の操作は実
                Neovim が所有します。ユーザーマッピングを上書きしません。
              </p>
            </div>
          )}
        </main>

        {showRaw && (
          <div className="px-4 pb-4">
            <RawGridView text={active.text} />
          </div>
        )}

        <footer className="flex flex-wrap gap-x-4 gap-y-1 border-t border-border px-4 py-2 text-xs text-muted-foreground">
          <span>{activePath}</span>
          <span>IME は確定のみ送信（編集中の未確定文は送らない）</span>
          <span>{desktop ? "GUI 編集は範囲パッチで Neovim へ" : "ブラウザ表示は読み取り専用です"}</span>
        </footer>

        <QuickOpen open={quickOpen} paths={order} label="クイックオープン" testId="quick-open" onSelect={openPath} onClose={() => setQuickOpen(false)} />
        <CommandPalette open={palette} commands={commands} onRun={runCommand} onClose={() => setPalette(false)} />
        {settings && (
          <SettingsPanel
            theme={theme}
            onTheme={setTheme}
            configPath={configPath}
            configError={null}
            onConfigPath={setConfigPath}
            onClose={() => setSettings(false)}
          />
        )}
      </div>
    </div>
  );
}
