import { mergeConfig } from "vite";
import base from "./vite.config";

// Restrict prebundling to the settings fixture rather than the Markdown/AI app.
export default mergeConfig(base, {
  cacheDir: "node_modules/.vite-settings",
  optimizeDeps: { entries: ["tests/fixtures/settings-preview.html"] },
  build: {
    outDir: ".local/settings-site",
    rolldownOptions: { input: "tests/fixtures/settings-preview.html" },
  },
});
