import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChoiceMenu } from "./choice-menu";

afterEach(cleanup);
const choices = [
  { value: "a", label: "相談", description: "文章について相談" },
  { value: "b", label: "利用不可", disabled: true },
  { value: "c", label: "推敲", description: "選択した文章を整える" },
];
describe("ChoiceMenu", () => {
  it("searches labels and opaque IDs, exposes groups and commits only filtered keyboard choices", () => {
    const onChange = vi.fn();
    render(<ChoiceMenu label="Model" value="not-advertised" valueLabel="Retained model" valueIcon={<span data-testid="provider-icon" />} searchLabel="Search models" emptyLabel="No visible choices" onChange={onChange} choices={[{ value: "actual/a", label: "Alpha", group: "Agent", description: "actual/a", icon: <span data-testid="row-icon" /> }, { value: "actual/b", label: "Beta", group: "API" }]} />);
    const trigger = screen.getByRole("combobox", { name: "Model" });
    expect(trigger).toHaveTextContent("Retained model");
    fireEvent.click(trigger);
    const search = screen.getByRole("combobox", { name: "Search models" });
    expect(search).toHaveFocus();
    expect(screen.getByText("Agent")).toBeVisible(); expect(screen.getByTestId("row-icon")).toBeVisible();
    fireEvent.change(search, { target: { value: "actual/b" } });
    expect(screen.queryByRole("option", { name: /Alpha/ })).toBeNull();
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("actual/b"); expect(trigger).toHaveFocus();
    fireEvent.click(trigger); fireEvent.change(screen.getByRole("combobox", { name: "Search models" }), { target: { value: "missing" } });
    expect(screen.getByRole("status")).toHaveTextContent("No visible choices");
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search models" }), { key: "Enter" });
    expect(onChange).toHaveBeenCalledOnce();
  });
  it("keeps focus, skips disabled choices, and commits a keyboard choice", () => {
    const onChange = vi.fn();
    render(<ChoiceMenu label="種類" value="a" choices={choices} onChange={onChange} />);
    const trigger = screen.getByRole("combobox", { name: "種類" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(trigger).toHaveFocus();
    expect(screen.getByRole("option", { name: /相談/ })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(trigger).toHaveAttribute("aria-activedescendant", screen.getByRole("option", { name: /推敲/ }).id);
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("c");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(trigger).toHaveFocus();
  });
  it("inherits the workspace theme and dismisses without committing", () => {
    const onChange = vi.fn();
    render(<div data-theme="light"><ChoiceMenu label="種類" value="a" choices={choices} onChange={onChange} /><button>別の操作</button></div>);
    const trigger = screen.getByRole("combobox");
    fireEvent.click(trigger);
    expect(screen.getByRole("listbox").closest("[data-theme]")).toHaveAttribute("data-theme", "light");
    fireEvent.click(screen.getByRole("option", { name: "利用不可" }));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.click(trigger);
    fireEvent.pointerDown(screen.getByRole("button", { name: "別の操作" }));
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });
  it("closes on Tab and on becoming disabled", () => {
    const props = { label: "種類", value: "a", choices, onChange: vi.fn() };
    const { rerender } = render(<ChoiceMenu {...props} />);
    const trigger = screen.getByRole("combobox");
    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: "Tab" });
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.click(trigger);
    rerender(<ChoiceMenu {...props} disabled />);
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(trigger).toBeDisabled();
  });
});
