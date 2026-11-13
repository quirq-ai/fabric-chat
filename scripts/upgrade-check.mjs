#!/usr/bin/env node
// Moves two running companies that share a workspace from the release before this one to this one,
// in place and one after the other, as would happen between real companies.
//
// It needs the older release's files and its three images on this machine:
//   npm run test:upgrade -- scripts/releases/0.2.0 0.2.0
// scripts/releases keeps the chat script and compose files each earlier release came with.
//
// It uses ports 4795 to 4797 on this machine.
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Browser, checker, docker, root, sleep, tokenOf, version } from "./lib.mjs";

const [from, older] = process.argv.slice(2);
if (!from || !older || !fs.existsSync(path.join(from, "chat"))) {
  console.error("Usage: npm run test:upgrade -- <folder holding the older chat and compose.yaml> <older version>");
  process.exit(2);
}
const checks = checker();
const { check, section, failed } = checks;
const last = (text, lines = 3) => text.trim().split("\n").slice(-lines).join(" | ");
const at = (channel) => `/api/w/${channel}/conversations/public/general/messages`;

/** A throwaway company in a folder of its own, driven through its own chat script, whichever release that is. */
function company(name, id, port, admin) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `fabric-chat-${id.split(".")[0]}-`));
  const settings = {
    name,
    id,
    color: "#1d4ed8",
    hosts: { chat: `chat.${id}`, peer: `peer.${id}`, orderer: `orderer.${id}` },
    admin: { handle: admin, name: admin[0].toUpperCase() + admin.slice(1), title: "" },
    listen: { address: "127.0.0.1", port },
    dockerNetwork: "fabric-chat-upgrade",
    images: "fabric-chat",
    release: older,
  };
  const one = {
    name,
    id,
    dir,
    settings,
    base: `http://localhost:${port}`,
    browser: new Browser(`http://localhost:${port}`),
    save: (changed = {}) => fs.writeFileSync(path.join(dir, "company.json"), JSON.stringify(Object.assign(settings, changed), null, 2) + "\n"),
    chat: (...args) => {
      const result = spawnSync("sh", ["./chat", ...args], { cwd: dir, encoding: "utf8" });
      return { status: result.status, text: `${result.stdout}${result.stderr}` };
    },
    files: (folder) => ["chat", "compose.yaml", "compose.together.yaml"].forEach((file) => (fs.existsSync(path.join(folder, file)) ? fs.copyFileSync(path.join(folder, file), path.join(dir, file)) : fs.rmSync(path.join(dir, file), { force: true }))),
    images: () => docker(["ps", "--filter", `label=com.docker.compose.project=chat-${id.replaceAll(".", "-")}`, "--format", "{{.Image}}"]).split("\n").filter((image) => image.startsWith("fabric-chat-")),
    async answering(seconds = 90) {
      for (let i = 0; i < seconds; i++) {
        if ((await one.browser.get("/api/health").catch(() => ({ status: 0 }))).status === 200) return true;
        await sleep(1000);
      }
      return false;
    },
    /** Starts it with the older release and signs its administrator in. */
    async start() {
      one.files(from);
      one.save();
      const up = one.chat("up");
      await one.answering();
      const signed = await one.browser.post(`/api/invites/${tokenOf(/(https?:\/\/\S+\?invite=\S+)/.exec(up.text)?.[1] ?? "http://x/?invite=none")}`, { password: `${admin} chose this one` });
      return up.status === 0 && signed.status === 200 ? "" : `${last(up.text)} ${signed.status}`;
    },
    /** Gives it this release's files and version, and runs ./chat up. */
    async move() {
      one.files(path.join(root, "node-template"));
      one.save({ release: version });
      const started = Date.now();
      const up = one.chat("up");
      await one.answering();
      return { ok: up.status === 0 && up.text.includes("is up."), seconds: Math.round((Date.now() - started) / 1000), text: up.text };
    },
    remove() {
      if (fs.existsSync(path.join(dir, ".env")) && one.chat("wipe", id).status !== 0) docker(["compose", "down", "--volumes", "--remove-orphans"], { cwd: dir, allowFailure: true });
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  return one;
}

const first = company("Upgrade Co", "upgrade.example", 4795, "uma");
const partner = company("Partner Co", "partner.example", 4797, "pat");
const uma = first.browser;
const pat = partner.browser;

async function until(test, seconds = 120) {
  const started = Date.now();
  while (Date.now() - started < seconds * 1000) {
    if (await test().catch(() => false)) return Math.round((Date.now() - started) / 1000);
    await sleep(2000);
  }
  return -1;
}
/** One message each way, each read at the other company. */
async function bothWays(channel, word) {
  let there;
  const sent = await until(async () => (there = await uma.post(at(channel), { text: `From Upgrade Co, ${word}.` })).status === 200, 90);
  const heard = await until(async () => (await pat.get(at(channel))).data?.messages.some((m) => m.text === `From Upgrade Co, ${word}.`), 60);
  const back = await pat.post(at(channel), { text: `From Partner Co, ${word}.` });
  const got = await until(async () => (await uma.get(at(channel))).data?.messages.some((m) => m.text === `From Partner Co, ${word}.`), 60);
  const both = there?.data?.receipt.endorsers.map((e) => e.msp).sort().join() === "partner.example,upgrade.example";
  return { ok: sent >= 0 && heard >= 0 && back.status === 200 && got >= 0 && both, detail: `${there?.status} ${there?.code ?? ""} heard ${heard}, back ${back.status} ${back.code}, got ${got}, both endorsed ${both}` };
}
/** One request to the first company's chat over HTTPS by its own name, on a port of this machine. */
function secure(pathname, cookie) {
  return new Promise((resolve) => {
    const request = https.request({ host: "127.0.0.1", port: 4796, servername: `chat.${first.id}`, path: pathname, rejectUnauthorized: false, headers: { host: `chat.${first.id}:4796`, ...(cookie ? { cookie } : {}) } }, (response) => {
      let text = "";
      response.on("data", (part) => (text += part));
      response.on("end", () => resolve({ status: response.statusCode, text }));
    });
    request.on("error", (err) => resolve({ status: 0, text: err.message }));
    request.end();
  });
}

try {
  section(`Two companies running release ${older}, sharing a workspace`);
  const problems = [await first.start(), await partner.start()].filter(Boolean);
  check(`both start with release ${older}'s own files and images, and their administrators sign in`, problems.length === 0, problems.join(" || "));
  check(`every part of both runs release ${older}`, [...first.images(), ...partner.images()].every((image) => image.endsWith(`:${older}`)), [...first.images(), ...partner.images()].join(" "));
  const said = await uma.post(at("home"), { text: `Said under release ${older}.` });
  const added = await uma.post("/api/admin/people", { handle: "omar", name: "Omar Haddad", title: "", role: "member" });
  const omar = new Browser(first.base);
  const joined = await omar.post(`/api/invites/${tokenOf(added.data?.link ?? "http://x/?invite=none")}`, { password: "omar chose another" });
  check("Upgrade Co's administrator writes at home, and adds a colleague who signs in", said.status === 200 && joined.status === 200, `${said.status} ${added.status} ${joined.status}`);
  const made = await uma.post("/api/admin/workspaces", { name: "Across releases", cards: [(await pat.get("/api/admin/companies")).data.card.text] });
  const shared = made.data?.channel;
  const accepted = await pat.post("/api/admin/invitations/accept", { text: made.data?.invitation ?? "" });
  const ready = async (browser) => (await browser.get("/api/admin/companies")).data?.workspaces.find((w) => w.channel === shared)?.status === "ready";
  const settled = Math.max(await until(() => ready(pat)), await until(() => ready(uma)));
  await until(async () => (await uma.get("/api/me")).data?.workspaces.includes(shared), 90);
  await until(async () => (await pat.get("/api/me")).data?.workspaces.includes(shared), 90);
  const channel = await uma.post(`/api/w/${shared}/conversations`, { kind: "channel", name: "general", topic: "Both", members: [], open: true });
  let talk = await bothWays(shared, `both on ${older}`);
  check(`they share a workspace and talk, both on ${older} (ready ${settled} s after accepting)`, accepted.status === 200 && settled >= 0 && channel.status === 200 && talk.ok, `${made.status} ${accepted.status} ${settled} ${channel.status} ${talk.detail}`);

  section("The two ways to get it wrong");
  first.save({ release: version });
  const oldFiles = first.chat("up");
  check("the new release with the older files is refused, in plain words, and nothing changes", oldFiles.status !== 0 && oldFiles.text.includes("older than release") && (await uma.get("/api/me")).status === 200, last(oldFiles.text));
  first.save({ release: older });
  first.files(path.join(root, "node-template"));
  const oldRelease = first.chat("up");
  check("the new files with the older release are refused too", oldRelease.status !== 0 && oldRelease.text.includes("older than the files in this folder") && (await uma.get("/api/me")).status === 200, last(oldRelease.text));

  section(`Upgrade Co moves to release ${version}. Partner Co stays on ${older}`);
  let moved = await first.move();
  check(`with the new files and the new release, ./chat up moves it (${moved.seconds} s)`, moved.ok, last(moved.text, 6));
  check(`every part of Upgrade Co now runs ${version}, and Partner Co still runs ${older}`, first.images().length > 0 && first.images().every((image) => image.endsWith(`:${version}`)) && partner.images().every((image) => image.endsWith(`:${older}`)), [...first.images(), ...partner.images()].join(" "));
  check("both of its people are still signed in", (await uma.get("/api/me")).status === 200 && (await omar.get("/api/me")).status === 200);
  const read = await omar.get(at("home"));
  check("what was said before is still there", read.status === 200 && read.data.messages.some((m) => m.text === `Said under release ${older}.`), `${read.status} ${read.message}`);
  const view = (await uma.get("/api/admin/companies")).data;
  check("it still lists the shared workspace as ready", view?.workspaces.find((w) => w.channel === shared)?.status === "ready", JSON.stringify(view?.workspaces.map((w) => w.status)));
  talk = await bothWays(shared, `one on ${version}`);
  check(`the two still talk, one on ${version} and one on ${older}: the chat's rules are the same in both`, talk.ok, talk.detail);
  const reach = await uma.post("/api/admin/cards/reach", { text: (await pat.get("/api/admin/companies")).data.card.text });
  check(`the moved company's new connection check reaches the node still on ${older}`, reach.status === 200 && ["peer", "orderer", "cluster"].every((part) => reach.data[part].reached && reach.data[part].proven), `${reach.status} ${reach.message} ${JSON.stringify(reach.data)}`);
  const generated = fs.readFileSync(path.join(first.dir, "compose.generated.yaml"), "utf8");
  check("what the server opens is now written down in one file", generated.includes(`"127.0.0.1:4795:8080"`) && generated.includes("name: fabric-chat-upgrade") && !fs.existsSync(path.join(first.dir, "compose.together.yaml")), generated.replace(/\s+/g, " ").slice(0, 200));
  const status = first.chat("status");
  check("./chat status says where the chat is and how the node is reached", status.text.includes(`The chat: ${first.base}`) && status.text.includes("over the Docker network"), last(status.text, 8));

  section(`Partner Co moves to release ${version} too`);
  moved = await partner.move();
  check(`./chat up moves it (${moved.seconds} s)`, moved.ok && partner.images().every((image) => image.endsWith(`:${version}`)), last(moved.text, 6));
  talk = await bothWays(shared, `both on ${version}`);
  check(`and the two talk again, both on ${version}`, talk.ok, talk.detail);

  section("Switching HTTPS on, and off again");
  first.save({ https: "self-signed", listen: { address: "127.0.0.1", port: 4796 } });
  const on = first.chat("up");
  let over = { status: 0 };
  for (let i = 0; i < 40 && over.status !== 200; i++) {
    over = await secure("/api/health");
    if (over.status !== 200) await sleep(1000);
  }
  const plain = await fetch(`${first.base}/api/health`).then((r) => r.status, () => "refused");
  check("with \"https\" set, the chat answers over HTTPS and the app's own port is closed", on.status === 0 && on.text.includes(`https://chat.${first.id}:4796`) && over.status === 200 && plain === "refused", `${last(on.text)} ${over.status} ${plain}`);
  check("people are still signed in", (await secure("/api/me", uma.cookie)).status === 200);
  delete first.settings.https;
  first.save({ listen: { address: "127.0.0.1", port: 4795 } });
  const off = first.chat("up");
  await first.answering();
  const gone = await secure("/api/health");
  const proxies = docker(["ps", "-a", "--filter", "name=chat-upgrade-example-proxy", "--format", "{{.Names}}"]).trim();
  check("with it taken out again, plain HTTP is back and the proxy is gone", off.status === 0 && (await uma.get("/api/me")).status === 200 && gone.status === 0 && proxies === "", `${last(off.text)} ${gone.status} ${proxies}`);

  console.log(`\n${checks.passed} checks passed, ${failed.length} failed.`);
  for (const name of failed) console.log(`  failed: ${name}`);
} catch (err) {
  failed.push("the check itself");
  console.error(`\nThe check stopped: ${err instanceof Error ? (err.stack ?? err.message) : err}`);
} finally {
  first.remove();
  partner.remove();
  docker(["network", "rm", "fabric-chat-upgrade"], { allowFailure: true });
  console.log("The throwaway companies are removed.");
}
process.exit(failed.length ? 1 : 0);
