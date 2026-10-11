import { defineConfig, devices } from "@playwright/test";

// Dev-only browser acceptance for inline live widgets (Issue #6).
// The harness page (tests/live/harness/live.html) is served by `vite dev`
// and is NOT part of the production bundle, so these specs run on their own
// dev server and never ship. Production acceptance stays in playwright.config.ts.
//
// Port defaults to 1426 (clear of the app dev port 1420 and the UI peer
// product-test port 1425) and accepts MARXEN_E2E_LIVE_PORT. The dev server
// uses a dedicated Vite optimizer cache (vite.live.config.ts) so live runs
// never share transform state with the native 1420 server.

function livePort(): number {
  const raw = process.env.MARXEN_E2E_LIVE_PORT ?? "1426";
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("MARXEN_E2E_LIVE_PORT must be a valid TCP port");
  }
  return port;
}

const port = livePort();

export default defineConfig({
  testDir: "./tests/live",
  outputDir: "./test-results/live",
  // The first navigation compiles the live harness's local renderers. Allow
  // cold-cache startup without changing the 5s assertion timeout or retries.
  timeout: 90_000,
  use: { baseURL: `http://127.0.0.1:${port}`, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npm run dev:live -- --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
  reporter: "list",
});
