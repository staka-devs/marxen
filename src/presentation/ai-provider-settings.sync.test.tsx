import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import AiProviderSettings from "./ai-provider-settings";
import { defaultProviderConfig } from "../domain/ai-config";

beforeEach(() => vi.resetAllMocks());

it("reflects a provider edited in the other settings surface without publishing stale fields", async () => {
  const onProvider = vi.fn();
  const acp = defaultProviderConfig("acp");
  const { rerender } = render(<AiProviderSettings embedded provider={acp} onProvider={onProvider} />);
  expect(screen.queryByLabelText("資格情報の入力")).not.toBeInTheDocument();
  const next = defaultProviderConfig("openai_compatible");
  next.openai!.endpoint = "http://localhost:3000/v1";
  next.openai!.model = "local-model";
  rerender(<AiProviderSettings embedded provider={next} onProvider={onProvider} />);
  await waitFor(() => expect(screen.getByLabelText("endpoint")).toHaveValue("http://localhost:3000/v1"));
  expect(screen.getByLabelText("model")).toHaveValue("local-model");
  expect(onProvider).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("model"), { target: { value: "edited-model" } });
  await waitFor(() => expect(onProvider).toHaveBeenCalledWith(expect.objectContaining({ openai: expect.objectContaining({ endpoint: "http://localhost:3000/v1", model: "edited-model" }) })));
});
