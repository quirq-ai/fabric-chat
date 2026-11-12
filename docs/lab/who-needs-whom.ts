// Lab only: checks the claims the many-companies guide makes about who needs whom.
//   a company's own workspace needs nobody else's nodes
//   a two-company workspace needs both companies' peers and both orderers
import { execFileSync } from "node:child_process";
import { ChatError, PUBLIC, network, workspaceOf } from "./config";
import * as chat from "./chat";
import { closeAll } from "./fabric";
import { identityOf, people } from "./people";

let passed = 0;
let failed = 0;
function check(what: string, ok: boolean, detail = ""): void {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}${detail ? `\n        ${detail}` : ""}`);
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const id = (handle: string) => people().find((p) => p.handle === handle)!.id;
const docker = (action: "stop" | "start", names: string[]) => execFileSync("docker", [action, ...names], { stdio: "ignore" });

/** Tries to post and says what happened, in a few words. */
async function post(who: ReturnType<typeof identityOf>, channel: string, scope: string, conv: string, text: string): Promise<string> {
  const started = Date.now();
  try {
    const done = await chat.post(who, workspaceOf(channel), scope, conv, text);
    return `committed, endorsed by ${done.receipt.endorsers.map((e) => e.msp).sort().join("+")} (${Date.now() - started} ms)`;
  } catch (err) {
    return `refused: ${err instanceof ChatError ? err.code : String(err)} (${Date.now() - started} ms)`;
  }
}

/** Keeps trying until a post goes through, for the moments after nodes come back. */
async function untilCommitted(run: () => Promise<string>, seconds = 90): Promise<string> {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const out = await run();
    if (out.startsWith("committed") || Date.now() > deadline) return out;
    await sleep(3000);
  }
}

async function main(): Promise<void> {
  const net = network();
  const org = (code: string) => net.orgs.find((o) => o.code === code)!;
  const [alice, arjun, bob] = ["alice", "arjun", "bob"].map((h) => identityOf(id(h)));
  const home = workspaceOf("aster-home");
  const dealroom = workspaceOf("dealroom");

  console.log("\nA workspace only one company is on");
  const general = await chat.createConversation(alice, home, { kind: "channel", name: "general", open: true });
  check("Alice creates #general in Aster's own workspace", general.scope.name === PUBLIC);
  const first = await chat.post(alice, home, PUBLIC, general.conversation.id, "Only Aster's node has this.");
  check("her post is endorsed by Aster's peer alone", first.receipt.endorsers.map((e) => e.msp).join() === "AsterMSP", first.receipt.endorsers.map((e) => e.msp).join());
  check("Arjun, a colleague, reads it", (await chat.messages(arjun, home, PUBLIC, general.conversation.id)).messages.length === 1);
  let bobSees = "nothing";
  try {
    await chat.overview(bob, home);
    bobSees = "the workspace";
  } catch (err) {
    bobSees = err instanceof ChatError ? `nothing (${err.code})` : "nothing";
  }
  check("Bob, at another company, cannot reach it at all", bobSees.startsWith("nothing"), bobSees);

  console.log("\nEvery other company's nodes switched off");
  const others = ["birch", "cedar"].flatMap((code) => [org(code).peer.name, org(code).orderer]);
  docker("stop", others);
  await sleep(2000);
  const alone = await post(alice, "aster-home", PUBLIC, general.conversation.id, "Still working with everyone else off.");
  check("Aster's own workspace still takes messages", alone.startsWith("committed"), alone);
  const shared = await post(alice, "commons", PUBLIC, "general", "Does the shared workspace work?");
  check("the shared workspace does not", alone.startsWith("committed") && shared.startsWith("refused"), shared);
  docker("start", others);
  const back = await untilCommitted(() => post(alice, "commons", PUBLIC, "general", "Everyone is back."));
  check("the shared workspace works again once they return", back.startsWith("committed"), back);

  console.log("\nA workspace of two companies");
  const dealGeneral = (await chat.overview(alice, dealroom)).conversations.find((c) => c.name === "general")!;
  const both = await untilCommitted(() => post(alice, "dealroom", PUBLIC, dealGeneral.id, "Both companies are up."));
  check("with both up, a post is endorsed by both", both.includes("AsterMSP+BirchMSP"), both);

  docker("stop", [org("birch").peer.name]);
  await sleep(2000);
  const noPeer = await post(alice, "dealroom", PUBLIC, dealGeneral.id, "Birch's peer is off.");
  check("with the other company's peer off, a post is refused", noPeer.startsWith("refused"), noPeer);
  docker("start", [org("birch").peer.name]);
  const peerBack = await untilCommitted(() => post(alice, "dealroom", PUBLIC, dealGeneral.id, "Birch's peer is back."));
  check("and goes through once it returns", peerBack.startsWith("committed"), peerBack);

  docker("stop", [org("birch").orderer]);
  await sleep(2000);
  const noOrderer = await post(alice, "dealroom", PUBLIC, dealGeneral.id, "Birch's orderer is off.");
  check("with the other company's orderer off, a post is refused", noOrderer.startsWith("refused"), noOrderer);
  const homeStill = await post(alice, "aster-home", PUBLIC, general.conversation.id, "Home is unaffected by Birch's orderer.");
  check("while Aster's own workspace carries on", homeStill.startsWith("committed"), homeStill);
  docker("start", [org("birch").orderer]);
  const ordererBack = await untilCommitted(() => post(alice, "dealroom", PUBLIC, dealGeneral.id, "Birch's orderer is back."));
  check("and the shared one resumes once it returns", ordererBack.startsWith("committed"), ordererBack);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}

main()
  .catch((err) => {
    console.error(`The lab check stopped: ${err instanceof Error ? (err.stack ?? err.message) : err}`);
    process.exitCode = 1;
  })
  .finally(closeAll);
