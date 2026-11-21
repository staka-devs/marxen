// Test helpers for the chat agent/model picker (test-only).
import { fireEvent, screen, within } from "@testing-library/react";

/** The compact picker trigger inside `scope` (the whole document by default). */
export function pickerTrigger(scope: HTMLElement = document.body): HTMLElement {
  return within(scope).getByRole("button", { name: "チャットの接続先とモデル" });
}

/** The open picker panel, opening it first when closed. */
export function openPicker(scope: HTMLElement = document.body): HTMLElement {
  const trigger = pickerTrigger(scope);
  if (trigger.getAttribute("aria-expanded") !== "true") fireEvent.click(trigger);
  return screen.getByRole("dialog", { name: "チャットの接続先とモデル" });
}

/** Switch the chat to a provider tab. */
export function chooseProvider(name: string, scope?: HTMLElement): void {
  fireEvent.click(within(openPicker(scope)).getByRole("tab", { name }));
}

/** Choose an advertised model. */
export function chooseModel(name: string, scope?: HTMLElement): void {
  fireEvent.click(within(openPicker(scope)).getByRole("option", { name }));
}

/** Choose an advertised reasoning effort. */
export function chooseEffort(name: string, scope?: HTMLElement): void {
  fireEvent.click(within(openPicker(scope)).getByRole("radio", { name }));
}
