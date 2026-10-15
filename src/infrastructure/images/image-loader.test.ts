import { beforeEach, expect, it, vi } from "vitest";
import { workspaceApi } from "../tauri/workspace-api";
import { clearImageCache, imageLoader, resolveImageForDocument } from "./image-loader";

vi.mock("../tauri/workspace-api", () => ({ workspaceApi: { loadImage: vi.fn() } }));

beforeEach(() => { vi.resetAllMocks(); clearImageCache(); });

it("invalidates hydrated URLs and refuses in-flight responses from before a rename", async () => {
  const image = { mime: "image/png", bytes: [1, 2], fingerprint: "a".repeat(64) };
  vi.mocked(workspaceApi.loadImage).mockResolvedValueOnce(image);
  const signal = new AbortController().signal;
  expect(await resolveImageForDocument("doc", "photo.png", signal)).not.toBeNull();
  imageLoader.invalidate();
  vi.mocked(workspaceApi.loadImage).mockRejectedValueOnce({ code: "not_found" });
  expect(await resolveImageForDocument("doc", "photo.png", signal)).toBeNull();
  let finish!: (data: typeof image) => void;
  vi.mocked(workspaceApi.loadImage).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const pending = resolveImageForDocument("doc", "photo.png", signal);
  imageLoader.invalidate();
  finish(image);
  expect(await pending).toBeNull();
  vi.mocked(workspaceApi.loadImage).mockRejectedValueOnce({ code: "not_found" });
  expect(await resolveImageForDocument("doc", "photo.png", signal)).toBeNull();
  expect(workspaceApi.loadImage).toHaveBeenCalledTimes(4);
});
