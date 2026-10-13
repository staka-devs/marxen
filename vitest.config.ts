import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    // Bound JSDOM/Markdown worker contention on the smallest supported CI runner.
    maxWorkers: 2,
    testTimeout: 15_000,
  },
});
