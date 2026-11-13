#!/usr/bin/env node
// Starts one more company on this machine, from node-template.
//
//   npm run company -- "Dune Freight" dune.example
//   npm run company -- "Dune Freight" dune.example --port 8083 --admin dana "Dana Okafor"
//
// Each company gets a folder of its own under companies/, with its own Docker project, keys and
// volumes. They all join one Docker network, "fabric-chat", which stands in for the internet
// between them, so that their administrators can share a workspace from each company's app.
// Run it again for a company that exists to bring its folder up to date with the template.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const args = process.argv.slice(2);
const option = (name, count = 1) => {
  const at = args.indexOf(`--${name}`);
  return at < 0 ? [] : args.splice(at, count + 1).slice(1);
};
const [port] = option("port");
const [handle, fullName] = option("admin", 2);
const [name, id] = args;

if (!name || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(id ?? "")) {
  console.error('Usage: npm run company -- "<company name>" <id> [--port <number>] [--admin <handle> "<full name>"]');
  console.error('The ID is a domain name the company owns, in lower case, for example dune.example.');
  process.exit(2);
}

const all = path.join(root, "companies");
const dir = path.join(all, id.split(".")[0]);
const file = path.join(dir, "company.json");
const others = fs.existsSync(all) ? fs.readdirSync(all).map((folder) => path.join(all, folder, "company.json")).filter((f) => f !== file && fs.existsSync(f)).map((f) => JSON.parse(fs.readFileSync(f, "utf8"))) : [];

/** Whether nothing on this machine is listening on a port. */
const free = (candidate) =>
  new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen(candidate, "127.0.0.1", () => probe.close(() => resolve(true)));
  });

fs.mkdirSync(dir, { recursive: true });
for (const part of ["chat", "compose.yaml"]) fs.copyFileSync(path.join(root, "node-template", part), path.join(dir, part));
// Until release 0.3.0 this was a file of the template. It is now part of what ./chat writes.
fs.rmSync(path.join(dir, "compose.together.yaml"), { force: true });

if (fs.existsSync(file)) {
  console.log(`${path.relative(root, dir)} exists already. Its settings are kept, and its other files are brought up to date.`);
  // The chat script and compose.yaml belong to a release, so the folder moves to this one with them.
  const settings = JSON.parse(fs.readFileSync(file, "utf8"));
  if (settings.release !== version) {
    console.log(`It moves from release ${settings.release} to ${version}.`);
    fs.writeFileSync(file, JSON.stringify({ ...settings, release: version }, null, 2) + "\n");
  }
} else {
  let chosen = Number(port) || 8080;
  const taken = new Set(others.map((other) => other.listen?.port));
  while (!port && (taken.has(chosen) || !(await free(chosen)))) chosen++;
  const person = spawnSync("git", ["config", "user.name"], { encoding: "utf8", cwd: root }).stdout?.trim() || "Owner";
  const colors = ["#6c5ce7", "#0f766e", "#c2410c", "#1d4ed8", "#b45309", "#be185d", "#047857"];
  const settings = {
    name,
    id,
    color: colors[others.length % colors.length],
    hosts: { chat: `chat.${id}`, peer: `peer.${id}`, orderer: `orderer.${id}` },
    admin: { handle: handle ?? person.toLowerCase().split(/\s+/)[0].replace(/[^a-z0-9._-]/g, ""), name: fullName ?? person, title: "" },
    listen: { address: "127.0.0.1", port: chosen },
    dockerNetwork: "fabric-chat",
    images: "fabric-chat",
    release: version,
  };
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
  console.log(`${name} (${id}) is set up in ${path.relative(root, dir)}, to answer on port ${chosen}.`);
}

const started = spawnSync("sh", ["./chat", "up"], { cwd: dir, stdio: "inherit" });
if (started.error) {
  console.log(`\nStart it from a shell that has "sh", such as Git Bash:\n  cd ${path.relative(process.cwd(), dir)}\n  sh chat up`);
  process.exit(1);
}
process.exit(started.status ?? 1);
