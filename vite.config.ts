import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// mathjax-full/js/components/version.js reads its own package.json through
// eval('require') when the PACKAGE_VERSION global is missing. That Node-only
// path throws inside browser bundles, so the locally bundled version is
// injected at compile time instead (no CDN, no runtime require).
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

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: { PACKAGE_VERSION: JSON.stringify(mathjaxVersion()) },
  server: { port: 1420, strictPort: true },
  clearScreen: false,
});
