import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.MARXEN_E2E_PORT ?? "1429");
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("MARXEN_E2E_PORT must be a valid TCP port");
}
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests/e2e",
  use: { baseURL, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npm run build && npm run preview -- --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 180_000,
  },
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
});
