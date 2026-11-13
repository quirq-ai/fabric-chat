// The facts about the Fabric network this app sits on. The app runs in one of two ways:
//
//   sandbox   three made-up companies on one laptop, for seeing how Fabric works. This one server
//             plays all three, with no sign-in. The facts come from .generated (npm run net:up).
//   company   one real company's own server. One company, real sign-in. The facts come from the
//             folder the node's admin tool wrote for the app (./chat up).
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const generated = path.join(root, ".generated");

/** Set on a company's own server: the folder its admin tool wrote for the app. */
export const nodeDir = process.env.CHAT_NODE ?? "";
export const mode: "sandbox" | "company" = nodeDir ? "company" : "sandbox";
/** Where a company's app keeps its accounts, its sessions and each person's encrypted key. */
export const dataDir = process.env.CHAT_DATA ?? path.join(root, ".data");

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
  /**
   * False for another company in a shared workspace. This server holds none of its keys and cannot
   * ask its nodes anything: it knows that company only from its card and from the ledger.
   */
  own: boolean;
}

export interface WorkspaceConfig {
  channel: string;
  name: string;
  about: string;
  orgs: string[];
  collections: { name: string; orgs: string[] }[];
}

/** A company's own server only: the company it belongs to. */
export interface CompanyConfig {
  /** The company's ID on every ledger: a domain name it owns. Also its MSP ID. */
  id: string;
  name: string;
  color: string;
  /** The name people's browsers reach the app by. */
  chatHost: string;
  listen: { address: string; port: number };
  /** Whether people reach the app over HTTPS, through the proxy on the same server. */
  https: boolean;
  /** Where people open the chat, for example https://chat.aster.example. Links the server hands out start with it. */
  origin: string;
  /** The first administrator, named in company.json. */
  admin: { handle: string; name: string; title: string };
  ca: { url: string; name: string };
  release: string;
}

