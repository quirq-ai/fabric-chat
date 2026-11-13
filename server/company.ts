// What a company's own server adds to the app: real sign-in, an administrator who adds people, and
// the first-run steps that make the first administrator.
//
//   A person signs in with their handle and a password. The server answers with a session cookie.
//   An administrator adds a person: the company's CA signs them a certificate, they join the home
//   workspace, and the administrator gets a one-time link to pass on. The person opens the link
//   and chooses their own password, so no administrator ever knows it.
import { X509Certificate } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import type { Request, Response, Router } from "express";
import * as accounts from "./accounts";
import type { Account, Role } from "./accounts";
import { enrolPerson } from "./ca";
import * as chat from "./chat";
import { ChatError, company, dataDir, network, nodeDir, nodeState, type WorkspaceConfig } from "./config";
import { ask } from "./desk";
import { translate } from "./fabric";
import { certificateOf, identityOf, type Identity } from "./people";
import { hasIdentity, sealIdentity } from "./wallet";
import * as xoLogin from "./xologin";

const COOKIE = "chat_session";

type Handler = (req: Request, res: Response) => unknown;

const route =
  (handler: Handler) =>
  async (req: Request, res: Response): Promise<void> => {
    try {
      const out = await handler(req, res);
      if (!res.headersSent) res.json(out ?? { ok: true });
    } catch (err) {
      const problem = translate(err);
      if (!res.headersSent) res.status(problem.status).json({ error: { code: problem.code, message: problem.message } });
    }
  };

/* ------------------------------------------------------------------ sessions */

