// The shapes the API returns. Most are defined once, on the server, and only their types are used here.
import type { Scope } from "../../server/config";
import type { CertificateView, Person } from "../../server/people";

export type { Conversation, Holding, Message, Overview, Profile, Thread, Version } from "../../server/chat";
export type { Scope } from "../../server/config";
export type { BlockView, ReadView, TxView, WriteView } from "../../server/decode";
export type { Receipt } from "../../server/fabric";
export type { CertificateView, Party, Person } from "../../server/people";

export interface Org {
  code: string;
  name: string;
  color: string;
  msp: string;
  /** False for another company in a shared workspace, on a company's own server. */
  own?: boolean;
  peer: string;
  orderer: string;
  ca: string;
  chaincode: string;
  couchdb: string;
}

export interface Workspace {
  channel: string;
  name: string;
  about: string;
  orgs: string[];
  collections: { name: string; orgs: string[] }[];
  scopes: Scope[];
}

export interface NetworkInfo {
  /** sandbox: three made-up companies and no passwords. company: one company's own server, with sign-in. */
  mode: "sandbox" | "company";
  /** True on a company's own server until someone signs in: only the company's name is given. */
  locked: boolean;
  company?: { id: string; name: string; color: string };
  name: string;
  about: string;
  fabric: string;
  consensus: { type: string; batchTimeout: string; maxMessageCount: number };
  chaincode: { name: string; version: string; sequence: number };
  orgs: Org[];
  workspaces: Workspace[];
  people: Person[];
}

export type Role = "admin" | "member";

/** Whoever is signed in on a company's own server. */
export interface SessionUser {
  id: string;
  handle: string;
  name: string;
  title: string;
  role: Role;
}

/** A person as an administrator sees them. */
export interface Member {
  id: string;
  handle: string;
  name: string;
  title: string;
  role: Role;
  /** invited: has a certificate, but has not chosen a password yet. */
  state: "invited" | "active";
  linkWaiting: boolean;
  createdAt: string;
  createdBy: string;
}

/** A company's card, as an administrator is shown it before trusting it. */
export interface CardView {
  id: string;
  name: string;
  color: string;
  peer: string;
  orderer: string;
  /** SHA-256 of the company's root certificate. */
  fingerprint: string;
  /** self: this company's own. different: the same ID came with another certificate before. */
  known: "self" | "new" | "same" | "different";
}

/** A workspace shared with other companies, and how far it has got. */
export interface SharedWorkspace {
  channel: string;
  name: string;
  createdBy: string;
  createdAt: string;
  /** waiting: for other companies' nodes to join. agreeing: on the rules. ready: people can chat. */
  status: "waiting" | "agreeing" | "ready";
  approvals: Record<string, boolean>;
  members: { id: string; name: string; color: string; fingerprint: string; self: boolean }[];
}

export interface CompaniesView {
  card: CardView & { text: string };
  workspaces: SharedWorkspace[];
}

/** One address of another company's node, tried from this company's server. */
export interface Probe {
  address: string;
  /** Something answered there. */
  reached: boolean;
  /** What answered holds a certificate signed under the company's root certificate, for that name. */
  proven: boolean;
}

/** Whether this company's server can reach another company's node: its peer, and its orderer on both of its ports. */
export interface Reach {
  peer: Probe;
  orderer: Probe;
  cluster: Probe;
}

/** Who is on a workspace, read by this company's node from an invitation it has checked. */
export interface InvitationView {
  channel: string;
  name: string;
  createdBy: string;
  createdAt: string;
  joined: boolean;
  members: (Omit<CardView, "known"> & { known: string; self: boolean; reach?: Reach | null })[];
}

export interface Me {
  id: string;
  handle: string;
  org: string;
  msp: string;
  /** Set on a company's own server only. */
  role: Role | null;
  certificate: CertificateView;
  workspaces: string[];
  asTheLedgerSeesMe: { id: string; handle: string; msp: string; subject: string; issuer: string; units: string[] } | null;
}

export interface NodeStatus {
  org: string;
  kind: "peer" | "orderer" | "ca" | "chaincode" | "database";
  name: string;
  state: string;
  controllable: boolean;
}

export interface LedgerStatus {
  channel: string;
  org: string;
  onChannel: boolean;
  height: number;
  tip: string;
  state: string;
  error: string;
}

export interface Status {
  nodes: NodeStatus[];
  ledgers: LedgerStatus[];
}
