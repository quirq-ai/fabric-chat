#!/usr/bin/env node
// End-to-end check of a company's own server.
//
// Launches a throwaway company from node-template, walks through what a company does on its first
// day (the first administrator, adding people, chatting, members-only conversations, passwords,
// a restart), and removes it again. Every check talks to the real app over HTTP, and behind it to
// a real peer, orderer and certificate authority.
//
//   npm run images                    build the three images first
//   npm run test:company              run the check (about a minute)
//   npm run test:company -- --keep    leave the company running afterwards, to look at in a browser
//
// It uses port 4790 on this machine. Set CHECK_PORT to use another.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const images = process.env.FABRIC_CHAT_IMAGES || "fabric-chat";
const port = Number(process.env.CHECK_PORT) || 4790;
const keep = process.argv.includes("--keep");
const id = "check.example";
const base = `http://localhost:${port}`;

const company = {
  // A name with a character that needs care in certificates, JSON and shell alike.
  name: "Check & Sons",
  id,
  color: "#0f766e",
  hosts: { chat: `chat.${id}`, peer: `peer.${id}`, orderer: `orderer.${id}` },
  admin: { handle: "dana", name: "Dana Okafor", title: "Operations lead" },
  listen: { address: "127.0.0.1", port },
  images,
  release: version,
};

/* ------------------------------------------------------------------ small tools */

let passed = 0;
const failed = [];
function check(name, ok, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ok    ${name}`);
  } else {
    failed.push(name);
    console.log(`  FAIL  ${name}${detail ? `  (${detail})` : ""}`);
  }
}
const section = (title) => console.log(`\n${title}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function docker(args, options = {}) {
  const result = spawnSync("docker", args, { encoding: "utf8", cwd: options.cwd, input: options.input, maxBuffer: 32 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) throw new Error(`docker ${args.slice(0, 3).join(" ")} failed:\n${(result.stderr || result.stdout).trim().split("\n").slice(-12).join("\n")}`);
  return result.stdout;
}

/** One browser: it keeps its own session cookie, as a person's browser would. */
class Browser {
  cookie = "";
  setCookie = "";

  async call(method, pathname, body, headers = {}) {
    const response = await fetch(base + pathname, {
      method,
      headers: { ...(this.cookie ? { cookie: this.cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const set of response.headers.getSetCookie()) {
      const pair = set.split(";")[0];
      if (!pair.startsWith("chat_session=")) continue;
      this.setCookie = set;
      this.cookie = pair === "chat_session=" ? "" : pair;
    }
    const text = await response.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      // A page, not JSON.
    }
    return { status: response.status, data, headers: response.headers, code: data?.error?.code ?? "", message: data?.error?.message ?? "" };
  }
  get = (pathname, headers) => this.call("GET", pathname, undefined, headers);
  post = (pathname, body = {}, headers) => this.call("POST", pathname, body, headers);
  patch = (pathname, body) => this.call("PATCH", pathname, body);
  del = (pathname) => this.call("DELETE", pathname);
}

const at = (scope, conv) => `/api/w/home/conversations/${encodeURIComponent(scope)}/${encodeURIComponent(conv)}`;
const tokenOf = (link) => new URL(link).searchParams.get("invite");

/** A request with a Host header of our choosing, which fetch does not allow. */
function withHost(host) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, path: "/api/health", headers: { Host: host } }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
    });
    request.on("error", reject);
    request.end();
  });
}

/* ------------------------------------------------------------------ launch */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-chat-check-"));
const compose = (args, options = {}) => docker(["compose", ...args], { cwd: dir, ...options });

async function waitForApp() {
  for (let i = 0; i < 90; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return;
    } catch {
      // Not listening yet.
    }
    await sleep(1000);
  }
  throw new Error("The app did not start answering.");
}

/** The steps ./chat up takes, in the same order, without needing a shell. */
function bringUp() {
  // Run attached, and the finished container kept, as ./chat does.
  const step = (name) => compose(["up", "--no-deps", "--no-log-prefix", "--exit-code-from", name, name]);
  step("prepare");
  compose(["up", "-d", "--no-deps", "ca", "couchdb"]);
  step("init");
  compose(["up", "-d", "--no-deps", "peer", "orderer", "chaincode"]);
  step("setup");
  compose(["up", "-d", "--no-deps", "app"]);
}

