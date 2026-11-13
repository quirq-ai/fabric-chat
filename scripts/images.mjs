#!/usr/bin/env node
// Builds the three images a company's own server runs, tagged with this repository's version:
//
//   fabric-chat-chaincode   the chat's rules
//   fabric-chat-ctl         the admin tool that sets a node up
//   fabric-chat-app         the chat app
//
// Usage: npm run images                                          build them on this machine
//        npm run images -- --push ghcr.io/quirq-ai/fabric-chat   and send them to a registry, where a company's server can get them
//
// Sending needs "docker login" to that registry first. A company then puts the same name in its
// company.json, as "images", and ./chat up downloads them.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
// The Fabric versions come from the sandbox's settings, so both ways of running use the same ones.
const { fabric } = JSON.parse(fs.readFileSync(path.join(root, "network.json"), "utf8"));
const images = process.env.FABRIC_CHAT_IMAGES || "fabric-chat";

function build(name, context, args = []) {
  const tag = `${images}-${name}:${version}`;
  console.log(`\n\x1b[1mBuilding ${tag}\x1b[0m`);
  const flags = args.flatMap((arg) => ["--build-arg", arg]);
  const result = spawnSync("docker", ["build", "--quiet", "-t", tag, ...flags, context], { stdio: "inherit", cwd: root });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  return tag;
}

const built = [
  build("chaincode", "chaincode/chat"),
  build("ctl", "ctl", [`RELEASE=${version}`, `FABRIC_VERSION=${fabric.version}`, `CA_VERSION=${fabric.ca}`, `COUCHDB_VERSION=${fabric.couchdb}`]),
  build("app", ".", [`CA_VERSION=${fabric.ca}`]),
];
console.log(`\nBuilt ${built.join(", ")}.`);

const at = process.argv.indexOf("--push");
const registry = at < 0 ? "" : (process.argv[at + 1] ?? "");
if (at >= 0 && !/^[a-z0-9][a-z0-9._/:-]*$/.test(registry)) {
  console.error("Say where to send them: npm run images -- --push ghcr.io/quirq-ai/fabric-chat");
  process.exit(2);
}
function docker(args) {
  const result = spawnSync("docker", args, { stdio: "inherit", cwd: root });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
if (registry) {
  for (const tag of built) {
    const there = tag.replace(images, registry);
    console.log(`\n\x1b[1mSending ${there}\x1b[0m`);
    if (there !== tag) docker(["tag", tag, there]);
    docker(["push", "--quiet", there]);
  }
  console.log(`\nSent. A company's server gets them when its company.json says "images": "${registry}" and "release": "${version}".`);
} else {
  console.log(`A company's server on this machine runs them when its company.json says "images": "${images}" and "release": "${version}".`);
}
