import { describe, expect, it } from "vitest";
import { defaultProfile } from "../../domain/ai-profile";
import { loadAiProfile, saveAiProfile } from "./ai-profile-store";

describe("ai profiles persist non-secrets only", () => {
  it("round-trips provider/endpoint/model/argv/options", () => {
    saveAiProfile({
      ...defaultProfile(),
      kind: "openai_chat_completions",
      endpoint: "https://example.com/v1",
      model: "model-id",
      command: "my-agent",
      argsText: "--stdio",
      anthropicEnabled: false,
    });
    expect(loadAiProfile()).toMatchObject({
      kind: "openai_chat_completions",
      endpoint: "https://example.com/v1",
      model: "model-id",
      command: "my-agent",
      argsText: "--stdio",
    });
  });

  it("falls back to defaults on corrupt or unknown values", () => {
    window.localStorage.setItem("marxen.ai-profile.v1", JSON.stringify({ kind: "nope", preset: "nope" }));
    expect(loadAiProfile()).toEqual(defaultProfile());
    window.localStorage.setItem("marxen.ai-profile.v1", "{broken");
    expect(loadAiProfile()).toEqual(defaultProfile());
  });

  it("never stores secret material", () => {
    saveAiProfile({ ...defaultProfile(), model: "m" });
    const stored = window.localStorage.getItem("marxen.ai-profile.v1") ?? "";
    expect(stored).not.toContain("s3cret");
    expect(JSON.parse(stored)).not.toHaveProperty("secret");
  });
});
