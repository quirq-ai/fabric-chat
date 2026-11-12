// What `npm run net:up` generated: the companies, their nodes, the workspaces and the people.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const generated = path.join(root, ".generated");

export interface PersonConfig {
  id: string;
  name: string;
  title: string;
}

export interface OrgConfig {
  code: string;
  name: string;
  color: string;
  msp: string;
  ordererMsp: string;
  peer: { name: string; endpoint: string; tlsCa: string };
  orderer: string;
  ca: string;
  chaincode: string;
  couchdb: { name: string; url: string };
  service: { cert: string; key: string };
  caCert: string;
  wallet: string;
  people: PersonConfig[];
}

export interface WorkspaceConfig {
  channel: string;
  name: string;
  about: string;
  orgs: string[];
  collections: { name: string; orgs: string[] }[];
}

export interface NetworkConfig {
  name: string;
  domain: string;
  about: string;
  fabric: string;
  consensus: { type: string; batchTimeout: string; maxMessageCount: number };
  chaincode: { name: string; version: string; sequence: number };
  cli: string;
  appPort: number;
  orgs: OrgConfig[];
  workspaces: WorkspaceConfig[];
}

/** An error the API turns into a response: an HTTP status, a code the UI can match on, and plain words. */
export class ChatError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

let cached: NetworkConfig | null = null;

export function network(): NetworkConfig {
  if (cached) return cached;
  const file = path.join(generated, "network.resolved.json");
  if (!existsSync(file)) throw new ChatError(503, "LEDGER_DOWN", "The Fabric network has not been made yet. Run: npm run net:up");
  cached = JSON.parse(readFileSync(file, "utf8")) as NetworkConfig;
  return cached;
}

export function orgByCode(code: string): OrgConfig {
  const org = network().orgs.find((o) => o.code === code);
  if (!org) throw new ChatError(404, "NO_SUCH_ORG", `There is no company called ${code}.`);
  return org;
}

export function orgByMsp(msp: string): OrgConfig {
  const org = network().orgs.find((o) => o.msp === msp);
  if (!org) throw new ChatError(404, "NO_SUCH_ORG", `There is no company with the ID ${msp}.`);
  return org;
}

export function workspaceOf(channel: string): WorkspaceConfig {
  const workspace = network().workspaces.find((w) => w.channel === channel);
  if (!workspace) throw new ChatError(404, "NO_SUCH_WORKSPACE", `There is no workspace called ${channel}.`);
  return workspace;
}

/**
 * Where a conversation can be kept, and whose peers store it.
 *  - public: the channel's shared state. Every member company's peer stores it.
 *  - shared: a private data collection of two companies.
 *  - org:    one company's own collection.
 */
export interface Scope {
  name: string;
  kind: "public" | "shared" | "org";
  /** The companies whose peers store the text. */
  orgs: string[];
}

export const PUBLIC = "public";
const IMPLICIT = "_implicit_org_";

/** Every scope a workspace has. */
export function scopesOf(workspace: WorkspaceConfig): Scope[] {
  return [
    { name: PUBLIC, kind: "public", orgs: workspace.orgs },
    ...workspace.collections.map((c) => ({ name: c.name, kind: "shared" as const, orgs: c.orgs })),
    ...workspace.orgs.map((code) => ({ name: IMPLICIT + orgByCode(code).msp, kind: "org" as const, orgs: [code] })),
  ];
}

/** The scopes of a workspace that one company's peer stores. */
export function scopesFor(workspace: WorkspaceConfig, orgCode: string): Scope[] {
  return scopesOf(workspace).filter((s) => s.orgs.includes(orgCode));
}

export function scopeOf(workspace: WorkspaceConfig, name: string): Scope {
  const scope = scopesOf(workspace).find((s) => s.name === name);
  if (!scope) throw new ChatError(404, "NO_SUCH_SCOPE", `The ${workspace.name} workspace has no scope called ${name}.`);
  return scope;
}

/** "Birch & Co's", "Aster Labs'". */
export const owned = (name: string) => (name.endsWith("s") ? `${name}'` : `${name}'s`);

/** The absolute path of a file under .generated. */
export const file = (relative: string) => path.join(generated, relative);
