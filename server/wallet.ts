// Where a company's own server keeps each person's identity: their certificate, and their private
// key locked with AES-256-GCM.
//
// The key that locks them is made when the server is first set up and lives in a different volume
// from the wallet, so a copy of the wallet alone gives nobody a usable key. The server itself can
// still unlock every key: it signs on people's behalf, the way a company's mail server sends on
// theirs. Keeping keys in a hardware module, or on people's own devices, is a later step.
import { createCipheriv, createDecipheriv, createPrivateKey, randomBytes, type KeyObject } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ChatError, dataDir, nodeDir } from "./config";

let lock: Buffer | null = null;

function lockKey(): Buffer {
  if (!lock) {
    const hex = readFileSync(path.join(nodeDir, "wallet.key"), "utf8").trim();
    if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error("wallet.key is not a 256-bit key.");
    lock = Buffer.from(hex, "hex");
  }
  return lock;
}

const folder = (handle: string) => path.join(dataDir, "wallet", handle);

export function hasIdentity(handle: string): boolean {
  return existsSync(path.join(folder(handle), "cert.pem")) && existsSync(path.join(folder(handle), "key.enc"));
}

/** Keeps a person's certificate and key. The key is never written to disk unlocked. */
export function sealIdentity(handle: string, certPem: string, keyPem: string): void {
  const dir = folder(handle);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", lockKey(), iv);
  // Tying the handle in means one person's locked key cannot be swapped for another's.
  cipher.setAAD(Buffer.from(handle));
  const data = Buffer.concat([cipher.update(keyPem, "utf8"), cipher.final()]);
  const sealed = { v: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
  writeFileSync(path.join(dir, "key.enc.new"), JSON.stringify(sealed) + "\n", { mode: 0o600 });
  renameSync(path.join(dir, "key.enc.new"), path.join(dir, "key.enc"));
  writeFileSync(path.join(dir, "cert.pem"), certPem, { mode: 0o600 });
}

export function openIdentity(handle: string): { certPem: string; key: KeyObject } {
  if (!hasIdentity(handle)) throw new ChatError(401, "NO_IDENTITY", `${handle} has no certificate on this server.`);
  const dir = folder(handle);
  const sealed = JSON.parse(readFileSync(path.join(dir, "key.enc"), "utf8")) as { iv: string; tag: string; data: string };
  const decipher = createDecipheriv("aes-256-gcm", lockKey(), Buffer.from(sealed.iv, "base64"));
  decipher.setAAD(Buffer.from(handle));
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
  const keyPem = Buffer.concat([decipher.update(Buffer.from(sealed.data, "base64")), decipher.final()]);
  return { certPem: readFileSync(path.join(dir, "cert.pem"), "utf8"), key: createPrivateKey(keyPem) };
}
