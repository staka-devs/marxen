import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import App from "../../App";
import { WORKSPACE_IMAGE_DRAG } from "../../domain/workspace-files";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  /** Desktop transport flag for shell tests. */
  isTauri: () => true,
}));
vi.mock("@tauri-apps/api/event", () => ({
  /** Event subscription resolving to a no-op unlisten. */
  listen: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock("@tauri-apps/api/webview", () => ({
  /** Webview stub suppressing native drops in shell tests. */
  getCurrentWebview: () => ({
    /** Native drop subscription resolving to a no-op unlisten. */
    onDragDropEvent: () => Promise.resolve(() => {}),
  }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("../../infrastructure/tauri/runtime-client", () => {
  /** Fixed connected status for registry-backed shell tests. */
  const readRuntimeStatus = () => Promise.resolve({ contractVersion: 1, connection: "connected", detail: "test registry" });
  return {
    readRuntimeStatus,
    /** Gateway delegating to the fixed connected status. */
    runtimeGateway: {
      /** Status reader delegating to the fixed status. */
      readStatus: readRuntimeStatus,
    },
  };
});
const mockInvoke = vi.mocked(invoke);
let text = "😀Markdown"; let revision = 0;
const image = { mime: "image/png", bytes: [137, 80, 78, 71] };
beforeEach(() => {
  vi.clearAllMocks(); text = "😀Markdown"; revision = 0;
  vi.stubGlobal("URL", Object.assign(URL, {
    /** Blob URL stub for image viewer tests. */
    createObjectURL: vi.fn(() => "blob:test-image"),
    /** Blob URL cleanup stub for image viewer tests. */
    revokeObjectURL: vi.fn(),
  }));
  mockInvoke.mockImplementation((command, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    switch (command) {
      case "open_workspace": return Promise.resolve({ root: a.path });
      case "list_workspace": return Promise.resolve([
        { path: "a.md", name: "a.md", directory: false, markdown: true, kind: "markdown" },
        { path: "notes.txt", name: "notes.txt", directory: false, markdown: false, kind: "text" },
        { path: "photo.png", name: "photo.png", directory: false, markdown: false, kind: "image" },
        { path: "binary.exe", name: "binary.exe", directory: false, markdown: false },
      ]);
      case "list_documents": case "list_recovery": case "poll_workspace_events": return Promise.resolve([]);
      case "open_markdown": return Promise.resolve({ path: "a.md", snapshot: { documentId: "doc_a", revision, text, dirty: revision > 0 } });
      case "open_text_file": return Promise.resolve({ path: "notes.txt", snapshot: { documentId: "doc_text", revision: 0, text: "# literal **text**", dirty: false } });
      case "load_workspace_image": return Promise.resolve(image);
      case "fetch_mode": return Promise.resolve({ documentId: a.documentId, revision: 0, mode: "insert" });
      case "fetch_cursor": case "report_cursor": return Promise.resolve({ documentId: a.documentId, revision: a.revision ?? 0, anchor: 2, head: 2 });
      case "fetch_config": return Promise.resolve({ path: null, errors: [] });
      case "fetch_snapshot": return Promise.resolve({ documentId: a.documentId, revision, text, dirty: revision > 0 });
      case "save_document": return Promise.resolve({ documentId: a.documentId, revision: a.baseRevision, dirty: false, path: "notes.txt" });
      case "insert_workspace_image": {
        const r = a.range as { start: number; end: number };
        expect(a.baseRevision).toBe(revision);
        text = text.slice(0, r.start) + "![](photo.png)" + text.slice(r.end); revision += 1;
        return Promise.resolve({ documentId: a.documentId, revision, text, dirty: true });
      }
      case "close_document": return Promise.resolve(true);
      default: return Promise.reject(new Error("unexpected command " + command));
    }
  });
});
/** Open the fake workspace through the manual folder input. */
async function openWorkspace() {
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "パスを入力する" }));
  fireEvent.change(screen.getByLabelText("開くフォルダーの絶対パス"), { target: { value: "C:/workspace" } });
  fireEvent.click(screen.getByRole("button", { name: "開く" }));
  await screen.findByRole("button", { name: "notes.txt" });
}
it("opens UTF-8 text in a source editor, keeps Markdown literal and saves the native document", async () => {
  await openWorkspace();
  fireEvent.click(screen.getByRole("button", { name: "a.md" }));
  await screen.findByTestId("editor-primary");
  fireEvent.change(screen.getByLabelText("表示モード"), { target: { value: "read" } });
  expect(screen.getByTestId("image-drop-zone")).not.toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "notes.txt" }));
  await waitFor(() => expect(screen.getByTestId("editor-primary")).toHaveTextContent("# literal **text**"));
  const editor = screen.getByTestId("editor-primary");
  expect(editor).toBeVisible();
  expect(screen.getByLabelText("表示モード")).toHaveValue("source");
  expect(screen.getByLabelText("表示モード")).toBeDisabled();
  expect(screen.queryByTestId("markdown-preview")).toBeNull();
  expect(screen.queryByRole("button", { name: "binary.exe" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("save_document", { documentId: "doc_text", baseRevision: 0 }));
});
it("opens an image tab with sizing controls and closes it without native document commands", async () => {
  await openWorkspace();
  fireEvent.click(screen.getByRole("button", { name: "photo.png" }));
  const viewer = await screen.findByTestId("image-viewer");
  const img = await within(viewer).findByRole("img");
  Object.defineProperties(img, { naturalWidth: { value: 600 }, naturalHeight: { value: 300 } });
  fireEvent.load(img);
  expect(viewer).toHaveTextContent("600 × 300");
  fireEvent.click(screen.getByLabelText("画像を拡大"));
  expect(viewer).toHaveTextContent("125%");
  expect(img).toHaveStyle({ width: "750px" });
  fireEvent.click(screen.getByLabelText("画像を領域に合わせる"));
  expect(viewer).toHaveTextContent("フィット");
  expect(within(screen.getByTestId("file-tree")).getByRole("button", { name: "photo.png" })).toHaveAttribute("aria-current", "true");
  expect(mockInvoke.mock.calls.some(([name]) => name === "open_markdown" || name === "open_text_file")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "photo.pngを閉じる" }));
  expect(screen.queryByTestId("image-viewer")).toBeNull();
  expect(mockInvoke.mock.calls.some(([name]) => name === "close_document")).toBe(false);
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:test-image");
});
it("routes an explorer image drop to revision-guarded Rust insertion without a GUI duplicate", async () => {
  await openWorkspace();
  fireEvent.click(screen.getByRole("button", { name: "a.md" }));
  await screen.findByTestId("editor-primary");
  await waitFor(() => expect(mockInvoke.mock.calls.some(([name]) => name === "fetch_cursor")).toBe(true));
  fireEvent.drop(screen.getByTestId("image-drop-zone"), {
    dataTransfer: {
      types: [WORKSPACE_IMAGE_DRAG],
      /** Return the dragged workspace image path. */
      getData: () => "photo.png",
      files: [],
    },
    clientX: 0,
    clientY: 0,
  });
  await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("insert_workspace_image", { documentId: "doc_a", baseRevision: 0, path: "photo.png", range: { start: 2, end: 2 } }));
  await waitFor(() => expect(screen.getByTestId("editor-primary")).toHaveTextContent("😀![](photo.png)Markdown"));
  expect(mockInvoke.mock.calls.filter(([name]) => name === "insert_workspace_image")).toHaveLength(1);
  expect(mockInvoke.mock.calls.some(([name]) => name === "apply_gui_edits")).toBe(false);
});



it("limits desktop quick-open to supported workspace files and opens its keyboard selection", async () => {
  await openWorkspace();
  fireEvent.keyDown(window, { key: "p", ctrlKey: true });
  const picker = await screen.findByTestId("quick-open");
  expect(within(picker).getAllByRole("option").map((item) => item.textContent)).toEqual(["a.md", "notes.txt", "photo.png"]);
  const input = within(picker).getByRole("combobox");
  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(screen.getByTestId("editor-primary")).toHaveTextContent("# literal **text**"));
  expect(screen.queryByTestId("quick-open")).toBeNull();
  expect(mockInvoke).toHaveBeenCalledWith("open_text_file", { path: "notes.txt" });
  const editor = screen.getByTestId("editor-primary").querySelector(".cm-content");
  await waitFor(() => expect(editor).toHaveFocus());
  const file = within(screen.getByTestId("file-tree")).getByRole("button", { name: "notes.txt" });
  file.focus();
  fireEvent.click(file);
  await waitFor(() => expect(editor).toHaveFocus());
  const tab = screen.getByRole("tab", { name: "notes.txt" });
  tab.focus();
  fireEvent.click(tab);
  await waitFor(() => expect(editor).toHaveFocus());
});