function launch() {
  for (const name of ["compose.yaml", "chat"]) fs.copyFileSync(path.join(root, "node-template", name), path.join(dir, name));
  fs.writeFileSync(path.join(dir, "company.json"), JSON.stringify(company, null, 2) + "\n");
  // The two files ./chat writes from company.json: the settings, and what the server opens to the outside.
  const template = /^TEMPLATE=(\d+)$/m.exec(fs.readFileSync(path.join(root, "node-template", "chat"), "utf8"))[1];
  fs.writeFileSync(path.join(dir, ".env"), docker(["run", "--rm", "-i", "-e", `CHAT_TEMPLATE=${template}`, `${images}-ctl:${version}`, "env"], { input: JSON.stringify(company) }));
  fs.writeFileSync(path.join(dir, "compose.generated.yaml"), docker(["run", "--rm", "-i", `${images}-ctl:${version}`, "compose"], { input: JSON.stringify(company) }));
  bringUp();
}

function remove() {
  compose(["down", "--volumes", "--remove-orphans"], { allowFailure: true });
  fs.rmSync(dir, { recursive: true, force: true });
}

/* ------------------------------------------------------------------ the checks */

async function main() {
  const started = Date.now();
  console.log(`Launching ${company.name} (${id}) from node-template in ${dir}`);
  launch();
  const welcome = compose(["exec", "-T", "app", "node", "build/operator.mjs", "welcome"]);
  await waitForApp();
  const launchSeconds = Math.round((Date.now() - started) / 1000);
  console.log(`Up after ${launchSeconds} s.`);

  const visitor = new Browser();
  const dana = new Browser();
  const dev = new Browser();
  const eve = new Browser();
  const danaPassword = "correct horse battery";
  const devPassword = "nine lives and a day";

  section("Before anyone signs in");
  {
    const health = await visitor.get("/api/health");
    check("the app answers, in one-company mode", health.status === 200 && health.data.mode === "company");
    const net = await visitor.get("/api/network");
    check("a visitor is told the company's name and nothing else", net.data.locked === true && net.data.company.name === company.name && net.data.people.length === 0 && net.data.orgs.length === 0 && net.data.workspaces.length === 0);
    for (const pathname of ["/api/me", "/api/w/home/overview", "/api/admin/people", "/api/network/status", `${at("public", "general")}/messages`]) {
      const answer = await visitor.get(pathname);
      check(`${pathname} needs a sign-in`, answer.status === 401 && answer.code === "SIGN_IN", `${answer.status} ${answer.code}`);
    }
    const posing = await visitor.get("/api/me", { "x-chat-user": `dana@${id}` });
    check("naming a person in a header does not sign you in as them", posing.status === 401);
    const stream = await visitor.get(`/api/stream?as=dana@${id}`);
    check("the live stream needs a sign-in", stream.status === 401);
    const open = await visitor.post("/api/people", { org: id, handle: "mallory", name: "Mallory" });
    check("the sandbox's open \"add a person\" does not exist here", open.status === 404, `${open.status}`);
    const stopNode = await visitor.post(`/api/network/nodes/peer.${id}/stop`);
    check("the sandbox's stop-a-node switch does not exist here", stopNode.status === 404, `${stopNode.status}`);
    check("a request under another host name is refused", (await withHost("evil.example")) === 403);
    check("a request under the company's chat name is accepted", (await withHost(`chat.${id}`)) === 200);
    const crossSite = await visitor.post("/api/session", { handle: "dana", password: "x" }, { origin: "http://evil.example" });
    check("a change sent from another site's page is refused", crossSite.status === 403 && crossSite.code === "FORBIDDEN", `${crossSite.status}`);
    const page = await fetch(`${base}/`);
    const policy = page.headers.get("content-security-policy") ?? "";
    check("pages may not be framed, and load nothing from elsewhere", policy.includes("default-src 'self'") && policy.includes("frame-ancestors 'none'") && page.headers.get("x-frame-options") === "DENY");
    check("an invitation's address is not passed on to other sites", page.headers.get("referrer-policy") === "no-referrer");
    check("answers are not kept by caches", health.headers.get("cache-control") === "no-store");
  }

  section("The first administrator");
  const firstLink = /(http:\/\/\S+\?invite=\S+)/.exec(welcome)?.[1] ?? "";
  {
    check("./chat up printed a link for the first administrator", firstLink.startsWith(`${base}/?invite=`), welcome.trim().split("\n")[0]);
    const token = tokenOf(firstLink);
    const info = await visitor.get(`/api/invites/${token}`);
    check("the link names who it is for", info.status === 200 && info.data.name === "Dana Okafor" && info.data.id === `dana@${id}` && info.data.first === true);
    const weak = await dana.post(`/api/invites/${token}`, { password: "too short" });
    check("a password under 10 characters is refused", weak.status === 400 && weak.code === "WEAK_PASSWORD");
    const accepted = await dana.post(`/api/invites/${token}`, { password: danaPassword });
    check("choosing a password signs her in as an administrator", accepted.status === 200 && accepted.data.user.role === "admin" && accepted.data.user.id === `dana@${id}`);
    check("the session cookie is hidden from page scripts and not sent across sites", /HttpOnly/i.test(dana.setCookie) && /SameSite=Lax/i.test(dana.setCookie));
    const again = await visitor.post(`/api/invites/${token}`, { password: "another password!" });
    check("the link works once", again.status === 404 && again.code === "NO_SUCH_INVITE", `${again.status} ${again.code}`);

    const net = await dana.get("/api/network");
    check("signed in, she sees the company, its workspace and its people", net.data.locked === false && net.data.orgs.length === 1 && net.data.orgs[0].msp === id && net.data.workspaces[0].channel === "home" && net.data.people.some((p) => p.id === `dana@${id}`));
    const me = await dana.get("/api/me");
    check("the chaincode reads the same ID from her certificate", me.data.asTheLedgerSeesMe?.id === `dana@${id}` && me.data.asTheLedgerSeesMe?.msp === id, JSON.stringify(me.data.asTheLedgerSeesMe));
    check("her certificate was signed by the company's own authority", me.data.certificate.issuer.CN === `ca.${id}` && me.data.certificate.issuer.O === id && me.data.certificate.subject.OU === "client", JSON.stringify(me.data.certificate.issuer));
    const years = (new Date(me.data.certificate.validTo) - new Date(me.data.certificate.validFrom)) / (365.25 * 86_400_000);
    check("her certificate lasts ten years", years > 9.9 && years < 10.1, `${years.toFixed(2)} years`);
    const overview = await dana.get("/api/w/home/overview");
    const general = overview.data.conversations.find((c) => c.name === "general");
    check("the workspace starts with an open #general", !!general && general.scope === "public" && general.members.length === 0 && general.createdBy === `dana@${id}`);
    check("she is in the workspace's directory", overview.data.people.some((p) => p.id === `dana@${id}` && p.name === "Dana Okafor"));
  }

  section("Chatting");
  let firstMessage;
  {
    const posted = await dana.post(`${at("public", "general")}/messages`, { text: "Good morning. This is our own ledger." });
    firstMessage = posted.data?.message;
    check("a message is a committed transaction", posted.status === 200 && posted.data.receipt.validation === "VALID" && posted.data.receipt.block > 0, posted.message);
    check("the company's own peer endorsed it", posted.data?.receipt.endorsers.length === 1 && posted.data.receipt.endorsers[0].msp === id && posted.data.receipt.endorsers[0].role === "peer", JSON.stringify(posted.data?.receipt.endorsers));
  }

  section("Adding people");
  let devLink;
  {
    const added = await dana.post("/api/admin/people", { handle: "dev", name: "Dev Malik", title: "Dispatcher", role: "member" });
    devLink = added.data?.link ?? "";
    check("an administrator adds a person and gets a link to pass on", added.status === 200 && devLink.startsWith(`${base}/?invite=`) && added.data.person.state === "invited", added.message);
    check("the new person has a certificate and is in the directory", added.data?.certificate.issuer.CN === `ca.${id}` && added.data.joined.length === 1 && added.data.joined[0].block > 0);
    const taken = await dana.post("/api/admin/people", { handle: "dev", name: "Dev Again", title: "", role: "member" });
    check("a handle cannot be given out twice", taken.status === 409 && taken.code === "HANDLE_TAKEN");
    const reserved = await dana.post("/api/admin/people", { handle: "chat-service", name: "Not A Person", title: "", role: "member" });
    check("a person cannot take a name the node uses for itself", reserved.status === 400, `${reserved.status} ${reserved.code}`);
    const odd = await dana.post("/api/admin/people", { handle: "Dev Malik!", name: "Dev", title: "", role: "member" });
    check("a handle with spaces or symbols is refused", odd.status === 400);

    const early = await dev.post("/api/session", { handle: "dev", password: devPassword });
    check("an invited person cannot sign in before choosing a password", early.status === 401 && early.code === "WRONG_PASSWORD");
    const accepted = await dev.post(`/api/invites/${tokenOf(devLink)}`, { password: devPassword });
    check("the new person chooses a password and is signed in as a member", accepted.status === 200 && accepted.data.user.role === "member");
    const list = await dev.get("/api/admin/people");
    check("a member cannot see the administrator's list", list.status === 403 && list.code === "NOT_ADMIN");
    const sneak = await dev.post("/api/admin/people", { handle: "pal", name: "A Pal", title: "", role: "admin" });
    check("a member cannot add people", sneak.status === 403);
    const promote = await dev.patch("/api/admin/people/dev", { role: "admin" });
    check("a member cannot make themselves an administrator", promote.status === 403);

    const thread = await dev.get(`${at("public", "general")}/messages`);
    check("the new person reads what was said before they joined", thread.data?.messages.some((m) => m.id === firstMessage.id && m.author === `dana@${id}`));
    const reply = await dev.post(`${at("public", "general")}/messages`, { text: "Morning, Dana." });
    const seen = await dana.get(`${at("public", "general")}/messages`);
    check("and the administrator reads their reply", reply.status === 200 && seen.data.messages.some((m) => m.id === reply.data.message.id && m.author === `dev@${id}`));
  }

  section("Members-only conversations");
  {
    const eveAdded = await dana.post("/api/admin/people", { handle: "eve", name: "Eve Lindqvist", title: "Finance", role: "member" });
    await eve.post(`/api/invites/${tokenOf(eveAdded.data.link)}`, { password: "eve chose this one" });

    const made = await dana.post("/api/w/home/conversations", { kind: "channel", name: "ops", topic: "Dana and Dev", members: [`dev@${id}`], open: false });
    const scope = made.data?.conversation.scope;
    // A private channel has a random ID, so that nobody can test the ledger for a channel by guessing its name.
    const ops = made.data?.conversation.id;
    check("a members-only channel goes in the company's private store", made.status === 200 && scope === `_implicit_org_${id}` && made.data.scope.kind === "org", `${made.status} ${scope} ${made.message}`);
    const posted = await dana.post(`${at(scope, ops)}/messages`, { text: "The depot code is 4417." });
    const secret = posted.data?.message;
    check("a member posts there", posted.status === 200 && posted.data.receipt.validation === "VALID", posted.message);
    const devSees = await dev.get(`${at(scope, ops)}/messages`);
    check("the other member reads it", devSees.data?.messages.some((m) => m.id === secret.id && m.text === "The depot code is 4417."));
    const eveList = await eve.get("/api/w/home/overview");
    check("someone outside it does not see it listed", eveList.status === 200 && !eveList.data.conversations.some((c) => c.name === "ops"));
    const eveReads = await eve.get(`${at(scope, ops)}/messages`);
    check("and the chaincode refuses to show it to them", eveReads.status === 403 && eveReads.code === "CHAT_NOT_MEMBER", `${eveReads.status} ${eveReads.code}`);

    let tx = null;
    for (let i = 0; i < 20 && !tx; i++) {
      const found = await dana.get(`/api/w/home/tx/${secret.txId}`);
      if (found.status === 200) tx = found.data.tx;
      else await sleep(300);
    }
    const writes = tx?.writes.filter((w) => w.namespace === "chat") ?? [];
    check("the block carries a hash of the message, not its words", !!tx && tx.args[1] === "" && writes.length > 0 && writes.every((w) => w.collection === scope) && !JSON.stringify(tx).includes("4417"), JSON.stringify(tx?.args));
    const held = await dana.get(`${at(scope, ops)}/messages/${secret.id}/holdings`);
    check("the peer holds the words, and they match the hash on the ledger", held.data?.holdings.length === 1 && held.data.holdings[0].held === true && held.data.holdings[0].matches === true, JSON.stringify(held.data?.holdings));

    const removed = await dana.del(`${at(scope, ops)}/messages/${secret.id}`);
    check("deleting it purges it", removed.status === 200 && removed.data.result.purged === true, removed.message);
    const after = await dev.get(`${at(scope, ops)}/messages`);
    const gone = await dana.get(`${at(scope, ops)}/messages/${secret.id}/holdings`);
    check("it is gone from the conversation and from the peer", !after.data.messages.some((m) => m.id === secret.id) && gone.data?.holdings[0]?.held !== true, JSON.stringify(gone.data ?? gone.message));

    const dm = await dev.post("/api/w/home/conversations", { kind: "dm", members: [`dana@${id}`] });
    const dmScope = dm.data?.conversation.scope;
    const said = await dev.post(`${at(dmScope, dm.data?.conversation.id)}/messages`, { text: "Can you cover Friday?" });
    const danaDm = await dana.get(`${at(dmScope, dm.data?.conversation.id)}/messages`);
    check("a direct message works the same way", dm.status === 200 && dmScope === scope && said.status === 200 && danaDm.data.messages.length === 1, `${dm.status} ${said.status}`);
    const eveDm = await eve.get(`${at(dmScope, dm.data?.conversation.id)}/messages`);
    check("and a third person cannot read it", eveDm.status === 403);

    const edited = await dana.patch(`${at("public", "general")}/messages/${firstMessage.id}`, { text: "Good morning. This is our own ledger now." });
    const history = await dana.get(`${at("public", "general")}/messages/${firstMessage.id}/history`);
    check("an open channel keeps every version of an edited message", edited.status === 200 && history.data.length === 2 && history.data[0].text === "Good morning. This is our own ledger.", `${edited.status}`);
    const notMine = await dev.patch(`${at("public", "general")}/messages/${firstMessage.id}`, { text: "Rewritten by Dev" });
    check("nobody can edit someone else's message", notMine.status === 403 && notMine.code === "CHAT_NOT_AUTHOR", `${notMine.status} ${notMine.code}`);
  }

  section("The nodes, as the app sees them");
  {
    const status = await dana.get("/api/network/status");
    check("all five of the company's nodes answer", status.data?.nodes.length === 5 && status.data.nodes.every((n) => n.state === "running" && n.controllable === false), JSON.stringify(status.data?.nodes.map((n) => `${n.kind}:${n.state}`)));
    check("the app follows the peer's blocks live", status.data?.ledgers.length === 1 && status.data.ledgers[0].state === "live" && status.data.ledgers[0].height > 5);
    const response = await fetch(`${base}/api/stream`, { headers: { cookie: dana.cookie } });
    const reader = response.body.getReader();
    let first = "";
    const deadline = Date.now() + 5000;
    while (!first.includes("event: hello") && Date.now() < deadline) {
      const chunk = await Promise.race([reader.read(), sleep(1000).then(() => null)]);
      if (chunk?.value) first += new TextDecoder().decode(chunk.value);
    }
    void reader.cancel();
    check("the live stream opens for a signed-in person", response.status === 200 && first.includes("event: hello"), first.slice(0, 60));
  }

  section("Passwords and sessions");
  {
    const laptop = new Browser();
    const second = await laptop.post("/api/session", { handle: "dana", password: danaPassword });
    check("the same person can be signed in on two browsers", second.status === 200 && (await laptop.get("/api/me")).status === 200);
    const full = await laptop.post("/api/session", { handle: `dana@${id}`.split("@")[0].toUpperCase(), password: danaPassword });
    check("a handle typed in capitals still signs in", full.status === 200);

    const wrong = await visitor.post("/api/session", { handle: "dana", password: "not her password" });
    const nobody = await visitor.post("/api/session", { handle: "nobody-here", password: "not a password" });
    check("a wrong password and an unknown handle get the same answer", wrong.status === 401 && nobody.status === 401 && wrong.message === nobody.message && wrong.code === "WRONG_PASSWORD");

    const badChange = await dana.post("/api/me/password", { current: "not her password", next: "a brand new password" });
    check("changing a password needs the current one", badChange.status === 401);
    const newPassword = "a brand new password";
    const changed = await dana.post("/api/me/password", { current: danaPassword, next: newPassword });
    check("she changes her password", changed.status === 200, changed.message);
    check("which signs her out everywhere else", (await laptop.get("/api/me")).status === 401 && (await dana.get("/api/me")).status === 200);
    const oldOne = await visitor.post("/api/session", { handle: "dana", password: danaPassword });
    const newOne = await laptop.post("/api/session", { handle: "dana", password: newPassword });
    check("the old password stops working and the new one works", oldOne.status === 401 && newOne.status === 200);

    const out = await laptop.del("/api/session");
    check("signing out ends the session", out.status === 200 && laptop.cookie === "" && (await laptop.get("/api/me")).status === 401);

    const reset = await dana.post("/api/admin/people/dev/link");
    check("an administrator makes a reset link for someone", reset.status === 200 && reset.data.link.includes("?invite=") && reset.data.person.state === "active");
    check("their old password still works until they use it", (await visitor.post("/api/session", { handle: "dev", password: devPassword })).status === 200);
    await visitor.del("/api/session");
    const resetDone = await new Browser().post(`/api/invites/${tokenOf(reset.data.link)}`, { password: "dev picked a new one" });
    check("using it sets a new password and closes their old sessions", resetDone.status === 200 && (await dev.get("/api/me")).status === 401 && (await visitor.post("/api/session", { handle: "dev", password: devPassword })).status === 401);
    await dev.post("/api/session", { handle: "dev", password: "dev picked a new one" });

    const lastAdmin = await dana.patch("/api/admin/people/dana", { role: "member" });
    check("the only administrator cannot be made a member", lastAdmin.status === 409 && lastAdmin.code === "LAST_ADMIN");
    const promoted = await dana.patch("/api/admin/people/dev", { role: "admin" });
    check("an administrator can make someone else an administrator", promoted.status === 200 && (await dev.get("/api/admin/people")).status === 200);
    const demoted = await dev.patch("/api/admin/people/dev", { role: "member" });
    check("and back again", demoted.status === 200 && (await dev.get("/api/admin/people")).status === 403);

    const statuses = [];
    for (let i = 0; i < 9; i++) statuses.push((await visitor.post("/api/session", { handle: "ghost", password: `guess number ${i}` })).status);
    check("after eight wrong passwords a handle is locked for a while", statuses.slice(0, 8).every((s) => s === 401) && statuses[8] === 429, statuses.join(" "));
  }

  section("The person who runs the server");
  {
    const again = compose(["exec", "-T", "app", "node", "build/operator.mjs", "welcome"]);
    check("once the first administrator has signed in, ./chat up prints no link", !again.includes("?invite=") && again.includes("People: 3"), again.trim().split("\n").pop());
    const printed = compose(["exec", "-T", "app", "node", "build/operator.mjs", "admin-link", "dana"]);
    const link = /(http:\/\/\S+\?invite=\S+)/.exec(printed)?.[1] ?? "";
    const info = await visitor.get(`/api/invites/${tokenOf(link || `${base}/?invite=none`)}`);
    check("./chat admin-link lets a locked-out administrator back in", info.status === 200 && info.data.first === false && info.data.id === `dana@${id}`, printed.trim().split("\n")[0]);
    const notAdmin = compose(["exec", "-T", "app", "node", "build/operator.mjs", "admin-link", "eve"], { allowFailure: true });
    check("but only for an administrator", !notAdmin.includes("?invite="));
    const status = compose(["run", "--rm", "--no-deps", "-T", "setup", "status"]);
    check("./chat status reads the ledger's height from the peer", /home\s+\d+\s+\S+/.test(status) && status.includes("chat version 1.0, sequence 1"), status.trim().split("\n").slice(-2).join(" | "));
  }

  section("After a restart, and after losing the app's data for one person");
  {
    // Forget Eve on the app's side only, as if her account and key were lost. The CA still knows her.
    compose(["exec", "-T", "app", "node", "-e", "const fs=require('fs');const f='/data/accounts.json';const d=JSON.parse(fs.readFileSync(f));d.accounts=d.accounts.filter(a=>a.handle!=='eve');fs.writeFileSync(f,JSON.stringify(d));fs.rmSync('/data/wallet/eve',{recursive:true,force:true})"]);
    compose(["restart", "app"]);
    await waitForApp();
    await sleep(1500);
    check("a session outlives a restart of the app", (await dana.get("/api/me")).status === 200);
    const thread = await dana.get(`${at("public", "general")}/messages`);
    check("and so does every message", thread.data?.messages.length === 2 && thread.data.messages[0].text === "Good morning. This is our own ledger now.");
    const back = await dana.post("/api/admin/people", { handle: "eve", name: "Eve Lindqvist", title: "Finance", role: "member" });
    check("a person whose account was lost can be added again under the same handle", back.status === 200 && back.data.link.includes("?invite="), `${back.status} ${back.code} ${back.message}`);
    const eveBack = await new Browser().post(`/api/invites/${tokenOf(back.data?.link ?? `${base}/?invite=none`)}`, { password: "eve chose another one" });
    check("and is the same person on the ledger as before", eveBack.status === 200 && eveBack.data.user.id === `eve@${id}`);

    bringUp();
    await waitForApp();
    const overview = await dana.get("/api/w/home/overview");
    check("a second ./chat up changes nothing", overview.status === 200 && overview.data.conversations.some((c) => c.name === "general") && overview.data.conversations.some((c) => c.name === "ops"), `${overview.status} ${overview.message}`);

    // ./chat down removes every container. Everything that matters is in the volumes.
    const before = (await dana.get("/api/network/status")).data.ledgers[0].height;
    compose(["down", "--remove-orphans"]);
    bringUp();
    await waitForApp();
    await sleep(2500);
    const status = await dana.get("/api/network/status");
    check("after ./chat down and ./chat up, she is still signed in", status.status === 200, `${status.status} ${status.message}`);
    const again = await dana.get(`${at("public", "general")}/messages`);
    check("and the ledger is as it was", status.data?.ledgers[0].height === before && again.data?.messages.length === 2, `${status.data?.ledgers[0].height} blocks, was ${before}`);
    const posted = await dana.post(`${at("public", "general")}/messages`, { text: "Back after a restart of everything." });
    check("and takes new messages", posted.status === 200 && posted.data.receipt.validation === "VALID", posted.message);
  }

  console.log(`\n${passed} checks passed, ${failed.length} failed. Launch took ${launchSeconds} s.`);
  if (failed.length) for (const name of failed) console.log(`  failed: ${name}`);
}

let problem = null;
try {
  await main();
} catch (err) {
  problem = err;
  console.error(`\nThe check stopped: ${err instanceof Error ? err.message : err}`);
  console.error(compose(["logs", "--no-log-prefix", "--tail", "15", "app"], { allowFailure: true }));
}
if (keep) {
  console.log(`\nLeft running at ${base} in ${dir}. Remove it with: docker compose down --volumes  (in that folder)`);
} else {
  remove();
  console.log("The throwaway company is removed.");
}
process.exit(problem || failed.length ? 1 : 0);
