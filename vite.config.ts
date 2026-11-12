import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = path.dirname(fileURLToPath(import.meta.url));

// The pages live in web/. In development the app server (server/index.ts) runs Vite inside itself,
// so pages and API share one port.
export default defineConfig({
  root: path.join(root, "web"),
  plugins: [react()],
  build: {
    outDir: path.join(root, "dist"),
    emptyOutDir: true,
  },
});
