import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  use: { baseURL: "http://127.0.0.1:1420", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: { command: "npm run dev", url: "http://127.0.0.1:1420", reuseExistingServer: !process.env.CI },
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
});
