import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ReviewPanel from "./review-panel";

/** Base review props with empty diffs for isolated panel tests. */
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
    fireEvent.click(screen.getByRole("button", { name: "適用して保存" }));
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
    expect(screen.getByRole("button", { name: "適用して保存" })).toBeDisabled();
    expect(screen.queryByText("copy_08")).not.toBeInTheDocument();
  });

  it("keeps completed results available without inactive approval controls", () => {
    render(<ReviewPanel {...baseProps()} copyId={null} onStageProposal={null} status="承認して適用しました。"
      outcomes={[{ documentId: "doc_08", applied: true, revision: 4, error: null, rolledBack: false, rollbackError: null }]} />);
    expect(screen.getByRole("status")).toHaveTextContent("承認して適用しました。");
    expect(screen.queryByRole("button", { name: "適用して保存" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("承認して適用しました。"));
    expect(screen.getByRole("list", { name: "承認結果", hidden: true })).toHaveTextContent("doc_08 適用");
  });

  it("retires approval actions after apply-and-save with saved status", () => {
    render(
      <ReviewPanel
        {...baseProps()}
        copyId={null}
        onStageProposal={null}
        applied
        status="保存しました（1件）。"
        outcomes={[{ documentId: "doc_08", applied: true, revision: 5, error: null, rolledBack: false, rollbackError: null }]}
      />,
    );
    expect(screen.queryByRole("button", { name: "適用して保存" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "却下" })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("保存しました");
  });

  it("shows changed-file cards for diffs and new agent files without raw ids", () => {
    render(
      <ReviewPanel
        {...baseProps()}
        diffs={[
          {
            documentId: "doc_08",
            path: "a.md",
            range: { start: 0, end: 5 },
            baseRevision: 3,
            liveRevision: 3,
            drifted: false,
            changed: true,
            unified: "--- live:a.md\n+++ staging:a.md\n-old\n+new\n",
            stagingChars: 3,
            liveChars: 3,
          },
        ]}
        newFiles={[{ rel: "agentic-note.md", chars: 10, content: "# note\n" }]}
        documentLabels={{ doc_08: "a.md" }}
      />,
    );
    expect(screen.getByTestId("changed-file-list")).toBeVisible();
    expect(screen.getByTestId("changed-file-a.md")).toBeVisible();
    expect(screen.getByTestId("changed-file-agentic-note.md")).toBeVisible();
    expect(screen.queryByText("copy_08")).not.toBeInTheDocument();
    expect(screen.queryByText("doc_08")).not.toBeInTheDocument();
  });

  it("hides internal mechanics paragraph", () => {
    render(<ReviewPanel {...baseProps()} />);
    expect(screen.queryByText(/ファイルの保存は別操作です/)).not.toBeInTheDocument();
  });

  it("retries failed imports without approval actions", () => {
    const onRetryImports = vi.fn();
    render(
      <ReviewPanel
        {...baseProps()}
        copyId={null}
        onStageProposal={null}
        applied
        status="保存に失敗しました（1件）。"
        outcomes={[{ documentId: "doc_08", applied: true, revision: 5, error: null, rolledBack: false, rollbackError: null }]}
        importOutcomes={[{ rel: "note.md", ok: false, error: "already exists: note.md" }]}
        onRetryImports={onRetryImports}
      />,
    );
    expect(screen.queryByRole("button", { name: "適用して保存" })).not.toBeInTheDocument();
    expect(screen.getByTestId("import-file-note.md")).toHaveTextContent("note.md");
    expect(screen.getByTestId("import-file-note.md")).toHaveTextContent(/already exists/);
    fireEvent.click(screen.getByRole("button", { name: "再試行" }));
    expect(onRetryImports).toHaveBeenCalledOnce();
  });

  it("collapses only fully applied reviews without import failures", () => {
    render(
      <ReviewPanel
        {...baseProps()}
        copyId={null}
        onStageProposal={null}
        applied
        status="保存しました（1件）。"
        outcomes={[{ documentId: "doc_08", applied: true, revision: 5, error: null, rolledBack: false, rollbackError: null }]}
        importOutcomes={[{ rel: "note.md", ok: true }]}
      />,
    );
    expect(screen.queryByRole("button", { name: "再試行" })).not.toBeInTheDocument();
  });
});
