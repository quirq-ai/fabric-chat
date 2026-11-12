// Starts the app: the API, the live block feeds and the web pages, all on one port.
//   npm run dev      pages served by Vite, with reload on change
//   npm run build && npm start    pages served from dist/
import { existsSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import express from "express";
import { api } from "./api";
import { ChatError, network, root } from "./config";
import { closeAll } from "./fabric";
import { startFeeds, stopFeeds } from "./ledger";

const production = process.argv.includes("--production");

async function main(): Promise<void> {
  let port: number;
  try {
    port = Number(process.env.PORT) || network().appPort;
  } catch (err) {
    console.error(err instanceof ChatError ? err.message : err);
    process.exit(1);
  }

  const app = express();
  app.disable("x-powered-by");
  const server = http.createServer(app);
  app.use("/api", api());

  if (production) {
    const dist = path.join(root, "dist");
    if (!existsSync(path.join(dist, "index.html"))) {
      console.error("The pages have not been built. Run: npm run build");
      process.exit(1);
    }
    app.use(express.static(dist));
    app.use((_req, res) => res.sendFile(path.join(dist, "index.html")));
  } else {
    const { createServer } = await import("vite");
    const vite = await createServer({
      configFile: path.join(root, "vite.config.ts"),
      server: { middlewareMode: true, hmr: { server }, allowedHosts: [".localhost"] },
      appType: "spa",
    });
    app.use(vite.middlewares);
  }

  startFeeds();
  // This machine only: the server holds every person's private key.
  server.listen(port, "127.0.0.1", () => {
    console.log(`Fabric Chat is at http://localhost:${port}  (${production ? "built pages" : "development"})`);
  });

  const stop = () => {
    stopFeeds();
    closeAll();
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

void main();
