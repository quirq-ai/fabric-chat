// Backs up and restores everything one company's server holds. ./chat backup and ./chat restore
// run it for a few seconds, inside a container that sees every volume, while all else is stopped.
//
//   node build/backup.mjs make                    every volume into one locked file in /backups
//   node build/backup.mjs open <file> <company>   that file back into empty volumes
//   node build/backup.mjs show <file>             whose backup a file is, and when it was made
//
// The passphrase is the first line of standard input. It never appears in a command or a setting.
//
// A backup holds every key the company has: its root key, its nodes' keys and its people's. So the
// file is locked. The passphrase is stretched into a key with scrypt, and the contents are sealed
// with AES-256-GCM in pieces of 64 KiB. Each piece carries its number and whether it is the last,
// so a file that was cut short, reordered or changed anywhere is refused rather than half-restored.
import { spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";

const VOLUMES = process.env.BACKUP_VOLUMES ?? "/volumes";
const OUT = process.env.BACKUP_DIR ?? "/backups";
const MAGIC = Buffer.from("FABRIC-CHAT-BACKUP-1\n");
const PIECE = 64 * 1024;
const SCRYPT = { N: 32768, r: 8, p: 1 };

function fail(message) {
  console.error(message);
  process.exit(1);
}

/** The first line of standard input. */
async function passphrase() {
  let text = "";
  for await (const part of process.stdin) text += part;
  return text.split(/\r?\n/)[0];
}

const keyOf = (secret, salt, kdf) => scryptSync(secret, salt, 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * 1024 * 1024 });

/** Each piece is sealed under its own number. The last one says so, which is how a cut-off file is caught. */
function nonce(prefix, count, last) {
  const value = Buffer.alloc(12);
  prefix.copy(value, 0);
  value.writeUInt32BE(count, 7);
  value[11] = last ? 1 : 0;
  return value;
}

/** Seals a stream in pieces. A piece on disk is: one byte "last?", four bytes of length, the sealed bytes, a 16-byte tag. */
function seal(key, prefix, bound) {
  let held = Buffer.alloc(0);
  let count = 0;
  const piece = (plain, last) => {
    const cipher = createCipheriv("aes-256-gcm", key, nonce(prefix, count++, last));
    cipher.setAAD(bound);
    const sealed = Buffer.concat([cipher.update(plain), cipher.final()]);
    const head = Buffer.alloc(5);
    head[0] = last ? 1 : 0;
    head.writeUInt32BE(sealed.length, 1);
    return Buffer.concat([head, sealed, cipher.getAuthTag()]);
  };
  return new Transform({
    transform(chunk, _encoding, done) {
      held = Buffer.concat([held, chunk]);
      // The newest bytes are kept back: only at the end is it known which piece is the last.
      while (held.length > PIECE) {
        this.push(piece(held.subarray(0, PIECE), false));
        held = held.subarray(PIECE);
      }
      done();
    },
    flush(done) {
      this.push(piece(held, true));
      done();
    },
  });
}

/** Opens what seal made. Nothing of a piece is passed on before the whole piece has been checked. */
function unseal(key, prefix, bound) {
  let held = Buffer.alloc(0);
  let count = 0;
  let finished = false;
  return new Transform({
    transform(chunk, _encoding, done) {
      held = Buffer.concat([held, chunk]);
      try {
        while (held.length >= 5) {
          const last = held[0] === 1;
          const length = held.readUInt32BE(1);
          if (length > PIECE) throw new Error("damaged");
          if (held.length < 5 + length + 16) break;
          if (finished) throw new Error("damaged");
          const decipher = createDecipheriv("aes-256-gcm", key, nonce(prefix, count, last));
          decipher.setAAD(bound);
          decipher.setAuthTag(held.subarray(5 + length, 5 + length + 16));
          let plain;
          try {
            plain = Buffer.concat([decipher.update(held.subarray(5, 5 + length)), decipher.final()]);
          } catch {
            throw new Error(count === 0 ? "passphrase" : "damaged");
          }
          count++;
          finished = last;
          held = held.subarray(5 + length + 16);
          this.push(plain);
        }
        done();
      } catch (err) {
        done(err);
      }
    },
    flush(done) {
      done(finished && held.length === 0 ? null : new Error("cut"));
    },
  });
}

/** Reads the part of a backup that anyone may read: whose it is and when it was made. */
function headerOf(file) {
  const fd = fs.openSync(file, "r");
  try {
    const start = Buffer.alloc(MAGIC.length + 4);
    fs.readSync(fd, start, 0, start.length, 0);
    if (!start.subarray(0, MAGIC.length).equals(MAGIC)) fail(`${path.basename(file)} is not a Fabric Chat backup.`);
    const length = start.readUInt32BE(MAGIC.length);
    if (length > 64 * 1024) fail(`${path.basename(file)} is damaged.`);
    const bytes = Buffer.alloc(length);
    fs.readSync(fd, bytes, 0, length, start.length);
    return { header: JSON.parse(bytes.toString("utf8")), offset: start.length + length, bound: createHash("sha256").update(start).update(bytes).digest() };
  } catch {
    return fail(`${path.basename(file)} is damaged.`);
  } finally {
    fs.closeSync(fd);
  }
}

