import { defineConfig, devices } from "@playwright/test";

// Dev-only browser acceptance for inline live widgets (Issue #6).
// The harness page (tests/live/harness/live.html) is served by `vite dev`
// and is NOT part of the production bundle, so these specs run on their own
// dev server (port 1425, clear of the app dev port and the production E2E
// port) and never ship. Production acceptance stays in playwright.config.ts.
export default defineConfig({
  testDir: "./tests/live",
  use: { baseURL: "http://127.0.0.1:1425", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: { command: "npm run dev -- --port 1425 --strictPort", url: "http://127.0.0.1:1425", reuseExistingServer: false, timeout: 120_000 },
  reporter: "list",
});
