import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createConversation, createUserMessage, conversationTitle } from "../../domain/conversation/ai-conversation";
import { ChatHistory } from "./ChatHistory";

afterEach(cleanup);
describe("ChatHistory", () => {
  it("shows meaningful titles, hides abandoned empty chats, and opens the selected session", () => {
    const first = createConversation(); first.messages = [createUserMessage("Markdown の表を整えたい", "ask", [])];
    const active = createConversation();
    const abandoned = createConversation();
    const onSelect = vi.fn();
    const { container } = render(<ChatHistory conversations={[first, active, abandoned]} activeId={active.id} onSelect={onSelect} />);
    expect(screen.getByRole("searchbox")).toHaveFocus();
    expect(screen.getAllByRole("button")).toHaveLength(2);
    expect(container.textContent).not.toContain("conv_");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "markdown" } });
    expect(screen.getAllByRole("button")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /Markdown の表/ }));
    expect(onSelect).toHaveBeenCalledWith(first.id);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "存在しない文書" } });
    expect(screen.getByRole("status")).toHaveTextContent("一致するチャットがありません。");
  });
  it("normalizes title whitespace and truncates without breaking emoji", () => {
    const chat = createConversation();
    chat.messages = [createUserMessage("  表\n  を直す  ", "ask", [])];
    expect(conversationTitle(chat)).toBe("表 を直す");
    chat.messages = [createUserMessage("🦊".repeat(50), "ask", [])];
    expect(conversationTitle(chat)).toBe("🦊".repeat(48) + "…");
  });
});
