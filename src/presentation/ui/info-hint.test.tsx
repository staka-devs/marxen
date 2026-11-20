import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { InfoHint } from "./info-hint";

it("keeps help text hidden until the info icon is pressed, and closes on Escape", () => {
  render(<InfoHint text="OS の資格情報ストアに保存します。" />);
  const button = screen.getByRole("button", { name: "補足" });
  const tip = screen.getByRole("tooltip");
  expect(tip).toHaveClass("sr-only");
  expect(button).toHaveAccessibleDescription("OS の資格情報ストアに保存します。");
  fireEvent.click(button);
  expect(tip).not.toHaveClass("sr-only");
  expect(button).toHaveAttribute("aria-expanded", "true");
  fireEvent.keyDown(button, { key: "Escape" });
  expect(tip).toHaveClass("sr-only");
});
