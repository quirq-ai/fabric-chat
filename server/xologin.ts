// "Sign in with XO": an optional second way in, next to a handle and a password.
//
// XO's accounts are kept by Clerk. The xo server (quirq-ai/xo) says where Clerk's sign-in is and
// which public OAuth client to use (GET /login), the same one `xo login` uses. The chat sends the
// browser there with a one-time verifier's hash (OAuth's authorization code flow with PKCE). Clerk
// sends the browser back with a code, and the chat swaps the code and the verifier at Clerk for
// who signed in. The client is a public one, so the chat holds no secret of XO's, and the access
// token is dropped as soon as it has said who the person is.
//
// It is on only when XO_LOGIN_SERVER is set, and Clerk must know the chat's own callback address:
// https://<the chat's name>/api/xo-login/callback, in the OAuth application's redirect URLs.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { ChatError } from "./config";

const server = (process.env.XO_LOGIN_SERVER ?? "").trim().replace(/\/+$/, "");
/** Who may come in this way: emails and @domains, separated by commas. Empty: anyone with an XO account. */
const allowed = (process.env.XO_LOGIN_ALLOW ?? "")
  .split(",")
  .map((entry) => entry.trim().toLowerCase())
  .filter(Boolean);

export const xoLoginOn = (): boolean => server !== "";

interface Settings {
  authorize: string;
  token: string;
  userinfo: string;
  clientId: string;
  scope: string;
}

export interface XoPerson {
  /** Clerk's ID of the account: it stays the same when the person changes their email. */
  subject: string;
  email: string;
  name: string;
}

const WAIT_MS = 10 * 60_000;
let settings: { found: Settings; at: number } | null = null;
/** Sign-ins that have left for Clerk and not come back yet, by their state. */
const leaving = new Map<string, { verifier: string; redirect: string; expires: number }>();

const fail = (code: string, message: string) => new ChatError(502, code, message);

async function json(url: string, init: RequestInit, what: string): Promise<Record<string, unknown>> {
  let answer: Response;
  try {
    answer = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(10_000) });
  } catch {
    throw fail("XO_LOGIN_DOWN", `${what} did not answer. Try again in a moment, or sign in with your handle and password.`);
  }
  const body: unknown = await answer.json().catch(() => null);
  if (!answer.ok || !body || typeof body !== "object") throw fail("XO_LOGIN_REFUSED", `${what} refused the sign-in (${answer.status}).`);
  return body as Record<string, unknown>;
}

/** Where XO's sign-in is, as the xo server gives it. Asked again every ten minutes. */
async function read(): Promise<Settings> {
  if (settings && Date.now() - settings.at < WAIT_MS) return settings.found;
  const body = await json(`${server}/login`, { headers: { Accept: "application/json" } }, "The xo server");
  const browser = (body.data as { browser?: Record<string, unknown> } | undefined)?.browser;
  const authorize = typeof browser?.authorize === "string" ? URL.parse(browser.authorize) : null;
  const clientId = browser?.clientId;
  // Plain HTTP is taken only from an xo server that is itself given over plain HTTP: a test set-up.
  const safe = authorize?.protocol === "https:" || (authorize?.protocol === "http:" && server.startsWith("http://"));
  if (!authorize || !safe || authorize.search || typeof clientId !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(clientId)) {
    throw fail("XO_LOGIN_DOWN", "The xo server has no browser sign-in set up.");
  }
  const found: Settings = {
    authorize: authorize.href,
    token: `${authorize.origin}/oauth/token`,
    userinfo: `${authorize.origin}/oauth/userinfo`,
    clientId,
    scope: typeof browser?.scope === "string" ? browser.scope : "openid profile email",
  };
  settings = { found, at: Date.now() };
  return found;
}

/** Starts a sign-in. `redirect` is this chat's own callback address. The answer is where to send the browser. */
export async function begin(redirect: string): Promise<{ state: string; url: string }> {
  const found = await read();
  const now = Date.now();
  for (const [state, waiting] of leaving) if (waiting.expires < now) leaving.delete(state);
  if (leaving.size > 5000) throw new ChatError(429, "BUSY", "Too many sign-ins are under way. Try again in a moment.");
  const state = randomBytes(24).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  leaving.set(state, { verifier, redirect, expires: now + WAIT_MS });
  const query = new URLSearchParams({
    response_type: "code",
    client_id: found.clientId,
    redirect_uri: redirect,
    scope: found.scope,
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  });
  return { state, url: `${found.authorize}?${query}` };
}

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * Finishes a sign-in that came back from Clerk. `kept` is the state this browser was given in a
 * cookie when it left: a link someone else started gives them nothing.
 */
export async function finish(state: string, kept: string, code: string): Promise<XoPerson> {
  const waiting = leaving.get(state);
  if (!state || !kept || !same(state, kept) || !waiting || waiting.expires < Date.now()) {
    throw new ChatError(400, "XO_LOGIN_STALE", "That sign-in took too long, or was started somewhere else. Start it again.");
  }
  leaving.delete(state);
  if (!code) throw new ChatError(400, "XO_LOGIN_STOPPED", "The sign-in was not finished.");
  const found = await read();
  const swapped = await json(
    found.token,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: waiting.redirect, client_id: found.clientId, code_verifier: waiting.verifier }),
    },
    "XO's sign-in",
  );
  if (typeof swapped.access_token !== "string") throw fail("XO_LOGIN_REFUSED", "XO's sign-in did not say who signed in.");
  const who = await json(found.userinfo, { headers: { Authorization: `Bearer ${swapped.access_token}`, Accept: "application/json" } }, "XO's sign-in");
  const subject = typeof who.sub === "string" ? who.sub : "";
  const email = typeof who.email === "string" ? who.email.trim().toLowerCase() : "";
  if (!/^user_[A-Za-z0-9]{1,100}$/.test(subject) || !/^[^@\s]{1,100}@[^@\s]{1,150}$/.test(email) || who.email_verified === false) {
    throw new ChatError(403, "XO_LOGIN_NO_EMAIL", "That XO account has no confirmed email address.");
  }
  if (allowed.length > 0 && !allowed.includes(email) && !allowed.includes(email.slice(email.indexOf("@")))) {
    throw new ChatError(403, "XO_LOGIN_NOT_ALLOWED", "That XO account is not on this company's list.");
  }
  const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
  const name = text(who.name) || [text(who.given_name), text(who.family_name)].filter(Boolean).join(" ") || email.split("@")[0];
  return { subject, email, name };
}
