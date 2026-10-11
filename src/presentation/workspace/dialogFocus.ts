/** Keep Tab navigation inside the visible controls of a modal dialog. */
export function trapDialogTab(event: Pick<KeyboardEvent, "key" | "shiftKey" | "preventDefault">, dialog: HTMLElement | null): void {
  if (event.key !== "Tab" || !dialog) return;
  const items = Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, a[href]')).filter((item) => item.getClientRects().length > 0);
  const first = items[0], last = items.at(-1);
  if (items.length === 0) { event.preventDefault(); dialog.focus(); }
  else if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) { event.preventDefault(); last?.focus(); }
  else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog)) { event.preventDefault(); first?.focus(); }
}
