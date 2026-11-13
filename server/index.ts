// Starts the app: the API, the live block feeds and the web pages, all on one port.
//   npm run dev      pages served by Vite, with reload on change
//   npm run build && npm start    pages served from dist/
// On a company's own server (CHAT_NODE set, see config.ts) it always serves the built pages.
import { existsSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import express from "express";
import { api } from "./api";
import { joinEveryone, startCompany } from "./company";
import { ChatError, mode, network, root } from "./config";
import { closeAll } from "./fabric";
import { startFeeds, stopFeeds } from "./ledger";

const production = mode === "company" || process.argv.includes("--production");

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

  if (mode === "company") {
    // A company's pages load nothing from anywhere else, and may not be put in a frame by another site.
    app.use((_req, res, next) => {
      res.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("X-Frame-Options", "DENY");
      // An invitation link carries its secret in the address. It must not travel on to another site.
      res.setHeader("Referrer-Policy", "no-referrer");
      next();
    });
  }
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
  if (mode === "company") {
    // A workspace shared with another company can appear at any time.
    // When one does, its blocks are followed and the company's people are put in its directory.
    setInterval(() => {
      startFeeds();
      joinEveryone();
    }, 3000).unref();
    // Inside its container the app listens on every interface. Docker decides who can reach it:
    // company.json's "listen" says which address of the server the port is published on.
    server.listen(port, "0.0.0.0", () => {
      const { name, id } = network().company!;
      console.log(`Fabric Chat for ${name} (${id}) is listening on port ${port}`);
    });
    startCompany(port);
  } else {
    // This machine only: the sandbox's server holds every person's private key and asks for no password.
    server.listen(port, "127.0.0.1", () => {
      console.log(`Fabric Chat is at http://localhost:${port}  (${production ? "built pages" : "development"})`);
    });
  }

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