function cookieOf(req: Request, name = COOKIE): string {
  for (const part of String(req.headers.cookie ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return "";
}

/**
 * The cookie is kept from scripts on the page (HttpOnly) and is not sent along with requests that
 * other sites make (SameSite). Over HTTPS it is marked Secure as well, so a browser never sends it
 * in the clear. The app sits behind the proxy then and sees plain HTTP itself, so it goes by its settings.
 */
function setCookie(req: Request, res: Response, value: string, maxAgeSeconds: number): void {
  const secure = company().https || req.secure;
  res.appendHeader("Set-Cookie", `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`);
}

const idOf = (handle: string) => `${handle}@${company().id}`;

export interface SessionUser {
  id: string;
  handle: string;
  name: string;
  title: string;
  role: Role;
}

const userOf = (account: Account): SessionUser => ({ id: idOf(account.handle), handle: account.handle, name: account.name, title: account.title, role: account.role });

/** The account of whoever sent this request, or null when they are not signed in. */
export function sessionAccount(req: Request): Account | null {
  return accounts.sessionOf(cookieOf(req));
}

function signedIn(req: Request): Account {
  const account = sessionAccount(req);
  if (!account) throw new ChatError(401, "SIGN_IN", "Sign in first.");
  return account;
}

/** The identity a request acts as: the signed-in person's own certificate and key. */
export function sessionIdentity(req: Request): Identity {
  return identityOf(idOf(signedIn(req).handle));
}

function administrator(req: Request): Account {
  const account = signedIn(req);
  if (account.role !== "admin") throw new ChatError(403, "NOT_ADMIN", "Only an administrator can do that.");
  return account;
}

/* ------------------------------------------------------------------ people */

type Joined = { channel: string; block: number }[];
/** People being put in a directory right now, so that several requests at once make one transaction, not many. */
const joining = new Map<string, Promise<Joined>>();

/** Puts a person in the directory of every workspace this company is on. Safe to call again. */
function ensureJoined(account: Account): Promise<Joined> {
  const missing = network().workspaces.filter((w) => !account.joined.includes(w.channel));
  if (missing.length === 0) return Promise.resolve([]);
  const under = joining.get(account.handle);
  if (under) return under;
  const work = (async () => {
    const me = identityOf(idOf(account.handle));
    const done: Joined = [];
    for (const workspace of missing) {
      const joined = await chat.join(me, workspace, { name: account.name, title: account.title });
      accounts.noteJoined(account.handle, workspace.channel);
      done.push({ channel: workspace.channel, block: joined.receipt.block });
    }
    return done;
  })().finally(() => joining.delete(account.handle));
  joining.set(account.handle, work);
  return work;
}

/**
 * Adds a person: a certificate from the company's CA, an account, and a place in the directory.
 * They cannot sign in until they have opened an invitation link and chosen a password.
 */
async function addPerson(input: { handle: string; name: string; title: string; role: Role }, createdBy: string) {
  const handle = accounts.checkHandle(input.handle);
  const name = input.name.trim().replace(/\s+/g, " ").slice(0, 40);
  if (!name) throw new ChatError(400, "BAD_INPUT", "A name is required.");
  if (accounts.accountOf(handle)) throw new ChatError(409, "HANDLE_TAKEN", `There is already someone called ${handle}.`);

  if (!hasIdentity(handle)) {
    const { certPem, keyPem } = await enrolPerson(handle);
    sealIdentity(handle, certPem, keyPem);
  }
  const account = accounts.addAccount({ handle, name, title: input.title.trim().slice(0, 40), role: input.role, createdBy });
  // If the ledger is not answering just now, they are added to the directory when they first sign in.
  const joined = await ensureJoined(account).catch(() => []);
  return { account, joined, certificate: certificateOf(identityOf(idOf(handle)).certPem) };
}

const personOf = (account: Account) => ({
  id: idOf(account.handle),
  handle: account.handle,
  name: account.name,
  title: account.title,
  role: account.role,
  state: account.state,
  /** True while a link to choose a password is waiting to be used. */
  linkWaiting: !!account.invite && account.invite.expires > new Date().toISOString(),
  createdAt: account.createdAt,
  createdBy: account.createdBy,
});

/**
 * Where a link in an answer should lead. Over HTTPS that is the chat's own address, whatever the
 * request claims. Over plain HTTP it is wherever the administrator opened the app from.
 */
const originOf = (req: Request) => (company().https ? company().origin : `${req.protocol}://${req.get("host")}`);
const linkOf = (origin: string, token: string) => `${origin}/?invite=${token}`;

/* ------------------------------------------------------------------ routes */

export function companyRoutes(router: Router): void {
  router.get(
    "/session",
    route((req) => {
      const account = sessionAccount(req);
      return { user: account ? userOf(account) : null };
    }),
  );

  router.post(
    "/session",
    route(async (req, res) => {
      const account = await accounts.checkPassword(req.body?.handle, req.body?.password);
      const session = accounts.openSession(account.handle);
      setCookie(req, res, session.token, session.maxAgeSeconds);
      await ensureJoined(account).catch(() => []);
      return { user: userOf(account) };
    }),
  );

  router.delete(
    "/session",
    route((req, res) => {
      accounts.closeSession(cookieOf(req));
      setCookie(req, res, "", 0);
    }),
  );

  /* Who a link is for, so the page can greet them before they choose a password. */
  router.get(
    "/invites/:token",
    route((req) => {
      const account = accounts.inviteOf(String(req.params.token));
      return { handle: account.handle, name: account.name, id: idOf(account.handle), first: account.state === "invited" };
    }),
  );

  router.post(
    "/invites/:token",
    route(async (req, res) => {
      const account = await accounts.acceptInvite(String(req.params.token), req.body?.password);
      const session = accounts.openSession(account.handle);
      setCookie(req, res, session.token, session.maxAgeSeconds);
      await ensureJoined(account).catch(() => []);
      return { user: userOf(account) };
    }),
  );

  router.post(
    "/me/password",
    route(async (req) => {
      const account = signedIn(req);
      await accounts.changePassword(account.handle, req.body?.current, req.body?.next, cookieOf(req));
    }),
  );

  xoLoginRoutes(router);

  /* ---- administrators ---- */

  router.get(
    "/admin/people",
    route((req) => {
      administrator(req);
      return { people: accounts.listAccounts().map(personOf) };
    }),
  );

  router.post(
    "/admin/people",
    route(async (req) => {
      const admin = administrator(req);
      const text = (value: unknown) => (typeof value === "string" ? value : "");
      const added = await addPerson({ handle: text(req.body?.handle), name: text(req.body?.name), title: text(req.body?.title), role: req.body?.role === "admin" ? "admin" : "member" }, admin.handle);
      const invite = accounts.newInvite(added.account.handle);
      return { person: personOf(accounts.accountOf(added.account.handle)!), link: linkOf(originOf(req), invite.token), expires: invite.expires, certificate: added.certificate, joined: added.joined };
    }),
  );

  /* A new link for someone who lost theirs, or who has forgotten their password. */
  router.post(
    "/admin/people/:handle/link",
    route((req) => {
      administrator(req);
      const invite = accounts.newInvite(String(req.params.handle));
      return { person: personOf(accounts.accountOf(String(req.params.handle))!), link: linkOf(originOf(req), invite.token), expires: invite.expires };
    }),
  );

  otherCompanyRoutes(router);

  router.patch(
    "/admin/people/:handle",
    route((req) => {
      administrator(req);
      if (req.body?.role !== "admin" && req.body?.role !== "member") throw new ChatError(400, "BAD_INPUT", "The role is admin or member.");
      return { person: personOf(accounts.setRole(String(req.params.handle), req.body.role)) };
    }),
  );
}

/* ------------------------------------------------------------------ sign in with XO */

const XO_STATE = "chat_xo_login";
const XO_PATH = "/api/xo-login";
/** One at a time: two answers for the same new person must not make two accounts. */
let xoQueue: Promise<unknown> = Promise.resolve();

/** The account an XO account signs in to. The first time, the company's CA signs them a certificate, as for anyone an administrator adds. */
function xoAccount(who: xoLogin.XoPerson): Promise<Account> {
  const work = xoQueue.then(async () => {
    const before = accounts.accountOfXo(who.subject);
    if (before) return before;
    const handle = accounts.freeHandle(who.email);
    await addPerson({ handle, name: who.name, title: "", role: "member" }, "xo-login");
    return accounts.linkXo(handle, { subject: who.subject, email: who.email });
  });
  xoQueue = work.catch(() => undefined);
  return work;
}

function xoLoginRoutes(router: Router): void {
  if (!xoLogin.xoLoginOn()) return;
  const stateCookie = (req: Request, value: string, maxAge: number) =>
    `${XO_STATE}=${value}; Path=${XO_PATH}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${company().https || req.secure ? "; Secure" : ""}`;
  // These two are opened by the browser itself, not by a page's script: they answer by sending it on.
  const back = (res: Response, problem?: string) => res.redirect(303, problem ? `/?xo-login=${encodeURIComponent(problem)}` : "/");

  router.get("/xo-login/start", async (req, res) => {
    try {
      const { state, url } = await xoLogin.begin(`${originOf(req)}${XO_PATH}/callback`);
      res.appendHeader("Set-Cookie", stateCookie(req, state, 600));
      res.redirect(303, url);
    } catch (err) {
      back(res, translate(err).code);
    }
  });

  router.get("/xo-login/callback", async (req, res) => {
    const text = (value: unknown) => (typeof value === "string" ? value : "");
    res.appendHeader("Set-Cookie", stateCookie(req, "", 0));
    try {
      const who = await xoLogin.finish(text(req.query.state), cookieOf(req, XO_STATE), text(req.query.error) ? "" : text(req.query.code));
      const account = await xoAccount(who);
      const session = accounts.openSession(account.handle);
      setCookie(req, res, session.token, session.maxAgeSeconds);
      await ensureJoined(account).catch(() => []);
      back(res);
    } catch (err) {
      const problem = translate(err);
      console.log(`Sign in with XO: ${problem.code}: ${problem.message}`);
      back(res, problem.code);
    }
  });
}

/* ------------------------------------------------------------------ other companies */

// Two things travel between companies, and an administrator carries both by hand: by email, in a
// chat, on a memory stick. Neither holds a secret.
//   A card       a company's public face: its ID, its root certificate, where its nodes are.
//   An invitation  a new workspace's first block, with the cards of every company on it.
// Each is wrapped as one line of text that starts with a word saying what it is.
const CARD = "fabric-chat-card:";
const INVITATION = "fabric-chat-invitation:";

interface Card {
  fabricChatCard: 1;
  id: string;
  name: string;
  color?: string;
  peer: string;
  orderer: string;
  cluster: string;
  ca: string;
  ordererTls: string;
}

/** Who is on a workspace, as the node's agent read it from an invitation it has checked. */
interface InvitationView {
  channel: string;
  name: string;
  createdBy: string;
  createdAt: string;
  joined: boolean;
  members: { id: string; name: string; color: string; peer: string; orderer: string; fingerprint: string; known: string; self: boolean; reach: Reach | null }[];
}

/** One address of another company's node, tried from this server by the node's agent. */
interface Probe {
  address: string;
  reached: boolean;
  /** What answered holds a certificate signed under the company's root, for that name. */
  proven: boolean;
}

interface Reach {
  peer: Probe;
  orderer: Probe;
  cluster: Probe;
}

const wrap = (word: string, value: unknown) => word + Buffer.from(JSON.stringify(value)).toString("base64url");

/** Reads a pasted card or invitation. Mail programs break long lines, so white space is ignored. */
function unwrap(word: string, pasted: unknown, what: string): Record<string, unknown> {
  const text = typeof pasted === "string" ? pasted.replace(/\s+/g, "") : "";
  if (!text) throw new ChatError(400, "BAD_INPUT", `Paste ${what} first.`);
  const other = word === CARD ? INVITATION : CARD;
  if (text.startsWith(other)) throw new ChatError(400, "BAD_INPUT", `That is ${word === CARD ? "an invitation, not a card" : "a card, not an invitation"}.`);
  try {
    if (!text.startsWith(word)) throw new Error("no prefix");
    const value: unknown = JSON.parse(Buffer.from(text.slice(word.length), "base64url").toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value as Record<string, unknown>;
  } catch {
    throw new ChatError(400, "BAD_INPUT", `That is not ${what}. One starts with "${word}" and has no gaps in it.`);
  }
}

function readCard(pasted: unknown): Card {
  const card = unwrap(CARD, pasted, "a company card");
  const text = (key: string) => typeof card[key] === "string" && card[key] !== "";
  if (card.fabricChatCard !== 1 || !["id", "name", "peer", "orderer", "cluster", "ca", "ordererTls"].every(text)) {
    throw new ChatError(400, "BAD_INPUT", "That card is incomplete. Ask the other company to copy theirs again.");
  }
  return card as unknown as Card;
}

/** SHA-256 of a root certificate: what two administrators read to each other to be sure of a card. */
function fingerprintOf(pem: string): string {
  try {
    return new X509Certificate(pem).fingerprint256.replace(/:/g, "").toLowerCase();
  } catch {
    throw new ChatError(400, "BAD_INPUT", "That card does not hold a certificate.");
  }
}

/** A card as an administrator is shown it before trusting it. */
function cardView(card: Card) {
  const fingerprint = fingerprintOf(card.ca);
  const before = nodeState().companies[card.id];
  // "different" means the same company ID now comes with another root certificate: a warning sign.
  const known = card.id === company().id ? "self" : !before ? "new" : before.fingerprint === fingerprint ? "same" : "different";
  return { id: card.id, name: card.name, color: card.color ?? "#4b6bfb", peer: card.peer, orderer: card.orderer, fingerprint, known };
}

/** This company's card, and every workspace it shares or is about to share. */
function companiesView() {
  const state = nodeState();
  const me = company();
  const own = JSON.parse(readFileSync(path.join(nodeDir, "card.json"), "utf8")) as Card;
  const member = (id: string) => {
    const known = state.companies[id];
    return { id, name: known?.name ?? id, color: known?.color ?? "#888888", fingerprint: known?.fingerprint ?? "", self: id === me.id };
  };
  return {
    card: { ...cardView(own), text: wrap(CARD, own) },
    workspaces: state.workspaces
      .filter((w) => !w.home)
      .map((w) => ({ channel: w.channel, name: w.name, createdBy: w.createdBy, createdAt: w.createdAt, status: w.status, approvals: w.approvals, members: w.members.map(member) })),
  };
}

/** Puts whoever sent this request in the directory of any workspace shared since they last looked. */
export async function joinNewWorkspaces(req: Request): Promise<void> {
  const account = sessionAccount(req);
  // If another company's node is not answering just now, it is tried again the next time.
  if (account) await ensureJoined(account).catch(() => undefined);
}

const tryAgainAt = new Map<string, number>();
let joiningEveryone = false;

/**
 * Puts every person of this company in the directory of each workspace that has become ready.
 * Called every few seconds. In a shared workspace this takes the other companies' peers, which
 * need a moment to find each other after the workspace is made, and may be down: so it keeps trying.
 */
export function joinEveryone(): void {
  if (joiningEveryone) return;
  joiningEveryone = true;
  void (async () => {
    for (const account of accounts.listAccounts()) {
      if ((tryAgainAt.get(account.handle) ?? 0) > Date.now()) continue;
      try {
        await ensureJoined(account);
      } catch {
        tryAgainAt.set(account.handle, Date.now() + 5000);
      }
    }
  })().finally(() => {
    joiningEveryone = false;
  });
}

/**
 * Of some workspaces, the ones whoever sent this request is in the directory of. Those are the
 * ones their pages show: a workspace appears for a person once they can take part in it.
 */
export function shownTo(req: Request, workspaces: WorkspaceConfig[]): WorkspaceConfig[] {
  const joined = new Set(sessionAccount(req)?.joined ?? []);
  return workspaces.filter((w) => joined.has(w.channel));
}

function otherCompanyRoutes(router: Router): void {
  router.get(
    "/admin/companies",
    route((req) => {
      administrator(req);
      return companiesView();
    }),
  );

  /* What a pasted card says, before anything is done with it. */
  router.post(
    "/admin/cards/check",
    route((req) => {
      administrator(req);
      return cardView(readCard(req.body?.text));
    }),
  );

  /*
   * Whether this server can reach the node on a pasted card. The node's agent tries, because it is
   * the node that will have to reach it. What it tries is three addresses the card names, and it
   * sends them nothing but a greeting.
   */
  router.post(
    "/admin/cards/reach",
    route((req) => {
      administrator(req);
      return ask<Reach>("reach", { card: readCard(req.body?.text) }, 40_000);
    }),
  );

  /* Starts a workspace shared with the companies whose cards are given. The answer is the invitation to send them. */
  router.post(
    "/admin/workspaces",
    route(async (req) => {
      administrator(req);
      const name = typeof req.body?.name === "string" ? req.body.name.trim().replace(/\s+/g, " ") : "";
      if (!name || name.length > 40) throw new ChatError(400, "BAD_INPUT", "Give the workspace a name of at most 40 characters.");
      const cards = (Array.isArray(req.body?.cards) ? req.body.cards : []).map(readCard);
      if (cards.length === 0) throw new ChatError(400, "BAD_INPUT", "Give the card of at least one other company.");
      const invitation = await ask<{ channel: string }>("create", { name, cards });
      return { channel: invitation.channel, invitation: wrap(INVITATION, invitation), ...companiesView() };
    }),
  );

  /* The invitation again, for a company that has not accepted yet or has lost it. */
  router.get(
    "/admin/workspaces/:channel/invitation",
    route(async (req) => {
      administrator(req);
      return { invitation: wrap(INVITATION, await ask("invitation", { channel: String(req.params.channel) })) };
    }),
  );

  /* Who is in an invitation, once the node has checked that its first block says what its cards say. */
  router.post(
    "/admin/invitations/check",
    route((req) => {
      administrator(req);
      return ask<InvitationView>("inspect", { invitation: unwrap(INVITATION, req.body?.text, "an invitation") });
    }),
  );

  router.post(
    "/admin/invitations/accept",
    route(async (req) => {
      administrator(req);
      const joined = await ask<InvitationView>("accept", { invitation: unwrap(INVITATION, req.body?.text, "an invitation") });
      return { ...joined, ...companiesView() };
    }),
  );
}

/* ------------------------------------------------------------------ first run */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let ready = false;

/**
 * Makes the first administrator, named in company.json, and a #general channel for the workspace to
 * start with. Tried again every few seconds until it works: the CA and the peer may still be starting.
 */
async function firstRun(): Promise<void> {
  const done = path.join(dataDir, "first-run.done");
  if (existsSync(done)) {
    ready = true;
    return;
  }
  const { admin, name } = company();
  for (;;) {
    try {
      const account = accounts.accountOf(admin.handle) ?? (await addPerson({ ...admin, role: "admin" }, "setup")).account;
      await ensureJoined(account);
      const me = identityOf(idOf(account.handle));
      const home: WorkspaceConfig = network().workspaces[0];
      if ((await chat.overview(me, home)).conversations.length === 0) {
        await chat.createConversation(me, home, { kind: "channel", name: "general", topic: `Everyone at ${name}`, open: true });
      }
      writeFileSync(done, new Date().toISOString() + "\n");
      ready = true;
      console.log(`${name} is set up. First administrator: ${account.name} (${idOf(account.handle)}).`);
      return;
    } catch (err) {
      console.log(`Setting up the first administrator: ${translate(err).message} Trying again.`);
      await sleep(3000);
    }
  }
}

/* ------------------------------------------------------------------ the operator's door */

/** Where the person who runs the server would open the app from that same machine. */
function localAddress(): string {
  return company().origin;
}

/**
 * A second, tiny server that listens inside the container only. Whoever can run a command on the
 * server (./chat admin-link) can use it; nobody on the network can reach it. It is how the first
 * administrator gets their link, and how an administrator who is locked out gets back in.
 */
function operatorDoor(port: number): void {
  const door = http.createServer((req, res) => {
    const answer = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const { name, id, admin, listen } = company();
      if (url.pathname === "/welcome") {
        if (!ready) return answer(503, { error: "The first administrator is still being set up." });
        const first = accounts.accountOf(admin.handle);
        // The first administrator's link is made once. A later ./chat up leaves a link that is still
        // good alone, so that restarting the server does not break a link someone is about to open.
        const waiting = first?.state === "invited";
        const stillGood = !!first?.invite && first.invite.expires > new Date().toISOString();
        const link = first && waiting && !stillGood ? linkOf(localAddress(), accounts.newInvite(first.handle).token) : null;
        return answer(200, { company: name, id, address: localAddress(), open: !company().https && listen.address !== "127.0.0.1", people: accounts.listAccounts().length, admin: first ? { name: first.name, id: idOf(first.handle) } : null, link, unopened: waiting && stillGood });
      }
      if (url.pathname === "/admin-link" && req.method === "POST") {
        const handle = url.searchParams.get("handle") || admin.handle;
        const account = accounts.accountOf(handle);
        const admins = accounts.listAccounts().filter((a) => a.role === "admin").map((a) => a.handle);
        if (!account || account.role !== "admin") return answer(404, { error: `${handle} is not an administrator. The administrators are: ${admins.join(", ") || "none yet"}.` });
        return answer(200, { name: account.name, id: idOf(account.handle), link: linkOf(localAddress(), accounts.newInvite(handle).token) });
      }
      return answer(404, { error: "There is nothing at that address." });
    } catch (err) {
      return answer(500, { error: translate(err).message });
    }
  });
  door.listen(port, "127.0.0.1");
}

export function startCompany(port: number): void {
  operatorDoor(port + 1);
  void firstRun();
}
