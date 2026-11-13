#!/usr/bin/env node
// End-to-end check of companies sharing a workspace.
//
// Launches three throwaway companies, each from node-template in a folder of its own, with its own
// keys and its own Docker project. Then does, through each company's own app, what their
// administrators would do: swap cards, start a shared workspace, accept the invitation. Nothing
// crosses from one company to another except a card and an invitation, both public.
//
//   npm run images                      build the three images first
//   npm run test:companies              run the check (about five minutes)
//   npm run test:companies -- --keep    leave the three companies running afterwards
//
// It uses ports 4791 to 4793 on this machine.
import { Browser, Company, checker, docker, sleep, tokenOf } from "./lib.mjs";

const keep = process.argv.includes("--keep");
const dockerNetwork = "fabric-chat-check";
const checks = checker();
const { check, section, failed } = checks;

const north = new Company({ name: "North Mill", id: "north.example", port: 4791, color: "#1d4ed8", admin: { handle: "nora", name: "Nora Lind", title: "Mill manager" }, dockerNetwork });
const south = new Company({ name: "South & Sons", id: "south.example", port: 4792, color: "#b45309", admin: { handle: "sam", name: "Sam Okoro", title: "Buyer" }, dockerNetwork });
const third = new Company({ name: "Third Coast", id: "third.example", port: 4793, color: "#047857", admin: { handle: "tara", name: "Tara Voss", title: "Shipping" }, dockerNetwork });
const all = [north, south, third];

const at = (channel, scope, conv) => `/api/w/${channel}/conversations/${encodeURIComponent(scope)}/${encodeURIComponent(conv)}`;
const unwrap = (text) => JSON.parse(Buffer.from(text.slice(text.indexOf(":") + 1), "base64url").toString("utf8"));
const wrap = (word, value) => word + Buffer.from(JSON.stringify(value)).toString("base64url");

/** Waits until a company's own app says a workspace is ready for people. Returns the seconds it took, or -1. */
async function ready(browser, channel, seconds = 120) {
  const started = Date.now();
  while (Date.now() - started < seconds * 1000) {
    const view = await browser.get("/api/admin/companies");
    if (view.data?.workspaces.find((w) => w.channel === channel)?.status === "ready") return Math.round((Date.now() - started) / 1000);
    await sleep(2000);
  }
  return -1;
}

/**
 * Waits until a workspace shows among a person's own, as their page would. That is a few seconds
 * after it is ready: the server first puts each of the company's people in its directory.
 */
async function shown(browser, channel, seconds = 90) {
  const started = Date.now();
  let me = await browser.get("/api/me");
  while (!me.data?.workspaces.includes(channel) && Date.now() - started < seconds * 1000) {
    await sleep(1500);
    me = await browser.get("/api/me");
  }
  return me;
}

/**
 * Tries a request until it stops being refused for a reason that passes. Only for what the check
 * itself disturbs: a node it has just stopped, started or restarted. Each second try is noted and
 * listed at the end, so that a refusal a person would have seen is never hidden by the check.
 */
const secondTries = [];
async function eventually(what, send, seconds = 60) {
  const started = Date.now();
  let answer = await send();
  while (answer.status >= 500 && Date.now() - started < seconds * 1000) {
    secondTries.push(`${what}: ${answer.status} ${answer.code}`);
    await sleep(2000);
    answer = await send();
  }
  return answer;
}

