// Puts the people and a few conversations on the ledger, so the app has something to show.
// Usage: npm run seed. Running it again changes nothing: whatever is already there is left alone.
//
// Every line below is a real transaction, signed by the person named and endorsed by the peers of
// the companies that keep the conversation.
import { network, type WorkspaceConfig } from "./config";
import * as chat from "./chat";
import { closeAll } from "./fabric";
import { identityOf, people, type Identity } from "./people";

interface Seed {
  channel: string;
  kind: "channel" | "dm";
  name?: string;
  topic?: string;
  open?: boolean;
  by: string;
  with?: string[];
  says: [who: string, text: string][];
}

const seeds: Seed[] = [
  {
    channel: "commons",
    kind: "channel",
    name: "general",
    topic: "Everyone, from all three companies",
    open: true,
    by: "alice",
    says: [
      ["alice", "Welcome to the Commons. All three companies are here, and each company's node keeps its own copy of everything said in an open channel."],
      ["bob", "Morning all. Birch's node is up and in step with yours."],
      ["carol", "Cedar is here too. Shipment CW-2209 leaves the port on Thursday."],
    ],
  },
  {
    channel: "commons",
    kind: "channel",
    name: "shipping",
    topic: "Containers, customs and delivery slots",
    open: true,
    by: "carol",
    says: [
      ["carol", "Container CW-2209 cleared customs this morning."],
      ["bianca", "Good. The invoice for CW-2209 goes out today."],
      ["arjun", "Warehouse slot is booked for Friday, 10:00."],
    ],
  },
  {
    // Aster and Birch people only, so it lands in the collection only their two peers store.
    channel: "commons",
    kind: "channel",
    name: "pricing",
    topic: "Q1 renewal terms between Aster and Birch",
    by: "alice",
    with: ["arjun", "bob", "bianca"],
    says: [
      ["alice", "Our floor for the Q1 renewal is 41 a unit. Cedar must not see this."],
      ["bob", "Understood. We can go to 43 if the volume holds."],
      ["bianca", "I will put 43 in the draft and send it across."],
    ],
  },
  {
    // Aster people only, so it never leaves Aster's own peer.
    channel: "commons",
    kind: "channel",
    name: "aster-team",
    topic: "Aster only",
    by: "alice",
    with: ["arjun"],
    says: [
      ["arjun", "The board deck is ready for review."],
      ["alice", "Thanks. Keep the margin slide inside Aster for now."],
    ],
  },
  {
    // People from all three companies. No smaller scope covers them, so every company's peer stores it.
    channel: "commons",
    kind: "channel",
    name: "launch-plan",
    topic: "Members only, across all three companies",
    by: "alice",
    with: ["bob", "carol"],
    says: [["alice", "The launch checklist is ready. Only the three of us are in this channel."]],
  },
  { channel: "commons", kind: "dm", by: "alice", with: ["bob"], says: [["alice", "Do you have ten minutes before the call?"], ["bob", "Yes. Ring me at three."]] },
  { channel: "commons", kind: "dm", by: "bob", with: ["carol"], says: [["bob", "Carol, can Cedar hold CW-2210 until Monday?"], ["carol", "We can. I will confirm with the port."]] },
  { channel: "commons", kind: "dm", by: "carlos", with: ["carol"], says: [["carlos", "The audit sample for October is done."]] },
  {
    channel: "dealroom",
    kind: "channel",
    name: "general",
    topic: "Aster and Birch",
    open: true,
    by: "bob",
    says: [
      ["bob", "This workspace is a ledger of its own. Only Aster's and Birch's nodes have it."],
      ["alice", "Cedar's node never receives a block from here, and its orderer takes no part in ordering it."],
    ],
  },
  {
    channel: "dealroom",
    kind: "channel",
    name: "term-sheet",
    topic: "Draft terms",
    by: "alice",
    with: ["bob"],
    says: [["alice", "Draft 3 of the term sheet is ready for your comments."]],
  },
  { channel: "dealroom", kind: "channel", name: "birch-finance", topic: "Birch only", by: "bianca", with: ["bob"], says: [["bianca", "Payment run is on the 28th."]] },
];

const everyone = people();
const idOf = (handle: string) => {
  const person = everyone.find((p) => p.handle === handle);
  if (!person) throw new Error(`${handle} has no certificate. Run: npm run net:up`);
  return person.id;
};
const as = (handle: string): Identity => identityOf(idOf(handle));
const workspace = (channel: string): WorkspaceConfig => network().workspaces.find((w) => w.channel === channel)!;

async function joinEveryone(): Promise<number> {
  let joined = 0;
  for (const ws of network().workspaces) {
    const members = everyone.filter((p) => ws.orgs.includes(p.org));
    if (members.length === 0) continue;
    const present = new Set((await chat.directory(identityOf(members[0].id), ws)).map((p) => p.id));
    // Each person joins with their own key. The transactions touch different records, so they can
    // all go at once and share a block.
    await Promise.all(
      members
        .filter((p) => !present.has(p.id))
        .map(async (p) => {
          await chat.join(identityOf(p.id), ws, { name: p.name, title: p.title });
          joined++;
        }),
    );
  }
  return joined;
}

async function plant(seed: Seed): Promise<string | null> {
  const ws = workspace(seed.channel);
  const creator = as(seed.by);
  const members = (seed.with ?? []).map(idOf);
  const mine = (await chat.overview(creator, ws)).conversations;
  const wanted = [creator.id, ...members].sort().join();
  const exists = seed.kind === "dm" ? mine.some((c) => c.kind === "dm" && c.members.join() === wanted) : mine.some((c) => c.kind === "channel" && c.name === seed.name);
  if (exists) return null;

  const made = await chat.createConversation(creator, ws, { kind: seed.kind, name: seed.name, topic: seed.topic, members, open: seed.open });
  // One after another, so the conversation reads in the order it was written.
  for (const [who, text] of seed.says) await chat.post(as(who), ws, made.conversation.scope, made.conversation.id, text);
  const label = seed.kind === "dm" ? `direct message ${seed.by} + ${(seed.with ?? []).join(", ")}` : `#${seed.name}`;
  return `${seed.channel.padEnd(9)} ${label.padEnd(34)} kept by ${made.scope.orgs.join(", ")}`;
}

async function main(): Promise<void> {
  const joined = await joinEveryone();
  console.log(joined ? `${joined} directory entries written` : "everyone has joined already");
  // network.json may describe other companies and workspaces than the ones these conversations
  // were written for. Plant only those whose workspace and people exist here.
  const here = (handle: string) => everyone.some((p) => p.handle === handle);
  const usable = seeds.filter((s) => network().workspaces.some((w) => w.channel === s.channel) && [s.by, ...(s.with ?? []), ...s.says.map(([who]) => who)].every(here));
  // Everyone is in the directory by now, so the conversations can all be planted at once. They are
  // separate records, and their transactions share blocks.
  const planted = (await Promise.all(usable.map(plant))).filter(Boolean);
  for (const line of planted) console.log(line);
  console.log(planted.length ? `${planted.length} conversations written` : "the conversations are there already");
}

main()
  .catch((err) => {
    console.error(`Seeding stopped: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  })
  .finally(closeAll);
