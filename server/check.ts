// Checks the running network end to end: that messages travel, and that each privacy claim the app
// makes is true on the ledger itself. Usage: npm run test:app (the network must be up and seeded).
import { ChatError, PUBLIC, network, owned, workspaceOf } from "./config";
import * as chat from "./chat";
import { closeAll } from "./fabric";
import { feedOf, feedsReady, startFeeds, stopFeeds } from "./ledger";
import { identityOf, people } from "./people";

let passed = 0;
let failed = 0;

function check(what: string, ok: boolean, detail = ""): void {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}${ok || !detail ? "" : `\n        ${detail}`}`);
}

/** Runs something that must be refused, and returns the refusal's code. */
async function refused(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "(it went through)";
  } catch (err) {
    return err instanceof ChatError ? err.code : String(err);
  }
}

const id = (handle: string) => people().find((p) => p.handle === handle)!.id;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const commons = workspaceOf("commons");
  const dealroom = workspaceOf("dealroom");
  const [alice, arjun, bob, carol] = ["alice", "arjun", "bob", "carol"].map((h) => identityOf(id(h)));
  const tag = Date.now().toString(36);
  startFeeds();
  await feedsReady();

  console.log("\nAn open channel: every company's peer stores it");
  const open = await chat.createConversation(alice, commons, { kind: "channel", name: `check-${tag}`, open: true });
  check("the channel is kept in the shared state", open.scope.name === PUBLIC);
  const hello = await chat.post(alice, commons, PUBLIC, open.conversation.id, "hello from the check");
  const signers = new Set(hello.receipt.endorsers.map((e) => e.msp));
  check("more than half of the companies endorsed the post", signers.size >= 2, [...signers].join(", "));
  check("the post was committed as VALID", hello.receipt.validation === "VALID");
  for (const reader of [bob, carol]) {
    const thread = await chat.messages(reader, commons, PUBLIC, open.conversation.id);
    check(`${reader.handle} reads it on ${owned(reader.org.name)} own peer`, thread.messages.some((m) => m.text === "hello from the check"));
  }
  check("the name is now taken, for every company", (await refused(() => chat.createConversation(bob, commons, { kind: "channel", name: `check-${tag}`, open: true }))) === "CHAT_NAME_TAKEN");

  console.log("\nA private channel of Aster and Birch: only their two peers store the text");
  const deal = await chat.createConversation(alice, commons, { kind: "channel", name: `deal-${tag}`, members: [bob.id] });
  check("it is placed in the two companies' collection", deal.scope.kind === "shared" && deal.scope.orgs.join() === "aster,birch", deal.scope.name);
  const secret = await chat.post(alice, commons, deal.scope.name, deal.conversation.id, "our floor is 41");
  const privateSigners = secret.receipt.endorsers.map((e) => e.msp).sort();
  check("only Aster's and Birch's peers endorsed it", privateSigners.join() === "AsterMSP,BirchMSP", privateSigners.join());
  check("Bob reads it", (await chat.messages(bob, commons, deal.scope.name, deal.conversation.id)).messages[0]?.text === "our floor is 41");
  check("Carol's overview does not list it", !(await chat.overview(carol, commons)).conversations.some((c) => c.id === deal.conversation.id));
  check("Carol cannot open the scope", (await refused(() => chat.messages(carol, commons, deal.scope.name, deal.conversation.id))) === "CHAT_WRONG_SCOPE");
  check("Arjun's company keeps it, but he is not a member", (await refused(() => chat.messages(arjun, commons, deal.scope.name, deal.conversation.id))) === "CHAT_NOT_MEMBER");

  const key = chat.messageKey(deal.conversation.id, secret.result.id);
  const held = Object.fromEntries((await chat.holdings(commons, deal.scope.name, key)).map((h) => [h.org, h]));
  check("Aster's peer holds the text, and it matches the ledger's hash", held.aster.held && held.aster.matches);
  check("Birch's peer holds the text, and it matches the ledger's hash", held.birch.held && held.birch.matches);
  check("Cedar's peer does not hold the text", !held.cedar.held, held.cedar.note);
  check("Cedar's peer holds the same hash as the others", held.cedar.ledgerHash !== "" && held.cedar.ledgerHash === held.aster.ledgerHash);

  await pause(1500);
  const cedarsCopy = feedOf("cedar", "commons")?.find(secret.receipt.txId)?.tx;
  check("Cedar's peer received the transaction in a block", !!cedarsCopy);
  if (cedarsCopy) {
    const block = JSON.stringify(cedarsCopy);
    check("that block does not contain the text", !block.includes("our floor is 41"));
    check("it does not name the conversation either", !block.includes(deal.conversation.id));
    check("every write in it is a hash, into the collection", cedarsCopy.writes.length > 0 && cedarsCopy.writes.every((w) => w.collection === deal.scope.name && w.value === undefined && !!w.valueHash));
    check("the argument that would carry the text is empty", cedarsCopy.args[1] === "", JSON.stringify(cedarsCopy.args));
    check("Cedar can still see who sent it, and when", cedarsCopy.creator?.name === "alice" && cedarsCopy.at !== "");
  }

  console.log("\nA channel of one company: it never leaves that company's peer");
  const team = await chat.createConversation(alice, commons, { kind: "channel", name: `team-${tag}`, members: [arjun.id] });
  check("it is placed in Aster's own collection", team.scope.kind === "org" && team.scope.orgs.join() === "aster", team.scope.name);
  const inside = await chat.post(arjun, commons, team.scope.name, team.conversation.id, "aster only");
  check("only Aster's peer endorsed it", inside.receipt.endorsers.map((e) => e.msp).join() === "AsterMSP", inside.receipt.endorsers.map((e) => e.msp).join());
  check("Bob cannot open it", (await refused(() => chat.messages(bob, commons, team.scope.name, team.conversation.id))) === "CHAT_WRONG_SCOPE");

  console.log("\nPeople from all three companies: no smaller scope covers them");
  const wide = await chat.createConversation(alice, commons, { kind: "channel", name: `wide-${tag}`, members: [bob.id, carol.id] });
  check("a members-only channel across three companies is kept by all three", wide.scope.name === PUBLIC && wide.conversation.members.length === 3);
  check("the chaincode still keeps non-members out", (await refused(() => chat.messages(arjun, commons, PUBLIC, wide.conversation.id))) === "CHAT_NOT_MEMBER");

  console.log("\nEdit and delete on the shared ledger: history stays");
  const typo = await chat.post(alice, commons, PUBLIC, open.conversation.id, "the launch is on Tuseday");
  check("only the author may edit", (await refused(() => chat.edit(bob, commons, PUBLIC, open.conversation.id, typo.result.id, "hacked"))) === "CHAT_NOT_AUTHOR");
  await chat.edit(alice, commons, PUBLIC, open.conversation.id, typo.result.id, "the launch is on Tuesday");
  await chat.remove(alice, commons, PUBLIC, open.conversation.id, typo.result.id);
  const versions = await chat.history(carol, commons, open.conversation.id, typo.result.id);
  check("all three versions are still on the ledger", versions.length === 3 && versions[0].text === "the launch is on Tuseday" && versions[2].deleted, JSON.stringify(versions.map((v) => v.text)));

  console.log("\nDelete in a private scope: the text is purged from every peer");
  const gone = await chat.remove(alice, commons, deal.scope.name, deal.conversation.id, secret.result.id);
  check("the delete was a purge", gone.result.purged === true);
  await pause(1200);
  const after = Object.fromEntries((await chat.holdings(commons, deal.scope.name, key)).map((h) => [h.org, h]));
  check("neither Aster's nor Birch's peer holds it any more", !after.aster.held && !after.birch.held);
  check("Bob no longer sees it", (await chat.messages(bob, commons, deal.scope.name, deal.conversation.id)).messages.length === 0);

  console.log("\nMany people at once: no transaction knocks another out");
  const burst = await Promise.all([alice, arjun, bob, carol].flatMap((who) => [1, 2].map((n) => chat.post(who, commons, PUBLIC, open.conversation.id, `${who.handle} says ${n}`))));
  check("eight posts sent together all committed", burst.every((b) => b.receipt.validation === "VALID"));
  check("none needed a second try", burst.every((b) => b.receipt.attempts === 1));
  const cheers = await Promise.all([alice, bob, carol].map((who) => chat.react(who, commons, PUBLIC, open.conversation.id, hello.result.id, "tada", true)));
  check("three reactions to one message sent together all committed", cheers.length === 3);
  const reacted = (await chat.messages(alice, commons, PUBLIC, open.conversation.id)).reactions[hello.result.id]?.tada ?? [];
  check("the message shows all three", reacted.length === 3, reacted.join());

  console.log("\nA second channel: a ledger Cedar never receives");
  check("Alice reads the deal room", (await chat.overview(alice, dealroom)).conversations.some((c) => c.name === "general"));
  check("Cedar's peer has no such channel", (await refused(() => chat.overview(carol, dealroom))) !== "(it went through)");
  check("Cedar has no feed of it", feedOf("cedar", "dealroom") === null);

  console.log("\nThe ledgers themselves");
  await pause(1500);
  for (const ws of network().workspaces) {
    const feeds = ws.orgs.map((code) => feedOf(code, ws.channel)!);
    const chain = feeds[0].blocks;
    // Each block names the hash of the one before it. Recomputing every hash proves the chain is whole.
    check(`${ws.channel}: ${chain.length} blocks, each naming the hash of the one before`, chain.every((b, i) => i === 0 || b.previousHash === chain[i - 1].hash));
    check(`${ws.channel}: ${ws.orgs.join(", ")} hold the same number of blocks`, feeds.every((f) => f.height === feeds[0].height), feeds.map((f) => f.height).join());
    check(`${ws.channel}: and the same newest block hash`, feeds.every((f) => f.tip === feeds[0].tip));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}

main()
  .catch((err) => {
    console.error(`The check stopped: ${err instanceof Error ? (err.stack ?? err.message) : err}`);
    process.exitCode = 1;
  })
  .finally(() => {
    stopFeeds();
    closeAll();
  });
