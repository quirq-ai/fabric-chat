// Accounts and sessions on a company's own server: who may sign in, and with what password.
//
// An account is the app's side of a person. Their identity on the ledger is a certificate and a
// key (see wallet.ts); the account is what lets them use it: a password, a role, and whether they
// have accepted their invitation yet.
//
// Everything is kept in two small files in the app's own data volume. Passwords are stored only as
// scrypt hashes, and invitation links and session cookies only as SHA-256 hashes, so reading the
// files does not let anyone sign in.
import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ChatError, dataDir } from "./config";

export type Role = "admin" | "member";

export interface Account {
  handle: string;
  name: string;
  title: string;
  role: Role;
  /** invited: has a certificate, but has not chosen a password yet. */
  state: "invited" | "active";
  password?: { salt: string; hash: string; n: number; r: number; p: number };
  /** A one-time link to choose a password: a first invitation, or a reset. */
  invite?: { hash: string; expires: string };
  /** The workspaces whose directory this person is in. */
  joined: string[];
  createdAt: string;
  createdBy: string;
}

interface Session {
  handle: string;
  expires: string;
}

const HANDLE = /^[a-z0-9][a-z0-9._-]{0,31}$/;
/** Names the node uses for itself at the certificate authority, and a few that would mislead. */
const RESERVED = new Set(["registrar", "people-registrar", "chat-service", "node-admin", "peer", "orderer", "admin", "root", "system", "service"]);
const INVITE_DAYS = 7;
const SESSION_DAYS = 30;
const MIN_PASSWORD = 10;
/** scrypt's cost. These are the values OWASP gives for it; each check takes about a fifth of a second. */
const COST = { n: 32768, r: 8, p: 3 };

const accountsFile = () => path.join(dataDir, "accounts.json");
const sessionsFile = () => path.join(dataDir, "sessions.json");

let accounts: Account[] | null = null;
let sessions: Record<string, Session> | null = null;

function read<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

