// Calls to the app server. In the sandbox every call that acts as a person names them in the
// x-chat-user header. On a company's own server the browser's session cookie says who is calling,
// and the header is ignored.
import type { BlockView, CardView, CertificateView, CompaniesView, Conversation, Holding, InvitationView, Me, Member, Message, NetworkInfo, Overview, Person, Reach, Receipt, Role, Scope, SessionUser, Status, Thread, TxView, Version } from "./types";

/** Sent to the window when the server says the session is over, so the app can show the sign-in screen. */
export const SIGNED_OUT = "chat:signed-out";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(as: string | null, method: string, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      headers: { ...(as ? { "x-chat-user": as } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "OFFLINE", "The app server did not answer. Is it still running?");
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    if (data?.error?.code === "SIGN_IN") window.dispatchEvent(new Event(SIGNED_OUT));
    throw new ApiError(response.status, data?.error?.code ?? "ERROR", data?.error?.message ?? `The server answered ${response.status}.`);
  }
  return data as T;
}

const at = (ws: string, scope: string, conv: string) => `/w/${ws}/conversations/${encodeURIComponent(scope)}/${encodeURIComponent(conv)}`;

export interface TxDetail {
  block: { number: number; hash: string; previousHash: string; dataHash: string; txCount: number };
  tx: TxView;
}

export interface Enrolment {
  person: Person;
  outcome: string;
  certificate: CertificateView;
  joined: { channel: string; receipt: Receipt }[];
}

/** What an administrator gets back after adding a person: the link to pass on to them. */
export interface Added {
  person: Member;
  link: string;
  expires: string;
  certificate?: CertificateView;
  joined?: { channel: string; block: number }[];
}

/** A company's own server only: signing in, and what an administrator can do. */
export const account = {
  session: () => call<{ user: SessionUser | null }>(null, "GET", "/session"),
  signIn: (handle: string, password: string) => call<{ user: SessionUser }>(null, "POST", "/session", { handle, password }),
  signOut: () => call<{ ok: true }>(null, "DELETE", "/session"),
  invite: (token: string) => call<{ handle: string; name: string; id: string; first: boolean }>(null, "GET", `/invites/${encodeURIComponent(token)}`),
  accept: (token: string, password: string) => call<{ user: SessionUser }>(null, "POST", `/invites/${encodeURIComponent(token)}`, { password }),
  changePassword: (current: string, next: string) => call<{ ok: true }>(null, "POST", "/me/password", { current, next }),
  people: () => call<{ people: Member[] }>(null, "GET", "/admin/people"),
  add: (input: { handle: string; name: string; title: string; role: Role }) => call<Added>(null, "POST", "/admin/people", input),
  newLink: (handle: string) => call<Added>(null, "POST", `/admin/people/${encodeURIComponent(handle)}/link`),
  setRole: (handle: string, role: Role) => call<{ person: Member }>(null, "PATCH", `/admin/people/${encodeURIComponent(handle)}`, { role }),

  // Other companies: cards, shared workspaces, invitations.
  companies: () => call<CompaniesView>(null, "GET", "/admin/companies"),
  checkCard: (text: string) => call<CardView>(null, "POST", "/admin/cards/check", { text }),
  reachCard: (text: string) => call<Reach>(null, "POST", "/admin/cards/reach", { text }),
  startWorkspace: (name: string, cards: string[]) => call<CompaniesView & { channel: string; invitation: string }>(null, "POST", "/admin/workspaces", { name, cards }),
  invitationOf: (channel: string) => call<{ invitation: string }>(null, "GET", `/admin/workspaces/${encodeURIComponent(channel)}/invitation`),
  checkInvitation: (text: string) => call<InvitationView>(null, "POST", "/admin/invitations/check", { text }),
  acceptInvitation: (text: string) => call<InvitationView & CompaniesView>(null, "POST", "/admin/invitations/accept", { text }),
};

export const api = {
  network: () => call<NetworkInfo>(null, "GET", "/network"),
  status: () => call<Status>(null, "GET", "/network/status"),
  node: (as: string, name: string, action: "stop" | "start") => call<{ name: string }>(as, "POST", `/network/nodes/${encodeURIComponent(name)}/${action}`),
  enrol: (input: { org: string; handle: string; name: string; title: string }) => call<Enrolment>(null, "POST", "/people", input),
  me: (as: string) => call<Me>(as, "GET", "/me"),
  overview: (as: string, ws: string) => call<Overview>(as, "GET", `/w/${ws}/overview`),
  create: (as: string, ws: string, input: { kind: "channel" | "dm"; name?: string; topic?: string; members: string[]; open?: boolean }) =>
    call<{ conversation: Conversation; receipt: Receipt | null; scope: Scope }>(as, "POST", `/w/${ws}/conversations`, input),
  addMembers: (as: string, ws: string, scope: string, conv: string, members: string[]) =>
    call<{ result: Conversation; receipt: Receipt }>(as, "POST", `${at(ws, scope, conv)}/members`, { members }),
  messages: (as: string, ws: string, scope: string, conv: string) => call<Thread>(as, "GET", `${at(ws, scope, conv)}/messages`),
  post: (as: string, ws: string, scope: string, conv: string, text: string) =>
    call<{ message: Message; receipt: Receipt }>(as, "POST", `${at(ws, scope, conv)}/messages`, { text }),
  edit: (as: string, ws: string, scope: string, conv: string, msg: string, text: string) =>
    call<{ message: Message; receipt: Receipt }>(as, "PATCH", `${at(ws, scope, conv)}/messages/${msg}`, { text }),
  remove: (as: string, ws: string, scope: string, conv: string, msg: string) =>
    call<{ result: { id: string; purged: boolean }; receipt: Receipt }>(as, "DELETE", `${at(ws, scope, conv)}/messages/${msg}`),
  react: (as: string, ws: string, scope: string, conv: string, msg: string, emoji: string, on: boolean) =>
    call<{ receipt: Receipt }>(as, "POST", `${at(ws, scope, conv)}/messages/${msg}/reactions`, { emoji, on }),
  history: (as: string, ws: string, conv: string, msg: string) => call<Version[]>(as, "GET", `${at(ws, "public", conv)}/messages/${msg}/history`),
  holdings: (as: string, ws: string, scope: string, conv: string, msg: string) =>
    call<{ key: string; holdings: Holding[] }>(as, "GET", `${at(ws, scope, conv)}/messages/${msg}/holdings`),
  blocks: (as: string, ws: string, limit = 40) => call<{ height: number; state: string; blocks: BlockView[] }>(as, "GET", `/w/${ws}/blocks?limit=${limit}`),
  tx: (as: string, ws: string, txId: string) => call<TxDetail>(as, "GET", `/w/${ws}/tx/${txId}`),
};
