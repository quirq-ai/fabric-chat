// Requests from the chat app to the node's agent, on a company's own server.
//
// Sharing a workspace with another company takes the node administrator's key: it joins the
// company's orderer and peer to a new ledger. The app is what browsers reach, so it does not hold
// that key. It leaves a request in a folder the two share (the "desk"), and the agent, which does
// hold the key, answers there. See ctl/agent.sh for the four requests it knows.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ChatError } from "./config";

const desk = () => process.env.CHAT_DESK ?? "/desk";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The agent answers one request at a time, so they are sent one at a time. */
let line: Promise<unknown> = Promise.resolve();

export function ask<T>(kind: "create" | "reach" | "inspect" | "accept" | "invitation", details: Record<string, unknown>, timeoutMs = 150_000): Promise<T> {
  const turn = line.then(
    () => once<T>(kind, details, timeoutMs),
    () => once<T>(kind, details, timeoutMs),
  );
  line = turn.catch(() => undefined);
  return turn;
}

async function once<T>(kind: string, details: Record<string, unknown>, timeoutMs: number): Promise<T> {
  const id = randomBytes(16).toString("hex");
  const request = path.join(desk(), "requests", `${id}.json`);
  const answer = path.join(desk(), "results", `${id}.json`);
  try {
    // Written under another name first: the agent must never read half a request.
    writeFileSync(`${request}.new`, JSON.stringify({ id, kind, ...details }), { mode: 0o660 });
    renameSync(`${request}.new`, request);
  } catch {
    throw new ChatError(503, "AGENT_DOWN", "This server's node agent cannot be reached. See: ./chat logs agent");
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(answer)) {
      const said = JSON.parse(readFileSync(answer, "utf8")) as { ok: boolean; data?: T; message?: string };
      rmSync(answer, { force: true });
      if (said.ok) return said.data as T;
      // The agent's refusals are written to be read by an administrator.
      throw new ChatError(409, "NODE_REFUSED", said.message ?? "The node could not do that.");
    }
    await sleep(250);
  }
  rmSync(request, { force: true });
  throw new ChatError(504, "AGENT_SLOW", "The node's agent did not answer in time. See: ./chat logs agent");
}
