import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AiPanel from "../ai-panel";
import type { AiStreamEvent, PromptContext, StagingTarget } from "../../contracts/ai-contracts";
import type { AiGateway } from "../../application/ports";

const mockStartPrompt = vi.fn<AiGateway["startPrompt"]>();

vi.mock("../ai-provider-settings", async (importOriginal) => ({
  ...await importOriginal<typeof import("../ai-provider-settings")>(),
  /** Mocked settings subview for agentic chat tests. */
  default: () => <div>接続設定 mock</div>,
}));

beforeEach(() => {
  vi.resetAllMocks();
  mockStartPrompt.mockReset();
  window.localStorage.clear();
});

const contexts: PromptContext[] = [
  { documentId: "doc_01", revision: 7, ranges: [{ start: 1, end: 3 }], text: "abc" },
];
const staging: StagingTarget = { copyId: "copy_01" };
const labels = { doc_01: "a.md" };

/**
 * Render the agent panel for tool assertions.
 */
function renderPanel() {
  return render(
    <AiPanel startPrompt={mockStartPrompt} contexts={contexts} staging={staging} contextLabels={labels} />,
  );
}

describe("agentic chat", () => {
  it("shows real tool, plan, and permission cards in order", async () => {
    let handler: ((event: AiStreamEvent) => void) | null = null;
    mockStartPrompt.mockImplementation(async (_request, onEvent) => {
      handler = onEvent;
      return { runId: "run_agentic", stop: vi.fn() };
    });
    renderPanel();
    fireEvent.change(screen.getByLabelText("プロンプト"), { target: { value: "直して" } });
    fireEvent.click(screen.getByRole("button", { name: "送信" }));
    await vi.waitFor(() => expect(handler).not.toBeNull());
    handler!({ type: "started", payload: { runId: "run_agentic" } });
    handler!({
      type: "plan",
      payload: {
        runId: "run_agentic",
        entries: [{ content: "Read", priority: "high", status: "pending" }],
      },
    });
    expect(await screen.findByTestId("plan-card")).toBeVisible();
    handler!({
      type: "tool_call",
      payload: {
        runId: "run_agentic",
        toolCall: { toolCallId: "call_1", title: "Reading file", kind: "read", status: "pending" },
      },
    });
    expect(await screen.findByTestId("tool-card-call_1")).toBeVisible();
    handler!({
      type: "tool_call_update",
      payload: { runId: "run_agentic", update: { toolCallId: "call_1", status: "in_progress" } },
    });
    handler!({
      type: "permission",
      payload: {
        runId: "run_agentic",
        requestId: "900",
        sessionId: "sess_1",
        toolCallId: "call_1",
        title: "mock tool",
        options: [
          { optionId: "mock_allow", name: "許可", kind: "allow_once" },
          { optionId: "mock_reject", name: "拒否", kind: "reject_once" },
        ],
      },
    });
    expect(await screen.findByTestId("permission-card-900")).toBeVisible();
    expect(screen.queryByText("copy_01")).not.toBeInTheDocument();
    expect(screen.queryByText("doc_01")).not.toBeInTheDocument();
  });

  it("marks unfinished tools cancelled once on cancellation", async () => {
    let handler: ((event: AiStreamEvent) => void) | null = null;
    mockStartPrompt.mockImplementation(async (_request, onEvent) => {
      handler = onEvent;
      return { runId: "run_cancel", stop: vi.fn() };
    });
    renderPanel();
    fireEvent.change(screen.getByLabelText("プロンプト"), { target: { value: "直して" } });
    fireEvent.click(screen.getByRole("button", { name: "送信" }));
    await vi.waitFor(() => expect(handler).not.toBeNull());
    handler!({ type: "started", payload: { runId: "run_cancel" } });
    handler!({
      type: "tool_call",
      payload: {
        runId: "run_cancel",
        toolCall: { toolCallId: "call_9", title: "Editing", kind: "edit", status: "in_progress" },
      },
    });
    expect(await screen.findByTestId("tool-card-call_9")).toBeVisible();
    handler!({ type: "cancelled", payload: { runId: "run_cancel" } });
    expect(await screen.findByText("取り消しました。")).toBeVisible();
  });

  it("shows ask readonly without fake file timeline", async () => {
    let handler: ((event: AiStreamEvent) => void) | null = null;
    mockStartPrompt.mockImplementation(async (_request, onEvent) => {
      handler = onEvent;
      return { runId: "run_ask", stop: vi.fn() };
    });
    renderPanel();
    fireEvent.click(screen.getByRole("combobox", { name: "モード" }));
    fireEvent.click(screen.getByRole("option", { name: /相談/ }));
    fireEvent.change(screen.getByLabelText("プロンプト"), { target: { value: "教えて" } });
    fireEvent.click(screen.getByRole("button", { name: "送信" }));
    await vi.waitFor(() => expect(handler).not.toBeNull());
    handler!({
      type: "done",
      payload: {
        runId: "run_ask",
        proposal: { text: "回答", baseContexts: [{ documentId: "doc_01", revision: 7 }] },
        sent: [],
      },
    });
    expect(await screen.findByText("質問は読み取りのみです。")).toBeVisible();
    expect(screen.queryByTestId("plan-card")).not.toBeInTheDocument();
  });
});
