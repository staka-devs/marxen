import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChangedFileList, displayUnifiedDiff, PermissionCard, PlanCard, ToolCard } from "./agent-cards";

describe("agent cards", () => {
  it("shows real tool progress without internal ids", () => {
    render(
      <ToolCard tool={{ id: "call_1", title: "Reading file", kind: "read", status: "in_progress", locations: [{ path: "a.md" }] }} />,
    );
    expect(screen.getByTestId("tool-card-call_1")).toBeVisible();
    expect(screen.getByText("Reading file")).toBeVisible();
    expect(screen.getByText("a.md")).toBeVisible();
    expect(screen.queryByText("call_1")).not.toBeInTheDocument();
  });

  it("replaces plans completely on every update", () => {
    render(
      <PlanCard entries={[{ content: "Read", priority: "high", status: "completed" }]} />,
    );
    expect(screen.getByTestId("plan-card")).toBeVisible();
    expect(screen.getByText("Read")).toBeVisible();
  });

  it("surfaces permission options with actual ids and denial", () => {
    render(
      <PermissionCard
        permission={{
          requestId: "900",
          runId: "run_1",
          toolCallId: "call_1",
          title: "mock tool",
          options: [
            { optionId: "mock_allow", name: "許可", kind: "allow_once" },
            { optionId: "mock_reject", name: "拒否", kind: "reject_once" },
          ],
          state: "pending",
          interactive: true,
        }}
      />,
    );
    expect(screen.getByTestId("permission-card-900")).toBeVisible();
    expect(screen.getByText("mock tool")).toBeVisible();
    expect(screen.getByRole("button", { name: "許可" })).toBeVisible();
    expect(screen.getByRole("button", { name: "拒否" })).toBeVisible();
    expect(screen.queryByText("900")).not.toBeInTheDocument();
  });

  it("resolves permission cards with the chosen option and no raw ids", () => {
    const onChoose = vi.fn();
    render(
      <PermissionCard
        permission={{
          requestId: "901",
          runId: "run_1",
          title: "mock tool",
          options: [
            { optionId: "mock_allow", name: "許可", kind: "allow_once" },
            { optionId: "mock_reject", name: "拒否", kind: "reject_once" },
          ],
          state: "resolved",
          resolvedOptionId: "mock_allow",
          interactive: false,
        }}
        onChoose={onChoose}
      />,
    );
    expect(screen.getByTestId("permission-card-901")).toBeVisible();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByText("901")).not.toBeInTheDocument();
  });

  it("shows changed-file cards for diffs and new files", () => {
    render(
      <ChangedFileList
        diffs={[
          {
            documentId: "doc_01",
            path: "a.md",
            range: { start: 0, end: 1 },
            baseRevision: 1,
            liveRevision: 1,
            drifted: false,
            changed: true,
            unified: "---\n-old\n+new\n",
            stagingChars: 3,
            liveChars: 3,
          },
        ]}
        newFiles={[{ rel: "agentic-note.md", chars: 5, content: "# n\n" }]}
        documentLabels={{ doc_01: "a.md" }}
      />,
    );
    expect(screen.getByTestId("changed-file-list")).toBeVisible();
    expect(screen.getByTestId("changed-file-a.md")).toBeVisible();
    expect(screen.getByTestId("changed-file-agentic-note.md")).toBeVisible();
  });

  it("rewrites raw unified headers to the real filename", () => {
    expect(displayUnifiedDiff("--- live:a.md [0, 5)\n+++ staging:a.md [0, 5)\n-old\n+new\n", "a.md"))
      .toBe("--- a.md\n+++ a.md\n-old\n+new\n");
    expect(displayUnifiedDiff("--- live:doc_99.md\n+++ staging:doc_99.md\n-x\n", "a.md"))
      .toBe("--- a.md\n+++ a.md\n-x\n");
    expect(displayUnifiedDiff("承認できません: staging の形式が壊れています", "a.md"))
      .toBe("承認できません: staging の形式が壊れています");
  });

  it("hides live and staging identifiers from rendered diffs", () => {
    render(
      <ChangedFileList
        diffs={[
          {
            documentId: "doc_08",
            path: "メモ/a.md",
            range: { start: 0, end: 5 },
            baseRevision: 3,
            liveRevision: 3,
            drifted: false,
            changed: true,
            unified: "--- live:メモ/a.md [0, 5)\n+++ staging:メモ/a.md [0, 5)\n-old\n+new\n",
            stagingChars: 3,
            liveChars: 3,
          },
        ]}
        newFiles={[]}
        documentLabels={{ doc_08: "a.md" }}
      />,
    );
    const card = screen.getByTestId("changed-file-a.md");
    expect(card).toHaveTextContent("--- a.md");
    expect(card).not.toHaveTextContent("live:");
    expect(card).not.toHaveTextContent("staging:");
    expect(card).not.toHaveTextContent("doc_08");
  });

  it("sends one choice on double click and disables while awaiting", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    /** Single-flight choice handler holding the reply promise. */
    const onChoose = vi.fn(() => gate);
    render(
      <PermissionCard
        permission={{
          requestId: "902",
          runId: "run_1",
          title: "mock tool",
          options: [
            { optionId: "mock_allow", name: "許可", kind: "allow_once" },
            { optionId: "mock_reject", name: "拒否", kind: "reject_once" },
          ],
          state: "pending",
          interactive: true,
        }}
        onChoose={onChoose}
      />,
    );
    const allow = screen.getByRole("button", { name: "許可" });
    fireEvent.click(allow);
    fireEvent.click(allow);
    fireEvent.click(screen.getByRole("button", { name: "拒否" }));
    expect(onChoose).toHaveBeenCalledTimes(1);
    expect(onChoose).toHaveBeenCalledWith("mock_allow");
    expect(screen.getByRole("button", { name: "許可" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "拒否" })).toBeDisabled();
    release();
    await gate;
  });

  it("re-enables options when the reply fails recoverably", async () => {
    /** Failing choice handler releasing the buttons for retry. */
    const onChoose = vi.fn(async () => { throw new Error("stale"); });
    render(
      <PermissionCard
        permission={{
          requestId: "903",
          runId: "run_1",
          title: "mock tool",
          options: [{ optionId: "mock_reject", name: "拒否", kind: "reject_once" }],
          state: "pending",
          interactive: true,
        }}
        onChoose={onChoose}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "拒否" }));
    await vi.waitFor(() => expect(screen.getByRole("button", { name: "拒否" })).toBeEnabled());
    expect(onChoose).toHaveBeenCalledTimes(1);
  });
});
