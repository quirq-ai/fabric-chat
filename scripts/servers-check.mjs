#!/usr/bin/env node
// End-to-end check of two companies on two servers.
//
// This machine stands in for the internet (see rig.mjs). Each company gets a server that holds
// Docker and nothing else. On it go the template's two files and a company.json, and ./chat up
// does the rest: it downloads the released images from a registry, makes the company's keys,
// gets an HTTPS certificate for the chat from a certificate authority that checks the name, and
// opens the node's three ports. The two companies then share a workspace, each reaching the
// other only by name, across the network between the servers. Last, one of the servers is lost
// with everything on it, and the company comes back on an empty one from its backup.
//
//   npm run images                    build the three images first
//   npm run test:servers              run the check (about ten minutes)
//   npm run test:servers -- --keep    leave the servers running afterwards
//
// It uses ports 4811, 4812, 5077 and 15077 on this machine, and the network 10.77.0.0/24 in Docker.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checker, root, sleep, tokenOf, version } from "./lib.mjs";
import { REGISTRY, REGISTRY_HERE, Rig, Visitor, run } from "./rig.mjs";

const keep = process.argv.includes("--keep");
const checks = checker();
const { check, section, failed } = checks;

const rig = new Rig([
  { name: "aster", id: "aster.example", address: 11, port: 4811 },
  { name: "dune", id: "dune.example", address: 12, port: 4812 },
]);
const people = {
  aster: { company: "Aster Labs", color: "#6c5ce7", admin: { handle: "alice", name: "Alice Ahn", title: "Founder" }, password: "aster labs passphrase" },
  dune: { company: "Dune Freight", color: "#c2410c", admin: { handle: "dana", name: "Dana Okafor", title: "Operations lead" }, password: "dune freight passphrase" },
};
const at = (channel, scope, conv) => `/api/w/${channel}/conversations/${encodeURIComponent(scope)}/${encodeURIComponent(conv)}`;
const linkIn = (text) => /(https?:\/\/\S+\?invite=\S+)/.exec(text)?.[1] ?? "";

/** What a company's server is given: its names, and where its images and its certificate come from. */
function settingsFor(name) {
  const { id } = rig.server(name);
  return {
    name: people[name].company,
    id,
    color: people[name].color,
    hosts: { chat: `chat.${id}`, peer: `peer.${id}`, orderer: `orderer.${id}` },
    admin: people[name].admin,
    // On the internet this is the one word "auto", and the authority is Let's Encrypt.
    https: rig.https(),
    node: { address: "0.0.0.0" },
    images: `${REGISTRY}/fabric-chat`,
    release: version,
  };
}

async function until(test, seconds = 120, every = 2000) {
  const started = Date.now();
  while (Date.now() - started < seconds * 1000) {
    if (await test()) return Math.round((Date.now() - started) / 1000);
    await sleep(every);
  }
  return -1;
}
const isReady = (visitor, channel) => async () => (await visitor.get("/api/admin/companies")).data?.workspaces.find((w) => w.channel === channel)?.status === "ready";
const isShown = (visitor, channel) => async () => !!(await visitor.get("/api/me")).data?.workspaces.includes(channel);

