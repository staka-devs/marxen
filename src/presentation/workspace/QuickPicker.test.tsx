import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { expect, it, vi } from "vitest";
import { QuickOpen } from "./QuickOpen";

interface FixtureProps {
  /** Receive selected file paths. */
  onSelect: (path: string) => void;
}

/** Open the picker from a real focusable trigger to verify keyboard restoration. */
function Fixture({ onSelect }: FixtureProps) {
  const [open, setOpen] = useState(false);
  return <><button type="button" onClick={() => setOpen(true)}>ファイルを探す</button><QuickOpen open={open} paths={["メモ/一.md", "資料/二.md"]} label="クイックオープン" testId="quick-open" onSelect={onSelect} onClose={() => setOpen(false)} /></>;
}

it("opens the highlighted result with arrows and Enter and restores trigger focus", () => {
  const selected = vi.fn(); render(<Fixture onSelect={selected} />);
  const trigger = screen.getByRole("button", { name: "ファイルを探す" }); trigger.focus(); fireEvent.click(trigger);
  const filter = screen.getByRole("combobox"); expect(filter).toHaveFocus();
  fireEvent.keyDown(filter, { key: "ArrowDown" }); fireEvent.keyDown(filter, { key: "Enter" });
  expect(selected).toHaveBeenCalledWith("資料/二.md"); expect(screen.queryByRole("dialog")).toBeNull(); expect(trigger).toHaveFocus();
});

it("dismisses with Escape, clears a previous filter on reopen, and never executes on dismissal", () => {
  const selected = vi.fn(); render(<Fixture onSelect={selected} />);
  const trigger = screen.getByRole("button", { name: "ファイルを探す" }); trigger.focus(); fireEvent.click(trigger);
  const filter = screen.getByRole("combobox"); fireEvent.change(filter, { target: { value: "一" } });
  expect(screen.getAllByRole("option")).toHaveLength(1); fireEvent.keyDown(filter, { key: "Escape" });
  expect(trigger).toHaveFocus(); fireEvent.click(trigger); expect(screen.getByRole("combobox")).toHaveValue(""); expect(screen.getAllByRole("option")).toHaveLength(2); expect(selected).not.toHaveBeenCalled();
});
