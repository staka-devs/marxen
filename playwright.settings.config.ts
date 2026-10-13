import { defineConfig, devices } from "@playwright/test";

/** Isolated settings proof; Playwright owns and stops the bounded fixture server. */
export default defineConfig({
  workers: 1,
  timeout: 90_000,
  testDir: "./tests/settings",
  outputDir: "./test-results/settings",
  use: { baseURL: "http://127.0.0.1:1438", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npx vite build --config vite.settings.config.ts && npx vite preview --config vite.settings.config.ts --host 127.0.0.1 --port 1438 --strictPort",
    stdout: "pipe",
    url: "http://127.0.0.1:1438/tests/fixtures/settings-preview.html",
    reuseExistingServer: false,
    timeout: 120_000,
  },
  reporter: "list",
});