async function main() {
  const started = Date.now();
  section("The stand-in for the internet");
  rig.start();
  const issuingRoot = await rig.issuingRoot();
  // Publishing a release: the same command that would send it to a public registry.
  const sent = spawnSync("node", [path.join(root, "scripts", "images.mjs"), "--push", `${REGISTRY_HERE}/fabric-chat`], { encoding: "utf8", cwd: root });
  check("npm run images -- --push sends the release to a registry", sent.status === 0 && sent.stdout.includes("Sent."), (sent.stderr || sent.stdout).trim().split("\n").slice(-3).join(" "));
  await Promise.all(rig.servers.map((server) => rig.startServer(server.name)));
  console.log(`  Two empty servers, a name server, a registry and a certificate authority are up after ${Math.round((Date.now() - started) / 1000)} s.`);

  section("Each company launches on its own server");
  const visitors = {};
  const links = {};
  for (const { name, id, port } of rig.servers) {
    rig.install(name, settingsFor(name));
    const before = rig.on(name, "docker image ls --format '{{.Repository}}' | sort -u | tr '\\n' ' '");
    const launched = Date.now();
    const up = rig.on(name, "sh ./chat up", { allowFailure: true });
    const seconds = Math.round((Date.now() - launched) / 1000);
    links[name] = linkIn(up);
    check(`${people[name].company}: ./chat up launches it from two files and a company.json (${seconds} s)`, up.includes(`${people[name].company} (${id}) is up.`), up.trim().split("\n").slice(-6).join(" | "));
    const images = rig.on(name, "docker image ls --format '{{.Repository}}:{{.Tag}}'");
    check("  the three images came from the registry", !before.includes("fabric-chat") && ["app", "ctl", "chaincode"].every((part) => images.includes(`${REGISTRY}/fabric-chat-${part}:${version}`)) && up.includes(`Getting ${REGISTRY}/fabric-chat-ctl:${version}`), images.split("\n").filter((l) => l.includes("fabric-chat")).join(" "));
    check("  the chat's address and the first administrator's link are https, at the company's own name", up.includes(`Chat:  https://chat.${id}`) && links[name].startsWith(`https://chat.${id}/?invite=`), links[name] || "no link");

    // A browser here trusts the authority's root, as a real one trusts Let's Encrypt's.
    const visitor = new Visitor({ host: `chat.${id}`, port, ca: issuingRoot });
    visitors[name] = visitor;
    let health;
    try {
      health = await visitor.answering();
    } catch (err) {
      health = { status: 0, message: err.message };
    }
    const cert = health.certificate ?? {};
    check("  the chat answers over HTTPS with a certificate the authority issued for its name", health.status === 200 && String(cert.subjectaltname).includes(`chat.${id}`) && /Pebble/i.test(JSON.stringify(cert.issuer ?? {})), health.message || `${cert.subjectaltname} from ${JSON.stringify(cert.issuer)}`);
    check("  and tells browsers to keep to HTTPS", String(health.headers?.["strict-transport-security"]).includes("max-age"));
    const plain = rig.plainHttp(`chat.${id}`);
    check("  plain HTTP is sent on to HTTPS", /^HTTP\/1\.[01] 30[18]/.test(plain) && /location: https:\/\/chat\./i.test(plain), plain.split("\n").slice(0, 3).join(" | "));

    const open = [443, 80, 7051, 7050, 7055].filter((p) => rig.reaches(p >= 7050 && p !== 7051 ? `orderer.${id}` : p === 7051 ? `peer.${id}` : `chat.${id}`, p));
    check("  from outside, the chat and the node's three ports are open", open.join() === "443,80,7051,7050,7055", `open: ${open.join()}`);
    // The app itself, the certificate authority, the database, the orderer's admin and metrics ports, the chaincode.
    const closed = [8080, 8081, 7054, 5984, 7053, 9443, 9999].filter((p) => rig.reaches(`chat.${id}`, p));
    check("  and nothing else is: not the app itself, the certificate authority, the database or any admin port", closed.length === 0, `also open: ${closed.join()}`);

    const signed = await visitor.post(`/api/invites/${tokenOf(links[name] || "https://x/?invite=none")}`, { password: people[name].password });
    check("  the first administrator signs in, and the session cookie is marked Secure", signed.status === 200 && /;\s*Secure/i.test(visitor.setCookie) && /HttpOnly/i.test(visitor.setCookie), `${signed.status} ${signed.message} ${visitor.setCookie}`);
  }
  const { aster: alice, dune: dana } = visitors;

  section("Before they connect, each server says whether it can reach the other");
  const aliceView = (await alice.get("/api/admin/companies")).data;
  const danaView = (await dana.get("/api/admin/companies")).data;
  const card = JSON.parse(Buffer.from(danaView.card.text.split(":")[1], "base64url").toString("utf8"));
  check("a card names the node by its public names and ports", card.peer === "peer.dune.example:7051" && card.orderer === "orderer.dune.example:7050" && card.cluster === "orderer.dune.example:7055", JSON.stringify({ peer: card.peer, orderer: card.orderer, cluster: card.cluster }));
  const three = (reach, test) => ["peer", "orderer", "cluster"].every((part) => test(reach?.[part] ?? {}));
  const brief = (reach) => (reach ? ["peer", "orderer", "cluster"].map((part) => `${part} ${reach[part].reached ? (reach[part].proven ? "proven" : "NOT proven") : "silent"}`).join(", ") : "no answer");
  let tried = await alice.post("/api/admin/cards/reach", { text: danaView.card.text });
  check("Aster's node reaches Dune's peer and orderer, and each proves it is Dune's by its certificate", tried.status === 200 && three(tried.data, (p) => p.reached && p.proven), `${tried.status} ${tried.message} ${brief(tried.data)}`);
  rig.on("dune", "docker compose stop orderer", { allowFailure: true });
  tried = await alice.post("/api/admin/cards/reach", { text: danaView.card.text });
  check("with Dune's orderer stopped, Aster is told which addresses are silent", tried.status === 200 && tried.data.peer.proven && !tried.data.orderer.reached && !tried.data.cluster.reached, brief(tried.data));
  rig.on("dune", "docker compose start orderer", { allowFailure: true });
  // Somebody else's certificates under Dune's addresses: each certificate is real and the card
  // adds up, but Dune's own authority issued none of it.
  const forged = JSON.parse(
    run(["run", "--rm", "--entrypoint", "sh", `fabric-chat-ctl:${version}`, "-c", [
      "cd /tmp",
      'printf "[req]\\ndistinguished_name=dn\\nx509_extensions=v3\\nprompt=no\\n[dn]\\nO=dune.example\\nCN=ca.dune.example\\n[v3]\\nbasicConstraints=critical,CA:TRUE\\nkeyUsage=critical,digitalSignature,keyCertSign\\n" >root.cnf',
      "openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout root.key -out root.pem -days 30 -config root.cnf 2>/dev/null",
      'openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout key.pem -out leaf.csr -subj "/O=dune.example/CN=orderer.dune.example" 2>/dev/null',
      "printf 'subjectAltName=DNS:orderer.dune.example\\n' >ext.cnf",
      "openssl x509 -req -in leaf.csr -CA root.pem -CAkey root.key -CAcreateserial -out cert.pem -days 30 -extfile ext.cnf 2>/dev/null",
      "jq -n --rawfile root root.pem --rawfile cert cert.pem '{root: $root, cert: $cert}'",
    ].join(" && ")]),
  );
  const impostor = "fabric-chat-card:" + Buffer.from(JSON.stringify({ ...card, id: "dune-freight.example", ca: forged.root, ordererTls: forged.cert })).toString("base64url");
  const seen = await alice.post("/api/admin/cards/check", { text: impostor });
  tried = await alice.post("/api/admin/cards/reach", { text: impostor });
  check("a card that gives Dune's addresses under another root certificate: something answers, and it is not taken for that card's node", seen.status === 200 && tried.status === 200 && three(tried.data, (p) => p.reached && !p.proven), `${seen.status} ${seen.message} | ${tried.status} ${tried.message} ${brief(tried.data)}`);
  const settled = await until(async () => three((await alice.post("/api/admin/cards/reach", { text: danaView.card.text })).data, (p) => p.reached && p.proven), 60);
  check("with the orderer started again, all three answer", settled >= 0);

  section("The two companies share a workspace, server to server");
  const made = await alice.post("/api/admin/workspaces", { name: "Aster and Dune", cards: [danaView.card.text] });
  const shared = made.data?.channel;
  check("Aster starts a workspace from Dune's card", made.status === 200 && /^ws-[0-9a-f]{10}$/.test(shared ?? ""), `${made.status} ${made.message}`);
  const looked = await dana.post("/api/admin/invitations/check", { text: made.data?.invitation ?? "" });
  check("Dune checks the invitation, and sees that its node reaches Aster's", looked.status === 200 && three(looked.data.members.find((m) => m.id === "aster.example")?.reach, (p) => p.reached && p.proven), `${looked.status} ${looked.message}`);
  const accepted = await dana.post("/api/admin/invitations/accept", { text: made.data?.invitation ?? "" });
  const danaSeconds = await until(isReady(dana, shared));
  const aliceSeconds = await until(isReady(alice, shared));
  check(`Dune accepts, and the rules come into force at both across the network (${Math.max(danaSeconds, aliceSeconds)} s)`, accepted.status === 200 && danaSeconds >= 0 && aliceSeconds >= 0, `${accepted.status} ${accepted.message} dune ${danaSeconds} aster ${aliceSeconds}`);
  await until(isShown(alice, shared), 90);
  await until(isShown(dana, shared), 90);
  const channel = await alice.post(`/api/w/${shared}/conversations`, { kind: "channel", name: "general", topic: "Both companies", members: [], open: true });
  const hello = await alice.post(`${at(shared, "public", "general")}/messages`, { text: "Hello Dune, from another server." });
  const endorsers = hello.data?.receipt.endorsers.map((e) => e.msp).sort().join();
  check("Alice's message is endorsed by both companies' peers, each on its own server", channel.status === 200 && hello.status === 200 && endorsers === "aster.example,dune.example", `${channel.status} ${hello.status} ${endorsers} ${hello.message}`);
  const read = await dana.get(`${at(shared, "public", "general")}/messages`);
  check("Dana reads it through Dune's own peer", read.status === 200 && read.data.messages.some((m) => m.author === "alice@aster.example" && m.text.startsWith("Hello Dune")), `${read.status} ${read.message}`);
  const row = [];
  for (let i = 1; i <= 5; i++) {
    row.push(await dana.post(`${at(shared, "public", "general")}/messages`, { text: `From Dune, ${i}` }));
    row.push(await alice.post(`${at(shared, "public", "general")}/messages`, { text: `From Aster, ${i}` }));
  }
  const times = row.filter((sent) => sent.status === 200).map((sent) => sent.data.receipt.endorseMs + sent.data.receipt.orderMs + sent.data.receipt.commitMs).sort((a, b) => a - b);
  check(`ten more go back and forth, each sent once (${times[Math.floor(times.length / 2)] ?? "-"} ms for one, at the middle)`, row.every((sent) => sent.status === 200), [...new Set(row.filter((sent) => sent.status !== 200).map((sent) => `${sent.status} ${sent.code}`))].join());
  const heights = {};
  for (const { name } of rig.servers) heights[name] = /ws-[0-9a-f]{10}\s+(\d+)\s+(\S+)/.exec(rig.on(name, "sh ./chat status", { allowFailure: true }))?.slice(1).join(" ");
  check("both servers hold the same ledger for it: the same height and the same newest block", !!heights.aster && heights.aster === heights.dune, JSON.stringify(heights));

  section("A server goes away and comes back");
  run(["stop", "-t", "20", rig.server("dune").container]);
  const blocked = await alice.post(`${at(shared, "public", "general")}/messages`, { text: "Is Dune there?" });
  check("with Dune's server off, the workspace of two refuses messages", blocked.status >= 500, `${blocked.status} ${blocked.code}`);
  const home = await alice.post(`${at("home", "public", "general")}/messages`, { text: "Aster's own workspace carries on." });
  check("and Aster's own workspace carries on", home.status === 200, `${home.status} ${home.message}`);
  run(["start", rig.server("dune").container]);
  await rig.dockerUp("dune");
  let back;
  const backSeconds = await until(async () => (back = await dana.get("/api/me").catch(() => null))?.status === 200, 180);
  check(`when the server starts again, everything on it comes back by itself, and Dana is still signed in (${backSeconds} s)`, backSeconds >= 0, `${back?.status} ${back?.message}`);
  let again;
  const againSeconds = await until(async () => (again = await alice.post(`${at(shared, "public", "general")}/messages`, { text: "Welcome back, Dune." })).status === 200, 180, 3000);
  check(`and the shared workspace takes messages again (${againSeconds} s later)`, againSeconds >= 0, `${again?.status} ${again?.code}`);
  const caught = await until(async () => (await dana.get(`${at(shared, "public", "general")}/messages`)).data?.messages.some((m) => m.text === "Welcome back, Dune."), 60);
  check("Dune's peer has what was said since", caught >= 0);

  section("A backup, a lost server, and a restore");
  const passphrase = "four unrelated words here";
  const aster = rig.server("aster");
  const general = `${at(shared, "public", "general")}/messages`;
  // A channel for Aster's own people inside the shared workspace. Fabric keeps what is said there
  // on Aster's node and nowhere else, so it is the part of a shared workspace a backup matters for.
  const hired = await alice.post("/api/admin/people", { handle: "bea", name: "Bea Lindqvist", title: "", role: "member" });
  const bea = new Visitor({ host: "chat.aster.example", port: aster.port, ca: issuingRoot });
  await bea.post(`/api/invites/${tokenOf(hired.data?.link ?? "https://x/?invite=none")}`, { password: "bea chose this one" });
  await until(isShown(bea, shared), 90);
  const own = await alice.post(`/api/w/${shared}/conversations`, { kind: "channel", name: "aster-only", topic: "Aster's people", members: ["bea@aster.example"], open: false });
  const ours = `${at(shared, own.data?.conversation.scope ?? "none", own.data?.conversation.id ?? "none")}/messages`;
  const kept = await alice.post(ours, { text: "Among ourselves, before the backup." });
  const toEdit = await alice.post(ours, { text: "To be edited after the backup." });
  check("Aster's people have a channel of their own in the shared workspace, kept on Aster's node only", own.status === 200 && own.data.conversation.scope === "_implicit_org_aster.example" && kept.status === 200 && toEdit.status === 200, `${own.status} ${own.message} ${kept.status} ${toEdit.status}`);
  const short = rig.on("aster", "sh ./chat backup", { env: { CHAT_BACKUP_PASSPHRASE: "too short" }, allowFailure: true });
  check("a passphrase shorter than 12 characters is refused before anything is paused", short.includes("at least 12 characters") && (await alice.get("/api/me")).status === 200, short.trim().split("\n").slice(-2).join(" | "));
  const backingUp = Date.now();
  const backed = rig.on("aster", "sh ./chat backup", { env: { CHAT_BACKUP_PASSPHRASE: passphrase }, allowFailure: true });
  const file = /backups\/(\S+\.fcbackup)/.exec(backed)?.[1] ?? "none";
  check(`./chat backup copies everything the company has into one file, and starts everything again (${Math.round((Date.now() - backingUp) / 1000)} s in all)`, file !== "none" && backed.includes("Everything is running again."), backed.trim().split("\n").slice(-4).join(" | "));
  const facts = rig.on("aster", `ls -l backups/${file} | cut -c1-10; head -c 20 backups/${file}; echo; grep -c 'PRIVATE KEY' backups/${file}`, { allowFailure: true }).trim().split("\n");
  check("the file can be read by its owner only, and no key can be read in it", facts[0] === "-rw-------" && facts[1] === "FABRIC-CHAT-BACKUP-1" && facts[2] === "0", facts.join(" | "));

  // What happens after the backup: a message in the shared workspace, one at home, and a sign-in on a second device.
  let sharedAfter;
  await until(async () => (sharedAfter = await alice.post(general, { text: "Said in the shared workspace after the backup." }).catch(() => ({ status: 0 }))).status === 200, 180, 3000);
  const homeAfter = await alice.post(`${at("home", "public", "general")}/messages`, { text: "Said at home after the backup." });
  const oursAfter = await alice.post(ours, { text: "Among ourselves, after the backup." });
  const editedAfter = await alice.patch(`${ours}/${toEdit.data?.message.id}`, { text: "Edited after the backup." });
  const second = new Visitor({ host: "chat.aster.example", port: aster.port, ca: issuingRoot });
  const secondIn = await second.post("/api/session", { handle: "alice", password: people.aster.password });
  check("afterwards Alice writes in the shared workspace, at home and among Aster's own people, edits a message there, and signs in on a second device", sharedAfter?.status === 200 && homeAfter.status === 200 && oursAfter.status === 200 && editedAfter.status === 200 && secondIn.status === 200, `${sharedAfter?.status} ${homeAfter.status} ${oursAfter.status} ${editedAfter.status} ${secondIn.status}`);
  const certificateBefore = (await alice.get("/api/health")).certificate.fingerprint256;
  const said = (await dana.get(general)).data.messages.length;

  // The file leaves the server. Then the server is lost with everything on it, and an empty one takes its address.
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-chat-backup-"));
  run(["cp", `${aster.container}:/srv/chat/backups/${file}`, path.join(out, file)]);
  const settings = JSON.parse(rig.on("aster", "cat company.json"));
  const replacing = Date.now();
  await rig.startServer("aster");
  rig.install("aster", settings);
  rig.on("aster", "mkdir -p backups");
  const bytes = fs.readFileSync(path.join(out, file));
  const bent = Buffer.from(bytes);
  bent[Math.floor(bent.length / 2)] ^= 1;
  fs.writeFileSync(path.join(out, "bent.fcbackup"), bent);
  fs.writeFileSync(path.join(out, "cut.fcbackup"), bytes.subarray(0, bytes.length - 4000));
  for (const name of [file, "bent.fcbackup", "cut.fcbackup"]) run(["cp", path.join(out, name), `${aster.container}:/srv/chat/backups/${name}`]);
  fs.rmSync(out, { recursive: true, force: true });
  console.log(`  Aster's server is gone. An empty one stands at its address after ${Math.round((Date.now() - replacing) / 1000)} s, with the two template files, company.json and the backup.`);

  const restore = (name, secret) => rig.on("aster", `sh ./chat restore backups/${name}`, { env: { CHAT_BACKUP_PASSPHRASE: secret }, allowFailure: true });
  const nothingLeft = () => {
    const left = rig.on("aster", "ls -a | tr '\\n' ' '; docker volume ls -q | wc -l", { allowFailure: true }).trim();
    return !left.includes(".env") && !left.includes("compose.generated.yaml") && / 0$/.test(left);
  };
  const last = (text) => text.trim().split("\n").slice(-3).join(" | ");
  const wrong = restore(file, "not the right words at all");
  check("the wrong passphrase is refused, and nothing is left behind", wrong.includes("not the passphrase") && wrong.includes("Nothing was restored") && nothingLeft(), last(wrong));
  const damaged = restore("bent.fcbackup", passphrase);
  check("so is a copy with one byte changed", /damaged/.test(damaged) && damaged.includes("Nothing was restored") && nothingLeft(), last(damaged));
  const cut = restore("cut.fcbackup", passphrase);
  check("and a copy that was cut short", /cut short/.test(cut) && cut.includes("Nothing was restored") && nothingLeft(), last(cut));
  const other = rig.on("aster", `sed -i 's/aster.example/other.example/g' company.json; sh ./chat restore backups/${file}; sed -i 's/other.example/aster.example/g' company.json`, { env: { CHAT_BACKUP_PASSPHRASE: passphrase }, allowFailure: true });
  check("a backup cannot be restored as another company", other.includes("company.json is for other.example") && nothingLeft(), last(other));

  const restoring = Date.now();
  const restored = restore(file, passphrase);
  check(`with the right passphrase the company is back, on the new server (${Math.round((Date.now() - restoring) / 1000)} s)`, restored.includes("Restored") && restored.includes("Aster Labs (aster.example) is up."), last(restored));
  const stillIn = await until(async () => (await alice.get("/api/me").catch(() => ({ status: 0 }))).status === 200, 120);
  check("Alice's first device is still signed in: its session was in the backup", stillIn >= 0);
  check("her second device is not: it signed in after the backup was made", (await second.get("/api/me")).status === 401);
  check("her password is still the one she chose", (await second.post("/api/session", { handle: "alice", password: people.aster.password })).status === 200);
  check("the chat has the same HTTPS certificate as before: none had to be issued again", (await alice.get("/api/health")).certificate.fingerprint256 === certificateBefore);
  const whole = await until(async () => (await alice.get(general)).data?.messages.length >= said, 180);
  const now = (await alice.get(general)).data?.messages ?? [];
  check(`the shared workspace is whole, with what was said after the backup: Aster's node got it back from Dune's (${whole} s)`, whole >= 0 && now.some((m) => m.text === "Said in the shared workspace after the backup."), `${now.length} of ${said}`);
  const oursNow = ((await alice.get(ours)).data?.messages ?? []).map((m) => m.text);
  check(
    "the channel of Aster's own people is as it was at the backup: what was written or edited there afterwards was held by no other server",
    oursNow.includes("Among ourselves, before the backup.") && oursNow.includes("To be edited after the backup.") && !oursNow.includes("Among ourselves, after the backup.") && !oursNow.includes("Edited after the backup."),
    oursNow.join(" | "),
  );
  const oursMore = await alice.post(ours, { text: "Among ourselves, after the restore." });
  check("it takes new messages", oursMore.status === 200, `${oursMore.status} ${oursMore.code} ${oursMore.message}`);
  const stuck = await alice.patch(`${ours}/${toEdit.data?.message.id}`, { text: "Edited again." });
  check("the message edited after the backup can no longer be changed, and the app says why in plain words", stuck.status === 409 && stuck.code === "CHAT_OLDER_COPY" && stuck.message.includes("restored from a backup"), `${stuck.status} ${stuck.code} ${stuck.message}`);
  const holds = (await alice.get(`${ours}/${toEdit.data?.message.id}/holdings`)).data?.holdings.find((h) => h.org === "aster.example");
  check("and the ledger panel is told that Aster's peer holds an older version of it", holds?.older === true && holds.held === false, JSON.stringify(holds));
  const atHome = (await alice.get(`${at("home", "public", "general")}/messages`)).data?.messages ?? [];
  check("what was said at home after the backup is gone: no other server ever held it", atHome.length > 0 && !atHome.some((m) => m.text === "Said at home after the backup."), atHome.map((m) => m.text).join(" | "));
  let returned;
  const talking = await until(async () => (returned = await alice.post(general, { text: "Aster is back, on a new server." })).status === 200, 180, 3000);
  const heard = await until(async () => (await dana.get(general)).data?.messages.some((m) => m.text === "Aster is back, on a new server."), 60);
  const reply = await dana.post(general, { text: "Good to have you back." });
  const got = await until(async () => (await alice.get(general)).data?.messages.some((m) => m.text === "Good to have you back."), 60);
  check(`the two companies talk again, each through its own peer (${talking} s after the restore)`, talking >= 0 && heard >= 0 && reply.status === 200 && got >= 0, `${returned?.status} ${returned?.code} ${heard} ${reply.status} ${got}`);
  const added = await alice.post("/api/admin/people", { handle: "arjun", name: "Arjun Rao", title: "", role: "member" });
  check("the restored certificate authority still signs: an administrator adds a person", added.status === 200 && String(added.data?.link).startsWith("https://chat.aster.example/?invite="), `${added.status} ${added.message}`);
  for (const { name } of rig.servers) heights[name] = /ws-[0-9a-f]{10}\s+(\d+)\s+(\S+)/.exec(rig.on(name, "sh ./chat status", { allowFailure: true }))?.slice(1).join(" ");
  check("and both servers hold the same ledger again", !!heights.aster && heights.aster === heights.dune, JSON.stringify(heights));

  console.log(`\n${checks.passed} checks passed, ${failed.length} failed. The whole run took ${Math.round((Date.now() - started) / 1000)} s.`);
  for (const name of failed) console.log(`  failed: ${name}`);
}

let problem = null;
try {
  await main();
} catch (err) {
  problem = err;
  console.error(`\nThe check stopped: ${err instanceof Error ? err.message : err}`);
}
if (keep) {
  console.log(`\nLeft running: ${rig.servers.map((s) => `${s.container} (chat.${s.id} on port ${s.port} of this machine)`).join(", ")}. Remove them with: docker rm -f -v $(docker ps -aq --filter name=^fc-)`);
} else {
  rig.remove();
  console.log("The servers and everything around them are removed.");
}
process.exit(problem || failed.length ? 1 : 0);
