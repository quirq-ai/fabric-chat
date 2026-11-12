// People and their identities. On Fabric a person is not a row in a users table: they are a
// certificate their company's CA signed, plus the private key that goes with it.
//
// This demo keeps every person's key in .generated/wallets and signs on their behalf, the way a
// company's own app server would for its staff. A real deployment would keep keys in an HSM or on
// the person's device, and each company would run its own copy of this server.
import { X509Certificate, createPrivateKey, type KeyObject } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ChatError, file, network, orgByCode, owned, type OrgConfig } from "./config";

export interface Identity {
  /** The ID the chaincode derives from the certificate: its common name, then the company's MSP ID. */
  id: string;
  handle: string;
  org: OrgConfig;
  certPem: string;
  key: KeyObject;
}

const USER = /^([a-z0-9][a-z0-9._-]{0,31})@([A-Za-z0-9]{1,64})$/;
const cache = new Map<string, Identity>();

function load(id: string, handle: string, org: OrgConfig, certFile: string, keyFile: string): Identity {
  const identity: Identity = { id, handle, org, certPem: readFileSync(certFile, "utf8"), key: createPrivateKey(readFileSync(keyFile)) };
  cache.set(id, identity);
  return identity;
}

/** The identity of a person such as alice@AsterMSP, read from their company's wallet. */
export function identityOf(userId: string): Identity {
  const cached = cache.get(userId);
  if (cached) return cached;
  const match = USER.exec(userId);
  const org = match && network().orgs.find((o) => o.msp === match[2]);
  if (!match || !org) throw new ChatError(401, "NO_IDENTITY", "Choose who you are first.");
  const msp = file(path.join(org.wallet, match[1], "msp"));
  const certFile = path.join(msp, "signcerts", "cert.pem");
  const keyFile = path.join(msp, "keystore", "priv_sk");
  if (!existsSync(certFile) || !existsSync(keyFile)) {
    throw new ChatError(401, "NO_IDENTITY", `${userId} has no certificate from ${owned(org.name)} CA.`);
  }
  return load(userId, match[1], org, certFile, keyFile);
}

/**
 * The identity a company's app server uses for its own work: following new blocks and checking
 * what its peer holds. It is not a person and never posts.
 */
export function serviceIdentity(org: OrgConfig): Identity {
  const id = `service:${org.code}`;
  return cache.get(id) ?? load(id, "service", org, file(org.service.cert), file(org.service.key));
}

export interface Person {
  id: string;
  handle: string;
  org: string;
  name: string;
  title: string;
}

const display = (handle: string) => handle.charAt(0).toUpperCase() + handle.slice(1);

/** Everyone who holds a certificate, company by company, in the order the companies are listed. */
export function people(): Person[] {
  return network().orgs.flatMap((org) => {
    const wallet = file(org.wallet);
    if (!existsSync(wallet)) return [];
    const enrolled = readdirSync(wallet).filter((handle) => existsSync(path.join(wallet, handle, "msp", "signcerts", "cert.pem")));
    // The people named in network.json first, in that order, then anyone added later.
    const listed = org.people.map((p) => p.id);
    enrolled.sort((a, b) => (listed.indexOf(a) + 1 || 999) - (listed.indexOf(b) + 1 || 999) || a.localeCompare(b));
    return enrolled.map((handle) => {
      const known = org.people.find((p) => p.id === handle) ?? noted(org, handle);
      return { id: `${handle}@${org.msp}`, handle, org: org.code, name: known?.name ?? display(handle), title: known?.title ?? "" };
    });
  });
}

const noteFile = (org: OrgConfig, handle: string) => path.join(file(org.wallet), handle, "profile.json");

/** Keeps the name a person was added with, so the sign-in screen can show it before the ledger is asked. */
export function note(org: OrgConfig, handle: string, profile: { name: string; title: string }): void {
  writeFileSync(noteFile(org, handle), JSON.stringify(profile, null, 2) + "\n");
}

function noted(org: OrgConfig, handle: string): { name: string; title: string } | null {
  try {
    return JSON.parse(readFileSync(noteFile(org, handle), "utf8")) as { name: string; title: string };
  } catch {
    return null;
  }
}

/** Asks a company's CA to register and enrol a new person. Resolves to "enrolled" or "already enrolled". */
export function enrol(orgCode: string, handle: string): Promise<string> {
  const org = orgByCode(orgCode);
  if (!/^[a-z0-9][a-z0-9._-]{0,31}$/.test(handle)) {
    throw new ChatError(400, "BAD_INPUT", "A handle is lower-case letters, digits, dot, dash or underscore, at most 32 long.");
  }
  return new Promise((resolve, reject) => {
    execFile("docker", ["exec", org.ca, "bash", "/scripts/enrol.sh", handle], { timeout: 60_000, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        const text = String(stderr || "").trim().split("\n").pop() || error.message;
        const taken = /already registered/i.test(text);
        reject(new ChatError(taken ? 409 : 503, taken ? "HANDLE_TAKEN" : "CA_DOWN", taken ? `${owned(org.name)} CA already has someone called ${handle}.` : `${owned(org.name)} CA did not enrol ${handle}: ${text}`));
      } else resolve(String(stdout).trim());
    });
  });
}

export interface CertificateView {
  subject: Record<string, string>;
  issuer: Record<string, string>;
  serial: string;
  validFrom: string;
  validTo: string;
  fingerprint: string;
  keyType: string;
  pem: string;
}

/** Node prints a certificate name as one "KEY=value" per line. */
function nameParts(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) out[line.slice(0, at)] = out[line.slice(0, at)] ? `${out[line.slice(0, at)]}, ${line.slice(at + 1)}` : line.slice(at + 1);
  }
  return out;
}

/** The parts of a certificate worth showing a person. */
export function certificateOf(pem: string): CertificateView {
  const cert = new X509Certificate(pem);
  const curve = cert.publicKey.asymmetricKeyDetails?.namedCurve;
  return {
    subject: nameParts(cert.subject),
    issuer: nameParts(cert.issuer),
    serial: cert.serialNumber,
    validFrom: new Date(cert.validFrom).toISOString(),
    validTo: new Date(cert.validTo).toISOString(),
    fingerprint: cert.fingerprint256,
    keyType: curve ? `ECDSA ${curve}` : (cert.publicKey.asymmetricKeyType ?? "unknown"),
    pem,
  };
}

/** Who a certificate in a block belongs to: the company (MSP), the name and the role its CA signed. */
export interface Party {
  msp: string;
  name: string;
  role: string;
}

const partyCache = new Map<string, { name: string; role: string }>();

export function partyOf(msp: string, pem: string): Party {
  let hit = partyCache.get(pem);
  if (!hit) {
    try {
      const subject = nameParts(new X509Certificate(pem).subject);
      hit = { name: subject.CN ?? "unknown", role: (subject.OU ?? "").split(", ")[0] };
    } catch {
      hit = { name: "unreadable certificate", role: "" };
    }
    partyCache.set(pem, hit);
  }
  return { msp, ...hit };
}
