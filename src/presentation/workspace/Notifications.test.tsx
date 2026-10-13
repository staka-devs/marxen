import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { NotificationToast, WorkspaceDialog } from "./Notifications";
import { NOTIFICATION_POSITIONS } from "../../domain/editor-preferences";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it.each(NOTIFICATION_POSITIONS)("anchors normal, error and recovery notifications at %s without editor focus changes", (position) => {
  const editor = document.createElement("textarea");
  document.body.append(editor); editor.focus();
  const before = editor.getBoundingClientRect();
  const dismiss = vi.fn();
  const view = render(<NotificationToast position={position} notice={{ id: 1, kind: "info", message: "保存しました。" }} onDismiss={dismiss} />);
  const notice = screen.getByRole("status");
  expect(notice).toHaveAttribute("data-position", position);
  expect(notice).toHaveClass("fixed", position.startsWith("top") ? "top-8" : "bottom-8");
  expect(notice).toHaveClass(position.endsWith("left") ? "left-4" : position.endsWith("center") ? "left-1/2" : "right-4");
  expect(document.activeElement).toBe(editor);
  view.rerender(<NotificationToast position={position} notice={{ id: 2, kind: "error", message: "保存できませんでした。" }} onDismiss={dismiss} />);
  expect(screen.getByRole("alert")).toHaveAttribute("data-position", position);
  view.rerender(<NotificationToast position={position} raised testId="recovery-toast" notice={{ id: 3, kind: "info", message: "未保存の文書を復元" }} actions={<button>復元</button>} onDismiss={dismiss} />);
  expect(screen.getByTestId("recovery-toast")).toHaveClass(position.startsWith("top") ? "top-32" : "bottom-32");
  expect(document.activeElement).toBe(editor);
  // jsdom checks DOM/portal behavior; browser geometry is verified separately.
  expect(editor.getBoundingClientRect()).toEqual(before);
  screen.getByRole("button", { name: "通知を閉じる" }).focus();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "通知を閉じる" }));
  fireEvent.click(document.activeElement!); expect(dismiss).toHaveBeenCalledWith(3);
  view.unmount(); editor.remove();
});

it("defaults to bottom-right and follows position changes for the current occurrence", () => {
  const props = { notice: { id: 4, kind: "success" as const, message: "保存しました。" as const }, onDismiss: vi.fn() };
  const view = render(<NotificationToast {...props} />);
  expect(screen.getByRole("status")).toHaveClass("bottom-8", "right-4");
  view.rerender(<NotificationToast {...props} position="top-center" />);
  expect(screen.getByRole("status")).toHaveClass("top-8", "left-1/2", "-translate-x-1/2");
  expect(screen.getByRole("status")).not.toHaveClass("bottom-8", "right-4");
});

it("does not move focus and dismisses only the current success occurrence", () => {
  vi.useFakeTimers();
  const dismiss = vi.fn();
  const editor = document.createElement("textarea");
  document.body.append(editor); editor.focus();
  const view = render(<NotificationToast notice={{ id: 1, message: "保存しました。", kind: "success" }} onDismiss={dismiss} />);
  expect(document.activeElement).toBe(editor);
  expect(screen.getByRole("status").parentElement).toBe(document.body);
  vi.advanceTimersByTime(3_000);
  view.rerender(<NotificationToast notice={{ id: 2, message: "保存しました。", kind: "success" }} onDismiss={dismiss} />);
  vi.advanceTimersByTime(1_000); expect(dismiss).not.toHaveBeenCalled();
  vi.advanceTimersByTime(3_000); expect(dismiss).toHaveBeenCalledExactlyOnceWith(2);
  view.unmount(); editor.remove();
});

it("keeps errors until explicitly dismissed", () => {
  vi.useFakeTimers(); const dismiss = vi.fn();
  render(<NotificationToast notice={{ id: 3, message: "保存できませんでした。", kind: "error" }} onDismiss={dismiss} />);
  vi.advanceTimersByTime(20_000); expect(dismiss).not.toHaveBeenCalled();
  expect(screen.getByRole("alert")).toHaveTextContent("保存できませんでした。");
  fireEvent.click(screen.getByRole("button", { name: "通知を閉じる" }));
  expect(dismiss).toHaveBeenCalledExactlyOnceWith(3);
});

it("focuses the decision rather than a destructive action and restores focus", () => {
  const dismiss = vi.fn(), discard = vi.fn();
  const editor = document.createElement("textarea"); document.body.append(editor); editor.focus();
  const view = render(<WorkspaceDialog label="未保存の文書を復元" onDismiss={dismiss}><button onClick={discard}>破棄する</button></WorkspaceDialog>);
  const dialog = screen.getByRole("dialog", { name: "未保存の文書を復元" });
  expect(dialog).toHaveAttribute("aria-modal", "true"); expect(document.activeElement).toBe(dialog);
  fireEvent.keyDown(dialog, { key: "Escape" }); expect(dismiss).toHaveBeenCalledOnce(); expect(discard).not.toHaveBeenCalled();
  view.unmount(); expect(document.activeElement).toBe(editor); editor.remove();
});

it("wraps Tab through the dialog controls", () => {
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue({ length: 1 } as DOMRectList);
  render(<WorkspaceDialog label="閉じる確認" onDismiss={() => {}}><button>保存する</button><button>キャンセル</button></WorkspaceDialog>);
  const dialog = screen.getByRole("dialog"), first = screen.getByRole("button", { name: "閉じる確認を閉じる" }), last = screen.getByRole("button", { name: "キャンセル" });
  fireEvent.keyDown(dialog, { key: "Tab" }); expect(document.activeElement).toBe(first);
  fireEvent.keyDown(first, { key: "Tab", shiftKey: true }); expect(document.activeElement).toBe(last);
  fireEvent.keyDown(last, { key: "Tab" }); expect(document.activeElement).toBe(first);
});