export interface NetworkConfig {
  mode: "sandbox" | "company";
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
  company?: CompanyConfig;
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
let stateStamp = 0;
let stateCheckedAt = 0;

export function network(): NetworkConfig {
  // On a company's own server the list of workspaces grows while the app runs: the node's agent
  // rewrites it when a workspace is shared or becomes ready. Look for that about once a second.
  if (cached && mode === "company" && Date.now() - stateCheckedAt > 1000) {
    stateCheckedAt = Date.now();
    if (stampOf(stateFile()) !== stateStamp) cached = null;
  }
  if (cached) return cached;
  cached = mode === "company" ? companyNetwork() : sandboxNetwork();
  return cached;
}

function sandboxNetwork(): NetworkConfig {
  const file = path.join(generated, "network.resolved.json");
  if (!existsSync(file)) throw new ChatError(503, "LEDGER_DOWN", "The Fabric network has not been made yet. Run: npm run net:up");
  const net = JSON.parse(readFileSync(file, "utf8")) as NetworkConfig;
  // The sandbox's one server plays every company, so every company is its own.
  return { ...net, mode: "sandbox", orgs: net.orgs.map((org) => ({ ...org, own: true })) };
}

/** What the node's admin tool writes for the app: ctl/init.sh. */
interface NodeFile {
  company: { id: string; name: string; color: string };
  hosts: { chat: string; peer: string; orderer: string };
  admin: { handle: string; name: string; title: string };
  listen: { address: string; port: number };
  https?: boolean;
  origin?: string;
  release: string;
  fabric: string;
  ca: { url: string; name: string };
  consensus: { type: string; batchTimeout: string; maxMessageCount: number };
  chaincode: { name: string; version: string; sequence: number };
}

/** A workspace as the node's agent reports it, usable yet or not. */
export interface NodeWorkspace {
  channel: string;
  name: string;
  /** The IDs of the companies on it, this one included. */
  members: string[];
  createdBy: string;
  createdAt: string;
  /** True for the company's own workspace, which no other company is on. */
  home: boolean;
  /** waiting: for other companies' nodes to join. agreeing: on the rules. ready: people can chat. */
  status: "waiting" | "agreeing" | "ready";
  /** While agreeing: which companies have approved the rules so far. */
  approvals: Record<string, boolean>;
}

/** Another company, as its card describes it. */
export interface KnownCompany {
  id: string;
  name: string;
  color: string;
  peer: string;
  orderer: string;
  /** SHA-256 of its root certificate: what two administrators compare to be sure of a card. */
  fingerprint: string;
}

export interface NodeState {
  workspaces: NodeWorkspace[];
  companies: Record<string, KnownCompany>;
}

const stateFile = () => path.join(nodeDir, "workspaces.json");
const stampOf = (file: string) => (existsSync(file) ? statSync(file).mtimeMs : 0);

/** Every workspace this company's node is on and every company it knows, as the agent last wrote them. */
export function nodeState(): NodeState {
  if (!existsSync(stateFile())) return { workspaces: [], companies: {} };
  return JSON.parse(readFileSync(stateFile(), "utf8")) as NodeState;
}

/**
 * One company's server, described in the same shape as the sandbox: a network in which only one
 * company is this server's own. The other companies are the ones it shares a workspace with. A
 * company's ID stands in for the short code the sandbox gives each company.
 */
function companyNetwork(): NetworkConfig {
  const file = path.join(nodeDir, "node.json");
  if (!existsSync(file)) throw new ChatError(503, "LEDGER_DOWN", "This company's node has not finished starting. Run: ./chat up");
  const node = JSON.parse(readFileSync(file, "utf8")) as NodeFile;
  stateStamp = stampOf(stateFile());
  stateCheckedAt = Date.now();
  const state = nodeState();
  const at = (name: string) => path.join(nodeDir, name);
  const org: OrgConfig = {
    code: node.company.id,
    name: node.company.name,
    color: node.company.color,
    msp: node.company.id,
    ordererMsp: node.company.id,
    own: true,
    peer: { name: node.hosts.peer, endpoint: `${node.hosts.peer}:7051`, tlsCa: at("ca-cert.pem") },
    orderer: node.hosts.orderer,
    ca: "ca",
    chaincode: "chaincode",
    couchdb: { name: "couchdb", url: "" },
    service: { cert: at("service/cert.pem"), key: at("service/key.pem") },
    caCert: at("ca-cert.pem"),
    wallet: path.join(dataDir, "wallet"),
    people: [],
  };
  const others = Object.values(state.companies)
    .filter((known) => known.id !== org.code)
    .map(
      (known): OrgConfig => ({
        code: known.id,
        name: known.name,
        color: known.color,
        msp: known.id,
        ordererMsp: known.id,
        own: false,
        peer: { name: known.peer.split(":")[0], endpoint: "", tlsCa: "" },
        orderer: known.orderer.split(":")[0],
        ca: "",
        chaincode: "",
        couchdb: { name: "", url: "" },
        service: { cert: "", key: "" },
        caCert: "",
        wallet: "",
        people: [],
      }),
    );
  const nameOf = (id: string) => (id === org.code ? org.name : (state.companies[id]?.name ?? id));
  const list = (names: string[]) => (names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);
  // People chat only in a workspace whose rules are in force. The others are an administrator's business.
  const ready = state.workspaces.filter((w) => w.status === "ready" && w.members.includes(org.code));
  return {
    mode: "company",
    name: node.company.id,
    domain: node.company.id,
    about: `${owned(node.company.name)} own Fabric Chat server.`,
    fabric: node.fabric,
    consensus: node.consensus,
    chaincode: node.chaincode,
    cli: "",
    appPort: 8080,
    orgs: [org, ...others],
    workspaces: ready.map((w) => ({
      channel: w.channel,
      // The home workspace carries the company's name, which may have changed since it was made.
      name: w.home ? org.name : w.name,
      about: w.home ? `${org.name} only. No other company holds a copy of this workspace.` : `Shared by ${list(w.members.map(nameOf))}. Each company's node keeps a full copy.`,
      orgs: w.members,
      collections: [],
    })),
    company: {
      ...node.company,
      chatHost: node.hosts.chat,
      listen: node.listen,
      https: node.https === true,
      origin: node.origin ?? `http://localhost:${node.listen.port}`,
      admin: node.admin,
      ca: node.ca,
      release: node.release,
    },
  };
}

/** The company this server belongs to. Only a company's own server has one. */
export function company(): CompanyConfig {
  const found = network().company;
  if (!found) throw new ChatError(404, "NOT_FOUND", "There is nothing at that address.");
  return found;
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

/** The absolute path of a file under .generated. A path that is already absolute is returned as it is. */
export const file = (relative: string) => path.resolve(generated, relative);
