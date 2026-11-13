// What the chat app does, in terms of chaincode calls. Reads ask the person's own company's peer.
// Writes become transactions, signed with the person's own key.
import { randomBytes } from "node:crypto";
import { ChatError, PUBLIC, network, orgByCode, scopeOf, scopesFor, scopesOf, type Scope, type WorkspaceConfig } from "./config";
import { OLDER_COPY, evaluate, submit, type Receipt } from "./fabric";
import { feedOf } from "./ledger";
import { serviceIdentity, type Identity } from "./people";

export interface Profile {
  id: string;
  handle: string;
  msp: string;
  name: string;
  title: string;
  joinedAt: string;
  txId: string;
}

export interface Conversation {
  id: string;
  scope: string;
  kind: "channel" | "dm";
  name: string;
  topic: string;
  members: string[];
  createdBy: string;
  createdAt: string;
  txId: string;
  lastAt: string;
  lastBy: string;
  lastMsg: string;
}

export interface Message {
  id: string;
  convId: string;
  author: string;
  text: string;
  sentAt: string;
  editedAt?: string;
  deleted?: boolean;
  txId: string;
  firstTx: string;
  /** The block that holds this version, as the reader's own company's peer sees it. */
  block: number | null;
}

type Reactions = Record<string, Record<string, string[]>>;

export interface Written<T> {
  result: T;
  receipt: Receipt;
}

/**
 * Sends a writing transaction in a scope.
 *
 * In the public scope the details are an ordinary argument: they are recorded in the block, and the
 * gateway picks enough peers to satisfy the channel's rule (more than half of the companies).
 *
 * In a private scope the details go in the transient field, which is never written to the ledger,
 * and only the companies that keep the scope are asked to endorse. No other company's peer ever
 * receives the text, not even to check it.
 */
async function write<T>(me: Identity, workspace: WorkspaceConfig, scopeName: string, fn: string, details: Record<string, unknown>): Promise<Written<T>> {
  const scope = scopeOf(workspace, scopeName);
  if (!scope.orgs.includes(me.org.code)) {
    throw new ChatError(403, "CHAT_WRONG_SCOPE", `${me.org.name} is not one of the companies that keep this conversation.`);
  }
  if (scope.kind === "public") {
    return submit<T>(me, workspace.channel, fn, { args: [scope.name, JSON.stringify(details)] });
  }
  try {
    return await submit<T>(me, workspace.channel, fn, {
      args: [scope.name, ""],
      // The salt keeps the record's hash, which everyone on the channel can see, from giving the text away.
      transient: { payload: JSON.stringify({ ...details, salt: randomBytes(16).toString("hex") }) },
      endorsingOrgs: scope.orgs.map((code) => orgByCode(code).msp),
    });
  } catch (err) {
    if (err instanceof ChatError && err.code === "LEDGER_NO_ENDORSERS" && scope.orgs.length > 1) {
      throw new ChatError(err.status, err.code, `${err.message} A private conversation needs the peer of every company that keeps it, and no other company may stand in.`);
    }
    throw err;
  }
}

/** A private record carries a salt, which only matters on the ledger. The browser has no use for it. */
function unsalted<T extends object>(record: T): T {
  const { salt: _salt, ...rest } = record as T & { salt?: string };
  return rest as T;
}

/* ---------------------------------------------------------------- people */

export function whoami(me: Identity, workspace: WorkspaceConfig) {
  return evaluate<{ id: string; handle: string; msp: string; subject: string; issuer: string; units: string[] }>(me, workspace.channel, "Whoami");
}

export function directory(me: Identity, workspace: WorkspaceConfig): Promise<Profile[]> {
  return evaluate<Profile[]>(me, workspace.channel, "Directory");
}

export function join(me: Identity, workspace: WorkspaceConfig, profile: { name: string; title: string }): Promise<Written<Profile>> {
  return submit<Profile>(me, workspace.channel, "Join", { args: [JSON.stringify(profile)] });
}

/* ---------------------------------------------------------------- conversations */

export interface Overview {
  scopes: Scope[];
  conversations: Conversation[];
  people: Profile[];
}

/** Everything the sidebar needs: the conversations the person is in, across every scope their company keeps. */
export async function overview(me: Identity, workspace: WorkspaceConfig): Promise<Overview> {
  const scopes = scopesFor(workspace, me.org.code);
  const [views, people] = await Promise.all([
    evaluate<{ scope: string; conversations: Conversation[]; error?: string }[]>(me, workspace.channel, "Overview", [JSON.stringify(scopes.map((s) => s.name))]),
    directory(me, workspace),
  ]);
  return { scopes, conversations: views.flatMap((view) => view.conversations), people };
}