async function main() {
  const started = Date.now();
  for (const company of all) {
    console.log(`Launching ${company.name} (${company.id}) in ${company.dir}`);
    company.launch();
  }
  const nora = await north.firstAdmin("north mill password");
  const sam = await south.firstAdmin("south sons password");
  const tara = await third.firstAdmin("third coast password");
  console.log(`Three companies up after ${Math.round((Date.now() - started) / 1000)} s.`);

  // A member at North, to check what a member may not do.
  const added = await nora.post("/api/admin/people", { handle: "ned", name: "Ned Brandt", title: "Clerk", role: "member" });
  const ned = new Browser(north.base);
  await ned.post(`/api/invites/${tokenOf(added.data.link)}`, { password: "ned keeps the books" });

  section("Cards");
  const noraView = (await nora.get("/api/admin/companies")).data;
  const samView = (await sam.get("/api/admin/companies")).data;
  const taraView = (await tara.get("/api/admin/companies")).data;
  {
    check("an administrator can copy their company's card", noraView?.card.text.startsWith("fabric-chat-card:") && noraView.card.id === "north.example" && /^[0-9a-f]{64}$/.test(noraView.card.fingerprint));
    const card = unwrap(noraView.card.text);
    check("a card holds nothing secret", !JSON.stringify(card).includes("PRIVATE KEY") && Object.keys(card).sort().join() === "ca,cluster,color,fabricChatCard,id,name,orderer,ordererTls,peer", Object.keys(card).join());
    check("a member cannot see it or anything about other companies", (await ned.get("/api/admin/companies")).status === 403 && (await ned.post("/api/admin/cards/check", { text: samView.card.text })).status === 403);
    const seen = await nora.post("/api/admin/cards/check", { text: samView.card.text });
    check("a pasted card shows who it is from, with the fingerprint its owner sees", seen.status === 200 && seen.data.id === "south.example" && seen.data.name === "South & Sons" && seen.data.fingerprint === samView.card.fingerprint && seen.data.known === "new", JSON.stringify(seen.data ?? seen.message));
    const broken = await nora.post("/api/admin/cards/check", { text: `${samView.card.text.slice(0, 60)}\n   ${samView.card.text.slice(60)}` });
    check("a card broken over two lines by a mail program still reads", broken.status === 200 && broken.data.id === "south.example");
    check("their own card is recognised as their own", (await nora.post("/api/admin/cards/check", { text: noraView.card.text })).data?.known === "self");
    const junk = await nora.post("/api/admin/cards/check", { text: "hello" });
    check("something that is not a card is refused in plain words", junk.status === 400 && junk.message.includes("fabric-chat-card:"), junk.message);
  }

  section("Two companies share a workspace");
  let pair;
  let invitation;
  {
    const own = await nora.post("/api/admin/workspaces", { name: "Just us", cards: [noraView.card.text] });
    check("a workspace cannot be shared with oneself", own.status === 409 && own.message.includes("own"), `${own.status} ${own.message}`);
    const made = await nora.post("/api/admin/workspaces", { name: "North and South", cards: [samView.card.text] });
    pair = made.data?.channel;
    invitation = made.data?.invitation ?? "";
    check("North starts a workspace from South's card and gets an invitation", made.status === 200 && /^ws-[0-9a-f]{10}$/.test(pair) && invitation.startsWith("fabric-chat-invitation:"), `${made.status} ${made.message}`);
    const listed = made.data?.workspaces.find((w) => w.channel === pair);
    check("it waits for South", listed?.status === "waiting" && listed.members.length === 2 && listed.members.some((m) => m.self && m.id === "north.example"), JSON.stringify(listed));
    check("until then nobody at North sees it among their workspaces", !(await nora.get("/api/me")).data.workspaces.includes(pair));
    check("the invitation holds no secret", !Buffer.from(invitation.split(":")[1], "base64url").toString("utf8").includes("PRIVATE KEY"));
    const again = await nora.get(`/api/admin/workspaces/${pair}/invitation`);
    check("North can copy the invitation again later", again.status === 200 && again.data.invitation === invitation);

    const looked = await sam.post("/api/admin/invitations/check", { text: invitation });
    check("South sees who is in it before joining, with fingerprints", looked.status === 200 && looked.data.joined === false && looked.data.members.length === 2 && looked.data.members.find((m) => m.id === "north.example")?.fingerprint === noraView.card.fingerprint && looked.data.members.find((m) => m.self)?.id === "south.example", JSON.stringify(looked.data ?? looked.message));
    const notMine = await tara.post("/api/admin/invitations/check", { text: invitation });
    check("a company that is not in it is told so", notMine.status === 409 && notMine.message.includes("not for Third Coast"), `${notMine.status} ${notMine.message}`);

    // Someone on the way changes where North's peer is said to be. The block no longer matches the cards.
    const bent = unwrap(invitation);
    bent.members = bent.members.map((m) => (m.id === "north.example" ? { ...m, peer: "peer.evil.example:7051" } : m));
    const refused = await sam.post("/api/admin/invitations/accept", { text: wrap("fabric-chat-invitation:", bent) });
    check("an invitation whose cards were changed on the way is refused", refused.status === 409 && refused.message.includes("does not say what the invitation's cards say"), `${refused.status} ${refused.message}`);
    // Someone swaps in Third Coast's certificate under South's name.
    const posed = unwrap(invitation);
    const thirdCard = unwrap(taraView.card.text);
    posed.members = posed.members.map((m) => (m.id === "south.example" ? { ...m, ca: thirdCard.ca, ordererTls: thirdCard.ordererTls } : m));
    const wrongMe = await sam.post("/api/admin/invitations/accept", { text: wrap("fabric-chat-invitation:", posed) });
    check("so is one that describes the invited company wrongly", wrongMe.status === 409, `${wrongMe.status} ${wrongMe.message}`);
    check("after those refusals South is on no shared workspace", (await sam.get("/api/admin/companies")).data.workspaces.length === 0);

    const accepted = await sam.post("/api/admin/invitations/accept", { text: invitation });
    check("South accepts the real invitation", accepted.status === 200 && accepted.data.joined === true && accepted.data.channel === pair, `${accepted.status} ${accepted.message}`);
    const southSeconds = await ready(sam, pair);
    const northSeconds = await ready(nora, pair);
    check(`the rules come into force at both, with nobody clicking again (${southSeconds} s after accepting)`, southSeconds >= 0 && northSeconds >= 0, `south ${southSeconds}, north ${northSeconds}`);
    const twice = await sam.post("/api/admin/invitations/accept", { text: invitation });
    check("accepting the same invitation twice does no harm", twice.status === 200 && (await sam.get("/api/admin/companies")).data.workspaces.length === 1);
  }

  section("People of two companies talk");
  {
    const me = await shown(nora, pair);
    check("the workspace appears for people at North, once they are in its directory", me.data.workspaces.includes(pair) && me.data.workspaces.includes("home"));
    const net = (await nora.get("/api/network")).data;
    const shared = net.workspaces.find((w) => w.channel === pair);
    check("with both companies on it", shared?.orgs.join() === "north.example,south.example" && net.orgs.find((o) => o.code === "south.example")?.name === "South & Sons" && net.orgs.find((o) => o.code === "south.example")?.own === false);
    const made = await nora.post(`/api/w/${pair}/conversations`, { kind: "channel", name: "general", topic: "Both companies", members: [], open: true });
    check("Nora starts #general there, at the first try", made.status === 200 && made.data.conversation.scope === "public", `${made.status} ${made.message}`);
    const said = await nora.post(`${at(pair, "public", "general")}/messages`, { text: "Hello South. Our companies were set up separately." });
    const endorsers = said.data?.receipt.endorsers.map((e) => e.msp).sort().join();
    check("her message is endorsed by both companies' peers", said.status === 200 && endorsers === "north.example,south.example", `${said.status} ${endorsers} ${said.message}`);

    await shown(sam, pair);
    const read = await sam.get(`${at(pair, "public", "general")}/messages`);
    check("Sam reads it through South's own peer", read.status === 200 && read.data.messages.some((m) => m.author === "nora@north.example" && m.text.startsWith("Hello South")), `${read.status} ${read.message}`);
    const reply = await sam.post(`${at(pair, "public", "general")}/messages`, { text: "Hello North. All that crossed was a card each and one block." });
    const back = await nora.get(`${at(pair, "public", "general")}/messages`);
    check("and Nora reads his reply through North's", reply.status === 200 && back.data.messages.some((m) => m.author === "sam@south.example"));
    const people = (await nora.get(`/api/w/${pair}/overview`)).data.people.map((p) => p.id).sort();
    check("the workspace's directory lists people of both companies", people.includes("nora@north.example") && people.includes("sam@south.example"), people.join());
    const notHis = await sam.patch(`${at(pair, "public", "general")}/messages/${said.data.message.id}`, { text: "Rewritten at South" });
    check("nobody can edit a message from the other company", notHis.status === 403 && notHis.code === "CHAT_NOT_AUTHOR");

    const held = await nora.get(`${at(pair, "public", "general")}/messages/${said.data.message.id}/holdings`);
    const mine = held.data?.holdings.find((h) => h.org === "north.example");
    const theirs = held.data?.holdings.find((h) => h.org === "south.example");
    check("North's app asks North's peer what it holds, and does not claim to have asked South's", mine?.asked === true && mine.held === true && mine.matches === true && theirs?.asked === false && theirs.held === true, JSON.stringify(held.data?.holdings));

    await shown(ned, pair);
    const inside = await nora.post(`/api/w/${pair}/conversations`, { kind: "channel", name: "mill-floor", topic: "North only", members: ["ned@north.example"], open: false });
    const scope = inside.data?.conversation.scope;
    check("a channel of North's people only stays in North's own store", inside.status === 200 && scope === "_implicit_org_north.example", `${inside.status} ${scope} ${inside.message}`);
    const secret = await nora.post(`${at(pair, scope, inside.data.conversation.id)}/messages`, { text: "Our floor price is 41." });
    check("only North's peer endorses a message there", secret.status === 200 && secret.data.receipt.endorsers.map((e) => e.msp).join() === "north.example", JSON.stringify(secret.data?.receipt.endorsers ?? secret.message));
    const southList = (await sam.get(`/api/w/${pair}/overview`)).data.conversations.map((c) => c.name);
    const southRead = await sam.get(`${at(pair, scope, inside.data.conversation.id)}/messages`);
    check("South neither lists it nor can open it", !southList.includes("mill-floor") && southRead.status === 403, `${southList.join()} ${southRead.status} ${southRead.code}`);
    const both = await nora.post(`/api/w/${pair}/conversations`, { kind: "dm", members: ["sam@south.example"] });
    check("a direct message across the two companies is kept by both", both.status === 200 && both.data.scope.kind === "public", `${both.status} ${both.message}`);

    check("Third Coast cannot tell the workspace exists", !(await tara.get("/api/me")).data.workspaces.includes(pair) && (await tara.get(`/api/w/${pair}/overview`)).status === 404);
    check("South still cannot see into North's own workspace", (await sam.get("/api/network")).data.workspaces.filter((w) => w.orgs.includes("north.example")).length === 1);
  }

  section("Three companies share a workspace");
  let trio;
  {
    const made = await nora.post("/api/admin/workspaces", { name: "All three", cards: [samView.card.text, taraView.card.text] });
    trio = made.data?.channel;
    check("North starts a workspace with South and Third Coast", made.status === 200 && made.data.workspaces.find((w) => w.channel === trio)?.members.length === 3, `${made.status} ${made.message}`);
    const one = await sam.post("/api/admin/invitations/accept", { text: made.data.invitation });
    const twoOfThree = await ready(sam, trio);
    check(`with two of the three joined, the workspace is already usable (${twoOfThree} s)`, one.status === 200 && twoOfThree >= 0 && (await ready(nora, trio)) >= 0, `${one.status} ${one.message}`);
    await shown(nora, trio);
    await shown(sam, trio);
    const early = await nora.post(`/api/w/${trio}/conversations`, { kind: "channel", name: "general", topic: "Everyone", members: [], open: true });
    const before = await nora.post(`${at(trio, "public", "general")}/messages`, { text: "Said before Third Coast arrived." });
    check("and takes messages", early.status === 200 && before.status === 200, `${early.status} ${early.message} ${before.status} ${before.message}`);
    // Third Coast's orderer is running and is named in the workspace's rules, but is not on the
    // channel yet. A peer that hands it a message is turned away, which happens about one time in
    // three. Nobody writing should notice: twelve in a row, each sent once.
    const row = [];
    for (let i = 1; i <= 6; i++) {
      row.push(await nora.post(`${at(trio, "public", "general")}/messages`, { text: `North, while waiting for Third Coast, ${i}` }));
      row.push(await sam.post(`${at(trio, "public", "general")}/messages`, { text: `South, while waiting for Third Coast, ${i}` }));
    }
    const taken = row.filter((sent) => sent.status === 200);
    const offeredAgain = [early, before, ...taken].filter((sent) => sent.data?.receipt?.offers > 1).length;
    check(
      `every message is taken while the third company has not answered (${taken.length} of ${row.length}; the server offered ${offeredAgain} of them to the orderers a second time)`,
      taken.length === row.length,
      [...new Set(row.filter((sent) => sent.status !== 200).map((sent) => `${sent.status} ${sent.code}`))].join(", "),
    );

    const late = await tara.post("/api/admin/invitations/accept", { text: made.data.invitation });
    const lateSeconds = await ready(tara, trio);
    check(`the third company joins later and catches up (${lateSeconds} s)`, late.status === 200 && lateSeconds >= 0, `${late.status} ${late.message}`);
    await shown(tara, trio);
    const caught = await tara.get(`${at(trio, "public", "general")}/messages`);
    check("it reads what was said before it arrived", caught.status === 200 && caught.data.messages.some((m) => m.text === "Said before Third Coast arrived."), `${caught.status} ${caught.message}`);
    const said = await tara.post(`${at(trio, "public", "general")}/messages`, { text: "Third Coast is here." });
    const heard = await sam.get(`${at(trio, "public", "general")}/messages`);
    check("and all three talk", said.status === 200 && heard.data?.messages.some((m) => m.author === "tara@third.example"), `${said.status} ${said.message}`);
    check("each company sees its own two workspaces and the shared ones it is on", (await tara.get("/api/me")).data.workspaces.sort().join() === ["home", trio].sort().join() && (await sam.get("/api/me")).data.workspaces.length === 3);
  }

  section("One company is away");
  {
    south.compose(["stop", "peer", "orderer"]);
    await sleep(3000);
    const blocked = await nora.post(`${at(pair, "public", "general")}/messages`, { text: "Is anyone there?" });
    check("a workspace of two refuses messages while one company's node is off", blocked.status === 503 && ["LEDGER_NO_ENDORSERS", "LEDGER_NO_ORDERERS", "LEDGER_DOWN"].includes(blocked.code), `${blocked.status} ${blocked.code}`);
    const home = await nora.post(`${at("home", "public", "general")}/messages`, { text: "North's own workspace carries on." });
    check("North's own workspace is not affected", home.status === 200, `${home.status} ${home.message}`);
    const two = await eventually("three companies, one node just stopped", () => nora.post(`${at(trio, "public", "general")}/messages`, { text: "Two of three are enough." }), 90);
    check("a workspace of three carries on with two", two.status === 200, `${two.status} ${two.code} ${two.message}`);
    south.compose(["start", "peer", "orderer"]);
    const back = await eventually("two companies, one node just started again", () => nora.post(`${at(pair, "public", "general")}/messages`, { text: "Welcome back." }), 120);
    check("when the node returns, the workspace of two takes messages again", back.status === 200, `${back.status} ${back.code} ${back.message}`);
    const caught = await eventually("reading at the company whose node just started again", () => sam.get(`${at(trio, "public", "general")}/messages`), 60);
    check("and the returning company has what it missed", caught.data?.messages.some((m) => m.text === "Two of three are enough."), `${caught.status}`);
  }

  section("After a restart");
  {
    north.compose(["restart", "agent", "app"]);
    await north.answering();
    await sleep(3000);
    const view = await nora.get("/api/admin/companies");
    check("North still lists both shared workspaces as ready", view.status === 200 && view.data.workspaces.length === 2 && view.data.workspaces.every((w) => w.status === "ready"), JSON.stringify(view.data?.workspaces.map((w) => w.status)));
    const said = await eventually("just after the app restarted", () => nora.post(`${at(pair, "public", "general")}/messages`, { text: "Still here after a restart." }));
    check("and people carry on talking", said.status === 200, `${said.status} ${said.message}`);
  }

  console.log(`\n${checks.passed} checks passed, ${failed.length} failed. The whole run took ${Math.round((Date.now() - started) / 1000)} s.`);
  for (const name of failed) console.log(`  failed: ${name}`);
  console.log(secondTries.length ? `Asked a second time, after the check itself stopped or started a node:\n${secondTries.map((line) => `  ${line}`).join("\n")}` : "Nothing had to be asked a second time, not even after a node was stopped or started.");
}

let problem = null;
try {
  await main();
} catch (err) {
  problem = err;
  console.error(`\nThe check stopped: ${err instanceof Error ? err.message : err}`);
  for (const company of all) console.error(`--- ${company.name}: agent\n${company.compose(["logs", "--no-log-prefix", "--tail", "12", "agent"], { allowFailure: true })}`);
}
if (keep) {
  console.log(`\nLeft running: ${all.map((c) => `${c.name} at ${c.base} (${c.dir})`).join(", ")}.`);
} else {
  for (const company of all) company.remove();
  docker(["network", "rm", dockerNetwork], { allowFailure: true });
  console.log("The three throwaway companies are removed.");
}
process.exit(problem || failed.length ? 1 : 0);
