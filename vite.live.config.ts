import { readFileSync } from "node:fs";
import { defineConfig, mergeConfig } from "vite";
import base from "./vite.config";

// Dedicated dev server for live-widget browser tests (Issue #6).
// Shares every base setting but isolates the optimizer/bundler cache under
// .local/vite-live-cache so live runs never reuse transform state with the
// native app dev server. MARXEN_VITE_LIVE_CACHE selects the directory.
function liveCacheDir(): string {
  const raw = (process.env.MARXEN_VITE_LIVE_CACHE ?? ".local/vite-live-cache").trim();
  if (raw === "" || raw.includes("..")) throw new Error("MARXEN_VITE_LIVE_CACHE must be a plain relative directory");
  return raw;
}

// Re-read the pinned MathJax version the same way vite.config.ts does, so
// this file stays correct even when imported standalone.
function mathjaxVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("./node_modules/mathjax-full/package.json", import.meta.url), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "3.2.1";
  } catch {
    return "3.2.1";
  }
}

export default mergeConfig(base, defineConfig({ cacheDir: liveCacheDir(), define: { PACKAGE_VERSION: JSON.stringify(mathjaxVersion()) } }));