/**
 * Chooses where a members-only conversation is kept: the smallest scope that covers the companies
 * of everyone in it. The fewer companies' peers that store a conversation, the more private it is.
 */
export function place(workspace: WorkspaceConfig, memberIds: string[]): Scope {
  const companies = new Set(memberIds.map((id) => network().orgs.find((o) => o.msp === id.split("@")[1])?.code ?? "?"));
  const fits = scopesOf(workspace).filter((scope) => [...companies].every((code) => scope.orgs.includes(code)));
  if (fits.length === 0) throw new ChatError(400, "CHAT_WRONG_SCOPE", "Someone in that list works at a company outside this workspace.");
  // In a workspace of one company the shared ledger and the company's own collection cover the
  // same company. The collection wins: a message deleted there is purged, not just blanked.
  const smaller = (scope: Scope, best: Scope) => scope.orgs.length < best.orgs.length || (scope.orgs.length === best.orgs.length && best.kind === "public");
  return fits.reduce((best, scope) => (smaller(scope, best) ? scope : best));
}

export interface NewConversation {
  kind: "channel" | "dm";
  name?: string;
  topic?: string;
  /** The other people. The person creating it is always added. */
  members?: string[];
  /** For a channel: true makes it open to everyone in the workspace. */
  open?: boolean;
}

export async function createConversation(
  me: Identity,
  workspace: WorkspaceConfig,
  input: NewConversation,
): Promise<{ conversation: Conversation; receipt: Receipt | null; scope: Scope }> {
  const others = [...new Set(input.members ?? [])].filter((id) => id !== me.id);
  const known = new Set((await directory(me, workspace)).map((p) => p.id));
  const stranger = others.find((id) => !known.has(id));
  if (stranger) throw new ChatError(404, "CHAT_UNKNOWN_USER", `${stranger} has not joined this workspace.`);

  // A conversation just made has had no message yet: its making counts as its last activity.
  const fresh = (made: Conversation): Conversation => ({ ...unsalted(made), lastAt: made.createdAt, lastBy: made.createdBy, lastMsg: "" });

  if (input.kind === "channel" && input.open) {
    const done = await write<Conversation>(me, workspace, PUBLIC, "CreateConversation", { kind: "channel", name: input.name ?? "", topic: input.topic ?? "", members: [] });
    return { conversation: fresh(done.result), receipt: done.receipt, scope: scopeOf(workspace, PUBLIC) };
  }

  const members = [me.id, ...others].sort();
  const scope = place(workspace, members);
  if (input.kind === "dm") {
    // A direct message between the same people is opened again rather than made twice.
    const existing = (await overview(me, workspace)).conversations.find((c) => c.kind === "dm" && c.members.join() === members.join());
    if (existing) return { conversation: existing, receipt: null, scope: scopeOf(workspace, existing.scope) };
  }
  const done = await write<Conversation>(me, workspace, scope.name, "CreateConversation", { kind: input.kind, name: input.name ?? "", topic: input.topic ?? "", members });
  return { conversation: fresh(done.result), receipt: done.receipt, scope };
}

export function addMembers(me: Identity, workspace: WorkspaceConfig, scope: string, convId: string, members: string[]): Promise<Written<Conversation>> {
  return write<Conversation>(me, workspace, scope, "AddMembers", { convId, members });
}

/* ---------------------------------------------------------------- messages */

export interface Thread {
  conversation: Conversation;
  messages: Message[];
  reactions: Reactions;
}

export async function messages(me: Identity, workspace: WorkspaceConfig, scope: string, convId: string, after = ""): Promise<Thread> {
  scopeOf(workspace, scope);
  const thread = await evaluate<Thread>(me, workspace.channel, "Messages", [scope, convId, after]);
  const feed = feedOf(me.org.code, workspace.channel);
  for (const message of thread.messages) message.block = feed?.blockOf(message.txId) ?? null;
  return thread;
}

export async function post(me: Identity, workspace: WorkspaceConfig, scope: string, convId: string, text: string): Promise<Written<Message>> {
  const done = await write<Message>(me, workspace, scope, "Post", { convId, text });
  return { result: unsalted(done.result), receipt: done.receipt };
}