const size = (bytes) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);
const said = (header) => `${header.company.name} (${header.company.id}), made on ${header.madeAt.slice(0, 16).replace("T", " at ")} UTC with release ${header.release}`;

/** Runs tar and settles when it has finished. Its complaints are kept, and shown only if it failed. */
function tar(args, stdio) {
  const child = spawn("tar", args, { stdio });
  let complaints = "";
  child.stderr.on("data", (part) => (complaints += part));
  const done = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`tar: ${complaints.trim().split("\n").slice(-3).join(" ") || `stopped with code ${code}`}`))));
  });
  return { child, done };
}

async function make() {
  const secret = await passphrase();
  if (secret.length < 12) fail("The passphrase must be at least 12 characters. Nothing was copied.");
  let node;
  try {
    node = JSON.parse(fs.readFileSync(path.join(VOLUMES, "app", "node.json"), "utf8"));
  } catch {
    fail("This server has not been started yet, so there is nothing to back up.");
  }
  const volumes = fs.readdirSync(VOLUMES).filter((name) => fs.statSync(path.join(VOLUMES, name)).isDirectory()).sort();
  const madeAt = new Date().toISOString();
  const salt = randomBytes(16);
  const prefix = randomBytes(7);
  const header = Buffer.from(
    JSON.stringify({ format: 1, company: node.company, release: node.release, madeAt, volumes, kdf: { name: "scrypt", ...SCRYPT, salt: salt.toString("base64") }, nonce: prefix.toString("base64") }),
  );
  const length = Buffer.alloc(4);
  length.writeUInt32BE(header.length);
  const start = Buffer.concat([MAGIC, length]);
  const bound = createHash("sha256").update(start).update(header).digest();

  const name = `${node.company.id}-${madeAt.slice(0, 19).replace(/[-:]/g, "").replace("T", "-")}.fcbackup`;
  const part = path.join(OUT, `.${name}.part`);
  fs.mkdirSync(OUT, { recursive: true });
  const out = fs.createWriteStream(part, { mode: 0o600 });
  out.write(start);
  out.write(header);
  // Owners and permissions are kept as numbers: the same files must belong to the same programs after a restore.
  const { child, done } = tar(["-C", VOLUMES, "--numeric-owner", "-cf", "-", ...volumes], ["ignore", "pipe", "pipe"]);
  try {
    await Promise.all([pipeline(child.stdout, zlib.createGzip({ level: 6 }), seal(keyOf(secret, salt, SCRYPT), prefix, bound), out), done]);
  } catch (err) {
    fs.rmSync(part, { force: true });
    fail(`The copy could not be made. ${err.message}`);
  }
  fs.renameSync(part, path.join(OUT, name));
  console.log(`Backup made: backups/${name} (${size(fs.statSync(path.join(OUT, name)).size)})`);
  console.log(`It holds ${volumes.length} volumes of ${node.company.name}: the ledger, every key, the accounts and the settings.`);
}

async function open(name, company) {
  if (!name || !company) fail("usage: backup.mjs open <file> <company id>");
  const file = path.join(OUT, path.basename(name));
  if (!fs.existsSync(file)) fail(`There is no file backups/${path.basename(name)}.`);
  const { header, offset, bound } = headerOf(file);
  console.log(`This is a backup of ${said(header)}.`);
  if (header.format !== 1) fail("It was made by a newer release than this one. Set \"release\" in company.json to that release or a later one.");
  if (header.company.id !== company) fail(`company.json is for ${company}. Use the company.json of ${header.company.id}: a server cannot change which company it is.`);
  for (const volume of header.volumes) {
    const dir = path.join(VOLUMES, volume);
    if (!fs.existsSync(dir)) fail(`This release has no "${volume}" volume. Restore with the release the backup was made with: ${header.release}.`);
    if (fs.readdirSync(dir).some((entry) => entry !== "lost+found")) fail(`This server already holds something in its "${volume}" volume. A backup is restored on an empty server.`);
  }
  const secret = await passphrase();
  const key = keyOf(secret, Buffer.from(header.kdf.salt, "base64"), header.kdf);
  const { child, done } = tar(["-C", VOLUMES, "--numeric-owner", "-xpf", "-"], ["pipe", "ignore", "pipe"]);
  try {
    await Promise.all([pipeline(fs.createReadStream(file, { start: offset }), unseal(key, Buffer.from(header.nonce, "base64"), bound), zlib.createGunzip(), child.stdin), done]);
  } catch (err) {
    child.kill();
    if (err.message === "passphrase") fail("That is not the passphrase this backup was locked with. If you are sure of it, the start of the file is damaged.");
    if (err.message === "cut") fail("The file is cut short: part of it is missing.");
    fail(`The file is damaged and could not be restored. ${err.message === "damaged" ? "" : err.message}`.trim());
  }
  console.log(`Restored ${header.volumes.length} volumes.`);
}

const [command, ...rest] = process.argv.slice(2);
if (command === "make") await make();
else if (command === "open") await open(...rest);
else if (command === "show" && rest[0]) console.log(`A backup of ${said(headerOf(path.join(OUT, path.basename(rest[0]))).header)}.`);
else fail("usage: backup.mjs make | open <file> <company id> | show <file>");
