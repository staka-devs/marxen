import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ReviewPanel from "./review-panel";

function baseProps() {
  return {
    copyId: "copy_08" as string | null,
    diffs: [],
    outcomes: [],
    busy: false,
    message: null as string | null,
    status: null as string | null,
    proposalText: "変更の提案" as string | null,
    onFetchDiff: vi.fn(),
    onStageProposal: vi.fn() as (() => void) | null,
    onApprove: vi.fn(),
    onReject: vi.fn(),
    onCancel: vi.fn(),
  };
}

describe("review panel", () => {
  it("shows the proposed change and drives approve/reject/cancel", () => {
    const props = baseProps();
    render(<ReviewPanel {...props} />);
    expect(screen.getByText("変更の提案")).toBeVisible();
    expect(screen.queryByText("copy_08")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "承認して適用" }));
    fireEvent.click(screen.getByRole("button", { name: "却下" }));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(props.onApprove).toHaveBeenCalledOnce();
    expect(props.onReject).toHaveBeenCalledOnce();
    expect(props.onCancel).toHaveBeenCalledOnce();
  });

  it("flags drifted scopes for resync and shows unified diffs", () => {
    render(
      <ReviewPanel
        {...baseProps()}
        diffs={[
          {
            documentId: "doc_08",
            path: "a.md",
            range: { start: 0, end: 5 },
            baseRevision: 3,
            liveRevision: 4,
            drifted: true,
            changed: true,
            unified: "--- live:a.md\n+++ staging:a.md\n-live\n+stale\n",
            stagingChars: 5,
            liveChars: 4,
          },
        ]}
      />,
    );
    expect(screen.getByText(/要再同期/)).toBeVisible();
  });

  it("shows staged proposal intake and per-document outcomes", () => {
    const onStageProposal = vi.fn();
    render(
      <ReviewPanel
        {...baseProps()}
        proposalText="hello world"
        onStageProposal={onStageProposal}
        outcomes={[
          {
            documentId: "doc_08",
            applied: true,
            revision: 4,
            error: null,
            rolledBack: false,
            rollbackError: null,
          },
          {
            documentId: "doc_09",
            applied: false,
            revision: 2,
            error: "stale",
            rolledBack: true,
            rollbackError: null,
          },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "提案を作業コピーに取り込む" }));
    expect(onStageProposal).toHaveBeenCalledOnce();
    expect(screen.getByText(/doc_08.*適用/)).toBeVisible();
    expect(screen.getByText(/ロールバック済み/)).toBeVisible();
  });

  it("disables actions without a copy", () => {
    render(<ReviewPanel {...baseProps()} copyId={null} />);
    expect(screen.getByRole("button", { name: "承認して適用" })).toBeDisabled();
    expect(screen.queryByText("copy_08")).not.toBeInTheDocument();
  });
});
