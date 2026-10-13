import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { NotificationToast, WorkspaceDialog } from "./Notifications";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

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