export async function edit(me: Identity, workspace: WorkspaceConfig, scope: string, convId: string, msgId: string, text: string): Promise<Written<Message>> {
  const done = await write<Message>(me, workspace, scope, "Edit", { convId, msgId, text });
  return { result: unsalted(done.result), receipt: done.receipt };
}

export async function remove(me: Identity, workspace: WorkspaceConfig, scope: string, convId: string, msgId: string): Promise<Written<{ id: string; purged: boolean }>> {
  // In a private scope a transaction may not search and write as well, so the reactions to clear
  // are looked up here and named in the request.
  let reactions: { emoji: string; by: string }[] = [];
  if (scopeOf(workspace, scope).kind !== "public") {
    const thread = await messages(me, workspace, scope, convId);
    reactions = Object.entries(thread.reactions[msgId] ?? {}).flatMap(([emoji, people]) => people.map((by) => ({ emoji, by })));
  }
  return write(me, workspace, scope, "Delete", { convId, msgId, reactions });
}

export function react(me: Identity, workspace: WorkspaceConfig, scope: string, convId: string, msgId: string, emoji: string, on: boolean) {
  return write<{ emoji: string; on: boolean }>(me, workspace, scope, "React", { convId, msgId, emoji, on });
}

export interface Version {
  txId: string;
  at: string;
  text: string;
  deleted: boolean;
  block: number | null;
}

/** Every version of a public message. Private scopes keep no readable history. */
export async function history(me: Identity, workspace: WorkspaceConfig, convId: string, msgId: string): Promise<Version[]> {
  const versions = await evaluate<Version[]>(me, workspace.channel, "History", [convId, msgId]);
  const feed = feedOf(me.org.code, workspace.channel);
  for (const version of versions) version.block = feed?.blockOf(version.txId) ?? null;
  return versions;
}

/* ---------------------------------------------------------------- what each company's peer holds */

export interface Holding {
  org: string;
  /** False when the company is not on this channel at all: its peer has no part of this ledger. */
  onChannel: boolean;
  /** True when the company's peer stores the record itself, not just its hash. */
  held: boolean;
  /** True when the copy this peer stores hashes to the value the ledger carries. */
  matches: boolean;
  /**
   * False for another company in a shared workspace: its peer cannot be asked from here, so "held"
   * says what Fabric's rules make true of it rather than what its peer answered.
   */
  asked: boolean;
  ledgerHash: string;
  note: string;
  /**
   * True when the company's peer stores an older version of the record than the ledger records. That
   * is what a restore leaves of something changed after the backup, when the change was kept by
   * this company alone.
   */
  older?: boolean;
}

/**
 * Asks every company's own peer what it holds for one key. This demo server plays all three
 * companies, so it can ask each peer as that company. In a real deployment each company could only
 * ask its own.
 */
export async function holdings(workspace: WorkspaceConfig, scopeName: string, key: string): Promise<Holding[]> {
  const scope = scopeOf(workspace, scopeName);
  return Promise.all(
    network().orgs.map(async (org): Promise<Holding> => {
      if (!workspace.orgs.includes(org.code)) return { org: org.code, onChannel: false, held: false, matches: false, ledgerHash: "", note: "", asked: org.own };
      // Another company's peer answers only to that company. What it holds follows from the scope:
      // every company a scope names is sent the text, and every other company on the channel its hash.
      if (!org.own) return { org: org.code, onChannel: true, held: scope.orgs.includes(org.code), matches: false, ledgerHash: "", note: "", asked: false };
      try {
        const found = await evaluate<{ held: boolean; heldHash: string; ledgerHash: string; note: string }>(serviceIdentity(org), workspace.channel, "Inspect", [scopeName, key]);
        // Fabric will not hand out a version older than the one the ledger records. The chaincode passes on the end of what it says.
        const older = !found.held && /^\d+\}$/.test(found.note);
        return { org: org.code, onChannel: true, held: found.held, matches: found.held && found.heldHash === found.ledgerHash, ledgerHash: found.ledgerHash, note: older ? OLDER_COPY : found.note, asked: true, older };
      } catch (err) {
        return { org: org.code, onChannel: true, held: false, matches: false, ledgerHash: "", note: err instanceof Error ? err.message : "This peer did not answer.", asked: true };
      }
    }),
  );
}

export const messageKey = (convId: string, msgId: string) => `msg~${convId}~${msgId}`;