/** Writes a file whole or not at all: a crash mid-write cannot leave half an accounts file. */
function write(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const draft = `${file}.new`;
  writeFileSync(draft, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  renameSync(draft, file);
}

function all(): Account[] {
  accounts ??= read<{ accounts: Account[] }>(accountsFile(), { accounts: [] }).accounts;
  return accounts;
}

function saveAccounts(): void {
  write(accountsFile(), { accounts: all() });
}

function allSessions(): Record<string, Session> {
  sessions ??= read<{ sessions: Record<string, Session> }>(sessionsFile(), { sessions: {} }).sessions;
  return sessions;
}

function saveSessions(): void {
  const now = new Date().toISOString();
  for (const [hash, session] of Object.entries(allSessions())) if (session.expires < now) delete allSessions()[hash];
  write(sessionsFile(), { sessions: allSessions() });
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const token = () => randomBytes(32).toString("base64url");
const later = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

function derive(password: string, salt: Buffer, cost: { n: number; r: number; p: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize("NFKC"), salt, 64, { N: cost.n, r: cost.r, p: cost.p, maxmem: 256 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

async function hashed(password: string): Promise<NonNullable<Account["password"]>> {
  const salt = randomBytes(16);
  return { salt: salt.toString("base64"), hash: (await derive(password, salt, COST)).toString("base64"), ...COST };
}

function checkNewPassword(handle: string, password: unknown): string {
  if (typeof password !== "string" || password.length < MIN_PASSWORD) throw new ChatError(400, "WEAK_PASSWORD", `A password needs at least ${MIN_PASSWORD} characters.`);
  if (password.length > 200) throw new ChatError(400, "WEAK_PASSWORD", "A password can be at most 200 characters.");
  if (password.toLowerCase() === handle) throw new ChatError(400, "WEAK_PASSWORD", "A password cannot be the same as the handle.");
  return password;
}

/* ------------------------------------------------------------------ accounts */

export function listAccounts(): Account[] {
  return [...all()];
}

export function accountOf(handle: string): Account | null {
  return all().find((a) => a.handle === handle) ?? null;
}

/** Checks a handle someone typed for a new person, and returns it in the form it is kept in. */
export function checkHandle(value: unknown): string {
  const handle = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!HANDLE.test(handle)) throw new ChatError(400, "BAD_INPUT", "A handle is lower-case letters, digits, dot, dash or underscore, at most 32 long.");
  if (RESERVED.has(handle)) throw new ChatError(400, "BAD_INPUT", `"${handle}" is a name the node uses for itself. Choose another handle.`);
  return handle;
}

export function addAccount(input: { handle: string; name: string; title: string; role: Role; createdBy: string }): Account {
  if (accountOf(input.handle)) throw new ChatError(409, "HANDLE_TAKEN", `There is already someone called ${input.handle}.`);
  const account: Account = { ...input, state: "invited", joined: [], createdAt: new Date().toISOString() };
  all().push(account);
  saveAccounts();
  return account;
}

export function noteJoined(handle: string, channel: string): void {
  const account = accountOf(handle);
  if (!account || account.joined.includes(channel)) return;
  account.joined.push(channel);
  saveAccounts();
}

export function setRole(handle: string, role: Role): Account {
  const account = accountOf(handle);
  if (!account) throw new ChatError(404, "NO_SUCH_PERSON", `There is nobody called ${handle}.`);
  if (account.role === "admin" && role !== "admin" && all().filter((a) => a.role === "admin").length === 1) {
    throw new ChatError(409, "LAST_ADMIN", "This is the only administrator. Make someone else an administrator first.");
  }
  account.role = role;
  saveAccounts();
  return account;
}

/* ------------------------------------------------------------------ invitations */

/**
 * Makes a one-time link token for a person to choose a password, replacing any earlier one. Used
 * for a first invitation and for a reset alike. The token itself is returned once and not kept.
 */
export function newInvite(handle: string): { token: string; expires: string } {
  const account = accountOf(handle);
  if (!account) throw new ChatError(404, "NO_SUCH_PERSON", `There is nobody called ${handle}.`);
  const made = token();
  account.invite = { hash: sha256(made), expires: later(INVITE_DAYS) };
  saveAccounts();
  return { token: made, expires: account.invite.expires };
}

/** The account a link belongs to, as long as the link is still good. */
export function inviteOf(given: string): Account {
  const hash = sha256(given);
  const account = all().find((a) => a.invite?.hash === hash);
  if (!account) throw new ChatError(404, "NO_SUCH_INVITE", "This link has been used already, or was replaced by a newer one. Ask an administrator for a new link.");
  if (account.invite!.expires < new Date().toISOString()) throw new ChatError(410, "INVITE_EXPIRED", "This link has run out. Ask an administrator for a new one.");
  return account;
}

/** Sets the password the person chose, and uses up the link. Anyone signed in as them is signed out. */
export async function acceptInvite(given: string, password: unknown): Promise<Account> {
  const handle = inviteOf(given).handle;
  const stored = await hashed(checkNewPassword(handle, password));
  // The link is checked again: hashing takes a moment, and it must not be accepted twice.
  const account = inviteOf(given);
  account.password = stored;
  account.state = "active";
  delete account.invite;
  saveAccounts();
  closeSessionsOf(account.handle);
  return account;
}

/* ------------------------------------------------------------------ passwords */

const WINDOW_MS = 10 * 60_000;
const MAX_WRONG = 8;
/** Wrong passwords in the last ten minutes, by handle. */
const failures = new Map<string, number[]>();
/** Checks under way. Each costs real processor time, so only a few may run at once. */
let checking = 0;

function recent(handle: string): number[] {
  const since = Date.now() - WINDOW_MS;
  const list = (failures.get(handle) ?? []).filter((at) => at > since);
  if (list.length) failures.set(handle, list);
  else failures.delete(handle);
  return list;
}

/**
 * Checks a handle and password. The answer for an unknown handle is the same as for a wrong
 * password, and takes as long, so the sign-in screen cannot be used to find out who has an account.
 */
export async function checkPassword(handleGiven: unknown, password: unknown): Promise<Account> {
  const handle = typeof handleGiven === "string" ? handleGiven.trim().toLowerCase().slice(0, 64) : "";
  if (recent(handle).length >= MAX_WRONG) throw new ChatError(429, "TOO_MANY_TRIES", "Too many wrong passwords for that handle. Wait ten minutes and try again.");
  if (checking >= 8) throw new ChatError(429, "BUSY", "The server is checking many passwords at once. Try again in a moment.");
  const account = accountOf(handle);
  const stored = account?.password;
  const given = typeof password === "string" ? password.slice(0, 200) : "";
  const salt = stored ? Buffer.from(stored.salt, "base64") : Buffer.alloc(16);
  checking++;
  let key: Buffer;
  try {
    key = await derive(given, salt, stored ?? COST);
  } finally {
    checking--;
  }
  if (!account || !stored || !timingSafeEqual(key, Buffer.from(stored.hash, "base64"))) {
    // Kept for real handles and made-up ones alike, with a ceiling so the list cannot grow without end.
    if (failures.size > 20_000) failures.clear();
    failures.set(handle, [...recent(handle), Date.now()]);
    throw new ChatError(401, "WRONG_PASSWORD", "That handle and password do not match.");
  }
  failures.delete(handle);
  return account;
}

/** Changes a person's own password. Their other sessions are closed; `keep` is the one they are using. */
export async function changePassword(handle: string, current: unknown, next: unknown, keep: string): Promise<void> {
  const account = await checkPassword(handle, current);
  account.password = await hashed(checkNewPassword(handle, next));
  delete account.invite;
  saveAccounts();
  closeSessionsOf(handle, keep);
}

/* ------------------------------------------------------------------ sessions */

/** Starts a session and returns the value for the person's cookie. Only its hash is kept. */
export function openSession(handle: string): { token: string; maxAgeSeconds: number } {
  const made = token();
  allSessions()[sha256(made)] = { handle, expires: later(SESSION_DAYS) };
  saveSessions();
  return { token: made, maxAgeSeconds: SESSION_DAYS * 86_400 };
}

/** The account a cookie belongs to, or null when the cookie is unknown or has run out. */
export function sessionOf(given: string): Account | null {
  if (!given) return null;
  const session = allSessions()[sha256(given)];
  if (!session || session.expires < new Date().toISOString()) return null;
  const account = accountOf(session.handle);
  return account && account.state === "active" ? account : null;
}

export function closeSession(given: string): void {
  if (!given || !allSessions()[sha256(given)]) return;
  delete allSessions()[sha256(given)];
  saveSessions();
}

export function closeSessionsOf(handle: string, keep = ""): void {
  const kept = keep ? sha256(keep) : "";
  for (const [hash, session] of Object.entries(allSessions())) if (session.handle === handle && hash !== kept) delete allSessions()[hash];
  saveSessions();
}
