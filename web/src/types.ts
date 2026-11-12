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
  name: string;
  about: string;
  fabric: string;
  consensus: { type: string; batchTimeout: string; maxMessageCount: number };
  chaincode: { name: string; version: string; sequence: number };
  orgs: Org[];
  workspaces: Workspace[];
  people: Person[];
}

export interface Me {
  id: string;
  handle: string;
  org: string;
  msp: string;
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
