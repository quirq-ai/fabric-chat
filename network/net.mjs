#!/usr/bin/env node
// Starts and stops the Fabric Chat test network. It runs the same from PowerShell, Git Bash or Linux:
// this file only calls Docker, and everything that needs Fabric's tools runs inside containers.
//
//   node network/net.mjs up          make the files, start every node, create the channels, deploy the chaincode, enrol the people
//   node network/net.mjs status      what is running, and how many blocks each company's peer holds
//   node network/net.mjs stop        pause every node, keeping the ledgers
//   node network/net.mjs start       resume after stop
//   node network/net.mjs down        remove everything: nodes, ledgers, certificates
//   node network/net.mjs chaincode   rebuild the chaincode image and restart it, after changing the Go code
//   node network/net.mjs test        run the chaincode's unit tests
//   node network/net.mjs enrol <company> <person id>   add a person through that company's CA
//   node network/net.mjs cli <command...>              run a command inside the tools container
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gen = path.join(root, ".generated");
const scripts = path.join(root, "network", "scripts");
const ccDir = path.join(root, "chaincode", "chat");
const net = JSON.parse(fs.readFileSync(path.join(root, "network.json"), "utf8"));
const tools = `hyperledger/fabric-tools:${net.fabric.version}`;
const ccImage = `${net.name}-chaincode:${net.chaincode.version}`;
const cli = `cli.${net.domain}`;
const goImage = "golang:1.26-alpine";
const compose = ["compose", "-p", net.name, "-f", path.join(gen, "docker-compose.yaml")];

/** Runs a command and shows its output. Stops this script if the command fails. */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", cwd: root, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (options.allowFailure) return false;
    process.exit(result.status ?? 1);
  }
  return true;
}

/** Runs a command quietly and returns what it printed, or null if it failed. */
function read(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", cwd: root });
  return result.status === 0 ? result.stdout : null;
}

const step = (text) => console.log(`\n\x1b[1m${text}\x1b[0m`);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const generated = () => fs.existsSync(path.join(gen, "docker-compose.yaml"));
const inCli = (args, options) => run("docker", ["exec", cli, ...args], options);

function needNetwork() {
  if (!generated()) {
    console.error("The network has not been made yet. Run: npm run net:up");
    process.exit(1);
  }
}

function waitFor(what, check, tries = 40) {
  for (let i = 0; i < tries; i++) {
    if (check()) return;
    sleep(1000);
  }
  console.error(`${what} did not start.`);
  process.exit(1);
}

function buildChaincode() {
  run("docker", ["build", "--quiet", "-t", ccImage, ccDir]);
}

function enrol(code, id) {
  const org = net.orgs.find((o) => o.code === code);
  if (!org) {
    console.error(`Unknown company: ${code}. Known: ${net.orgs.map((o) => o.code).join(", ")}`);
    process.exit(1);
  }
  const ca = `ca.${code}.${net.domain}`;
  // The CA needs a moment after it starts before it answers.
  for (let i = 0; i < 20; i++) {
    const out = spawnSync("docker", ["exec", ca, "bash", "/scripts/enrol.sh", id], { encoding: "utf8" });
    if (out.status === 0) return out.stdout.trim();
    if (out.status === 2 || i === 19) {
      console.error(`${id} could not be enrolled at ${org.name}: ${out.stderr.trim()}`);
      process.exit(1);
    }
    sleep(1500);
  }
}

const commands = {
  up() {
    step("1/7  Writing the network's files");
    run("node", [path.join(root, "network", "generate.mjs")]);

    step("2/7  Making certificates, first blocks and the chaincode package");
    run("docker", ["run", "--rm", "-v", `${gen}:/work`, "-v", `${scripts}:/scripts:ro`, tools, "bash", "/scripts/artifacts.sh"]);

    step("3/7  Building the chaincode image");
    buildChaincode();

    step("4/7  Starting the nodes");
    run("docker", [...compose, "up", "-d", "--remove-orphans", "--quiet-pull"]);
    waitFor("The tools container", () => read("docker", ["exec", cli, "true"]) !== null);

    step("5/7  Creating the channels");
    inCli(["bash", "/scripts/channels.sh"]);

    step("6/7  Deploying the chaincode");
    inCli(["bash", "/scripts/chaincode.sh"]);

    step("7/7  Enrolling the people");
    for (const org of net.orgs) {
      const results = org.people.map((p) => `${p.id} (${enrol(org.code, p.id)})`);
      console.log(`${org.name}: ${results.join(", ")}`);
    }

    const tsx = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
    if (fs.existsSync(tsx)) {
      step("Seeding the workspaces");
      run("node", [tsx, path.join(root, "server", "seed.ts")]);
    } else {
      console.log("\nRun `npm install`, then `npm run seed` to put the people and a few messages on the ledger.");
    }
    console.log(`\nThe network is up. Start the app with: npm run dev   (http://localhost:${net.ports.app})`);
  },

  status() {
    needNetwork();
    run("docker", ["ps", "--all", "--filter", `label=com.docker.compose.project=${net.name}`, "--format", "table {{.Names}}\t{{.Status}}"]);
    const out = read("docker", ["exec", cli, "bash", "/scripts/heights.sh"]);
    if (!out) return console.log("\nThe tools container is not running, so block heights could not be read.");
    console.log("\nChannel      Company   Blocks  Newest block hash");
    for (const line of out.trim().split("\n")) {
      const row = JSON.parse(line);
      console.log(`${row.channel.padEnd(12)} ${row.org.padEnd(9)} ${String(row.height ?? "-").padStart(6)}  ${row.hash ?? "not reachable"}`);
    }
  },

  stop() {
    needNetwork();
    run("docker", [...compose, "stop"]);
  },

  start() {
    needNetwork();
    run("docker", [...compose, "start"]);
  },

  down() {
    if (generated()) run("docker", [...compose, "down", "--volumes", "--remove-orphans"]);
    fs.rmSync(gen, { recursive: true, force: true });
    console.log("The network is removed.");
  },

  // The peers hold only the address of the chaincode service, so new Go code needs no new
  // approvals: build the image again and restart the three chaincode containers.
  chaincode() {
    needNetwork();
    buildChaincode();
    run("docker", [...compose, "up", "-d", "--force-recreate", ...net.orgs.map((o) => `${net.chaincode.name}.${o.code}.${net.domain}`)]);
    console.log("The chaincode containers run the new code.");
  },

  test() {
    run("docker", ["run", "--rm", "-v", `${ccDir}:/src`, "-v", `${net.name}-gomod:/go/pkg/mod`, "-v", `${net.name}-gocache:/root/.cache/go-build`, "-w", "/src", goImage, "go", "test", "./...", ...process.argv.slice(3)]);
  },

  // Brings go.mod and go.sum up to date after changing the chaincode's imports.
  tidy() {
    run("docker", ["run", "--rm", "-v", `${ccDir}:/src`, "-v", `${net.name}-gomod:/go/pkg/mod`, "-w", "/src", goImage, "go", "mod", "tidy"]);
  },

  enrol() {
    needNetwork();
    const [code, id] = process.argv.slice(3);
    if (!code || !id) {
      console.error("Usage: node network/net.mjs enrol <company> <person id>");
      process.exit(2);
    }
    console.log(`${id}: ${enrol(code, id)}`);
  },

  cli() {
    needNetwork();
    inCli(process.argv.slice(3));
  },
};

const command = commands[process.argv[2]];
if (!command) {
  const text = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
  console.log(text.split("\n").slice(4, 13).map((line) => line.replace(/^\/\/ ?/, "")).join("\n"));
  process.exit(2);
}
command();
