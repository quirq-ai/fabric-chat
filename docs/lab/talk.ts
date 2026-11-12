// Lab only. One person does one thing on one channel, through their own company's peer.
// usage: tsx server/pairtalk.ts <handle> <channel> join|create|post|read [text]
import { network } from "./config";
import { closeAll, evaluate, submit } from "./fabric";
import { identityOf, people } from "./people";

const [handle, channel, action, text = ""] = process.argv.slice(2);
const person = people().find((p) => p.handle === handle);
if (!person) throw new Error(`${handle} is not one of ${network().name}'s people`);
const me = identityOf(person.id);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A new channel needs a little while before each peer has found the other. Keep trying for a minute. */
async function patiently<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (err) {
      const code = (err as { code?: string }).code ?? "";
      if (attempt >= 20 || code.startsWith("CHAT_")) throw err;
      await sleep(3000);
    }
  }
}

try {
  if (action === "read") {
    const thread = await patiently(() => evaluate<{ messages: { author: string; text: string }[] }>(me, channel, "Messages", ["public", "general", ""]));
    console.log(JSON.stringify(thread.messages.map((m) => `${m.author}: ${m.text}`)));
  } else {
    const call: Record<string, [string, string[]]> = {
      join: ["Join", [JSON.stringify({ name: person.name, title: person.title })]],
      create: ["CreateConversation", ["public", JSON.stringify({ kind: "channel", name: "general", topic: "Two companies, set up separately" })]],
      post: ["Post", ["public", JSON.stringify({ convId: "general", text })]],
    };
    const [fn, args] = call[action];
    const done = await patiently(() => submit(me, channel, fn, { args }));
    console.log(`${fn} committed in block ${done.receipt.block}, endorsed by ${done.receipt.endorsers.map((e) => e.msp).sort().join("+")}`);
  }
} catch (err) {
  console.log(`refused: ${(err as { code?: string }).code ?? ""} ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  closeAll();
}
