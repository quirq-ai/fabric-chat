// Answers on the chat's port while the node is still starting, which takes about a minute the
// first time. A host that checks the port sees it answer at once, and a person who opens the
// address sees how far the start has got instead of an error. start.sh stops it just before the
// chat app takes the port over.
import fs from "node:fs";
import http from "node:http";

const port = Number(process.env.PORT ?? 3000);
const stepFile = process.env.SOLO_STEP ?? "/run/solo/step";

const page = (step) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="4">
<title>Fabric Chat is starting</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f6f7f9; color: #1c2430; }
  main { max-width: 30rem; padding: 2rem; }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
  p { margin: .25rem 0; color: #4a5565; }
  @media (prefers-color-scheme: dark) { body { background: #14181f; color: #e8ebf0; } p { color: #a3adbb; } }
</style>
</head>
<body>
<main>
  <h1>Fabric Chat is starting</h1>
  <p>${step}</p>
  <p>This page reloads by itself. The first start takes about a minute.</p>
</main>
</body>
</html>`;

const escape = (text) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

http
  .createServer((req, res) => {
    let step = "Starting.";
    try {
      step = fs.readFileSync(stepFile, "utf8").trim() || step;
    } catch {
      // No step has been written yet.
    }
    if ((req.url ?? "").startsWith("/api/")) {
      res.writeHead(503, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ error: { code: "STARTING", message: step } }));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(page(escape(step)));
  })
  .listen(port, "0.0.0.0");
