import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AiPanel from "./ai-panel";
import {
  getCredentialState,
  setCredential,
  startPrompt,
  testConnection,
} from "../lib/ai";
import type { AiStreamEvent, PromptContext, StagingTarget } from "../shared/ai-contracts";

vi.mock("../lib/ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/ai")>();
  return {
    ...actual,
    getCredentialState: vi.fn(),
    setCredential: vi.fn(),
    deleteCredential: vi.fn(),
    testConnection: vi.fn(),
    startPrompt: vi.fn(),
    cancelPromptSafe: vi.fn(),
  };
});
beforeEach(() => {
  vi.resetAllMocks();
  window.localStorage.clear();
});

const contexts: PromptContext[] = [
  { documentId: "doc_01", revision: 7, ranges: [{ start: 1, end: 3 }], text: "a😀日本語" },
];
const staging: StagingTarget = { copyId: "copy_01" };

function emit(events: AiStreamEvent[], handler: (event: AiStreamEvent) => void) {
  for (const event of events) {
    handler(event);
  }
}

describe("ai panel", () => {
  it("shows the exact sent scope and staging copy", () => {
    render(<AiPanel contexts={contexts} staging={staging} />);
    expect(screen.getByText("doc_01 rev 7 [1, 3) 5文字")).toBeVisible();
    expect(screen.getByText("copy_01")).toBeVisible();
    expect(screen.getByRole("button", { name: "送信" })).toBeDisabled();
  });

  it("blocks sending while staging is unresolved", () => {
    render(<AiPanel contexts={contexts} staging={null} />);
    expect(screen.getByText(/未解決/)).toBeVisible();
    fireEvent.change(screen.getByLabelText("プロンプト"), { target: { value: "質問" } });
    expect(screen.getByRole("button", { name: "送信" })).toBeDisabled();
  });

  it("names the codex-acp adapter and never auto-downloads", () => {
    render(<AiPanel contexts={contexts} staging={staging} />);
    expect(screen.getByText(/codex-acp アダプター/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "OpenAI 互換" }));
    fireEvent.click(screen.getByRole("button", { name: "ACP" }));
    expect(screen.getByText(/codex-acp アダプター/)).toBeVisible();
  });

  it("keeps Anthropic disabled until opt-in", () => {
    render(<AiPanel contexts={contexts} staging={staging} />);
    fireEvent.click(screen.getByRole("button", { name: "Anthropic" }));
    fireEvent.change(screen.getByLabelText("プロンプト"), { target: { value: "質問" } });
    expect(screen.getByRole("button", { name: "送信" })).toBeDisabled();
    expect(screen.getByText("Anthropic を有効化すると送信できます。")).toBeVisible();
    fireEvent.click(screen.getByLabelText(/Anthropic を有効化する/));
    expect(screen.getByRole("button", { name: "送信" })).toBeEnabled();
  });

  it("refuses claude commands without invoking a transport", async () => {
    render(<AiPanel contexts={contexts} staging={staging} />);
    fireEvent.click(screen.getByRole("button", { name: "ACP" }));
    fireEvent.change(screen.getByLabelText("ACP プリセット"), { target: { value: "custom" } });
    fireEvent.change(screen.getByLabelText("カスタムコマンド"), { target: { value: "claude" } });
    fireEvent.change(screen.getByLabelText("プロンプト"), { target: { value: "質問" } });
    fireEvent.click(screen.getByRole("button", { name: "送信" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("起動しません");
    expect(startPrompt).not.toHaveBeenCalled();
  });

  it("streams chunks then shows the proposal with base revisions and sent ranges", async () => {
    let handler: ((event: AiStreamEvent) => void) | null = null;
    vi.mocked(startPrompt).mockImplementation(async (_request, onEvent) => {
      handler = onEvent;
      return { runId: "run_1", stop: vi.fn() };
    });
    render(<AiPanel contexts={contexts} staging={staging} />);
    fireEvent.change(screen.getByLabelText("プロンプト"), { target: { value: "質問です" } });
    fireEvent.click(screen.getByRole("button", { name: "送信" }));
    expect(await screen.findByRole("button", { name: "取り消し" })).toBeVisible();

    emit(
      [
        { type: "started", payload: { runId: "run_1" } },
        { type: "chunk", payload: { runId: "run_1", text: "こんにちは" } },
        {
          type: "done",
          payload: {
            runId: "run_1",
            proposal: { text: "こんにちは世界", baseContexts: [{ documentId: "doc_01", revision: 7 }] },
            sent: [{ documentId: "doc_01", revision: 7, ranges: [{ start: 1, end: 3 }], chars: 5 }],
          },
        },
      ],
      handler!,
    );
    expect(await screen.findByText("こんにちは世界")).toBeVisible();
    expect(screen.getByText("基準: doc_01 rev 7")).toBeVisible();
    const sentSection = screen.getByText("送信済みの範囲").parentElement!;
    expect(within(sentSection).getByText(/doc_01 rev 7/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "取り消し" })).not.toBeInTheDocument();
    expect(screen.getByText(/Markdownは変更しません/)).toBeVisible();
  });

  it("shows stream errors as alerts and not as answers", async () => {
    vi.mocked(startPrompt).mockImplementation(async (_request, onEvent) => {
      onEvent({ type: "error", payload: { runId: "run_2", error: { code: "auth_failed", detail: "bad key" } } });
      return { runId: "run_2", stop: vi.fn() };
    });
    render(<AiPanel contexts={[]} staging={staging} />);
    fireEvent.change(screen.getByLabelText("プロンプト"), { target: { value: "質問" } });
    fireEvent.click(screen.getByRole("button", { name: "送信" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("認証に失敗しました");
  });

  it("saves credentials through the OS store without displaying values", async () => {
    vi.mocked(getCredentialState).mockResolvedValue({ provider: "openai_compatible", hasSecret: true });
    render(<AiPanel contexts={[]} staging={staging} />);
    fireEvent.click(screen.getByRole("button", { name: "OpenAI 互換" }));
    const secret = screen.getByLabelText("資格情報の入力");
    expect(secret).toHaveAttribute("type", "password");
    fireEvent.change(secret, { target: { value: "s3cret" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await vi.waitFor(() => expect(setCredential).toHaveBeenCalledWith("openai_compatible", "s3cret"));
    await vi.waitFor(() => expect(secret).toHaveValue(""));
    expect(await screen.findByText("保存済み。値は表示しません。")).toBeVisible();
    expect(screen.queryByText("s3cret")).not.toBeInTheDocument();
  });

  it("reports dry-run and live connection tests separately", async () => {
    vi.mocked(testConnection)
      .mockResolvedValueOnce({ ok: true, detail: "設定と資格情報の存在を確認しました（通信なし）" })
      .mockResolvedValueOnce({ ok: false, detail: "codex が見つかりません" });
    render(<AiPanel contexts={[]} staging={staging} />);
    fireEvent.click(screen.getByRole("button", { name: "設定を確認" }));
    expect(await screen.findByRole("status")).toHaveTextContent("成功");
    fireEvent.click(screen.getByLabelText("実際に接続する"));
    fireEvent.click(screen.getByRole("button", { name: "接続テスト" }));
    expect(await screen.findByText(/codex が見つかりません/)).toBeVisible();
    expect(testConnection).toHaveBeenNthCalledWith(2, expect.anything(), true);
  });

  it("restores the persisted non-secret profile", () => {
    window.localStorage.setItem(
      "marxen.ai-profile.v1",
      JSON.stringify({
        kind: "openai_compatible",
        preset: "codex",
        command: "",
        argsText: "",
        endpoint: "https://example.com/v1",
        model: "gpt-x",
        anthropicEnabled: false,
      }),
    );
    render(<AiPanel contexts={contexts} staging={staging} />);
    expect(screen.getByLabelText("endpoint")).toHaveValue("https://example.com/v1");
    expect(screen.getByLabelText("model")).toHaveValue("gpt-x");
  });

  it("persists profile changes without secrets and reports proposals once", async () => {
    const seen: Array<[object, object]> = [];
    vi.mocked(startPrompt).mockImplementation(async (_request, onEvent) => {
      onEvent({ type: "started", payload: { runId: "run_9" } });
      onEvent({
        type: "done",
        payload: {
          runId: "run_9",
          proposal: { text: "提案です", baseContexts: [{ documentId: "doc_01", revision: 7 }] },
          sent: [{ documentId: "doc_01", revision: 7, ranges: [{ start: 1, end: 3 }], chars: 5 }],
        },
      });
      return { runId: "run_9", stop: vi.fn() };
    });
    render(<AiPanel contexts={contexts} staging={staging} onProposal={(proposal, sent) => seen.push([proposal, sent])} />);
    fireEvent.change(screen.getByLabelText("プロンプト"), { target: { value: "書いて" } });
    fireEvent.click(screen.getByRole("button", { name: "送信" }));
    expect(await screen.findByText("提案です")).toBeVisible();
    expect(seen).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "OpenAI 互換" }));
    fireEvent.change(screen.getByLabelText("model"), { target: { value: "gpt-x" } });
    await vi.waitFor(() => {
      const stored = JSON.parse(window.localStorage.getItem("marxen.ai-profile.v1") ?? "{}");
      expect(stored).toMatchObject({ kind: "openai_compatible", model: "gpt-x" });
    });
    expect(window.localStorage.getItem("marxen.ai-profile.v1")).not.toContain("s3cret");
  });
});
