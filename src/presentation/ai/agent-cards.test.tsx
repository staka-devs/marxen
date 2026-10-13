import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChangedFileList, PermissionCard, PlanCard, ToolCard } from "./agent-cards";

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
});
