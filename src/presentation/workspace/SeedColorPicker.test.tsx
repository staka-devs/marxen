import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SeedColorPicker } from "./SeedColorPicker";

afterEach(cleanup);

it("picks a hue, then one of its shades, or a custom color", () => {
  const onChange = vi.fn();
  const { rerender } = render(<SeedColorPicker value="#1976d2" onChange={onChange} />);
  expect(screen.getByRole("button", { name: "ブルー" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: "ブルー 700" })).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(screen.getByRole("button", { name: "ティール" }));
  expect(onChange).toHaveBeenLastCalledWith("#009688");
  rerender(<SeedColorPicker value="#009688" onChange={onChange} />);
  expect(screen.getAllByRole("button", { name: /^ティール / })).toHaveLength(14);
  fireEvent.click(screen.getByRole("button", { name: "ティール A400" }));
  expect(onChange).toHaveBeenLastCalledWith("#1de9b6");
  fireEvent.change(screen.getByLabelText("任意の色"), { target: { value: "#123456" } });
  expect(onChange).toHaveBeenLastCalledWith("#123456");
});
