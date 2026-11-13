// Adding a person on a company's own server: its certificate authority (CA) registers them and
// signs a certificate for a new key.
//
// The app does this with its own CA identity, people-registrar, which may register people and
// nothing else. It uses Fabric CA's command-line client, in a folder that lives in memory only, so
// the new private key touches no disk before the wallet has locked it.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChatError, company, nodeDir, owned } from "./config";

const scratch = () => process.env.CHAT_TMP ?? os.tmpdir();
const caCert = () => path.join(nodeDir, "ca-cert.pem");

let registrar = "";

/** The registrar's certificate and key, copied to where the client may also write its own settings. */
function registrarHome(): string {
  if (!registrar || !existsSync(registrar)) {
    registrar = mkdtempSync(path.join(scratch(), "registrar-"));
    cpSync(path.join(nodeDir, "registrar", "msp"), path.join(registrar, "msp"), { recursive: true });
  }
  return registrar;
}

function client(args: string[]): Promise<{ ok: boolean; text: string }> {
  return new Promise((resolve) => {
    execFile("fabric-ca-client", [...args, "--tls.certfiles", caCert()], { timeout: 60_000 }, (error, stdout, stderr) => {
      resolve({ ok: !error, text: `${stdout}\n${stderr}` });
    });
  });
}

const lastLine = (text: string) => text.trim().split("\n").pop() ?? "";

/** Registers a person with the company's CA and collects their certificate. Returns it with the new key. */
export async function enrolPerson(handle: string): Promise<{ certPem: string; keyPem: string }> {
  const { id, name, ca } = company();
  const host = ca.url.replace(/^https:\/\//, "");
  // A one-time password between the two steps. It is used once, here, and then forgotten.
  const secret = randomBytes(24).toString("hex");
  const home = registrarHome();

  const registered = await client(["register", "--id.name", handle, "--id.secret", secret, "--id.type", "client", "-u", ca.url, "--home", home]);
  if (!registered.ok) {
    if (!/already registered/i.test(registered.text)) {
      throw new ChatError(503, "CA_DOWN", `${owned(name)} certificate authority did not register ${handle}: ${lastLine(registered.text)}`);
    }
    // The CA knows the handle but this server holds no account for it: an earlier try stopped
    // half-way, or the app's data was lost. Give the registration a new one-time password.
    const reset = await client(["identity", "modify", handle, "--secret", secret, "-u", ca.url, "--home", home]);
    if (!reset.ok) throw new ChatError(409, "HANDLE_TAKEN", `${owned(name)} certificate authority already has an identity called ${handle}, and it is not a person's.`);
  }

  const work = mkdtempSync(path.join(scratch(), "enrol-"));
  try {
    const msp = path.join(work, "msp");
    const enrolled = await client(["enroll", "-u", `https://${handle}:${secret}@${host}`, "--home", work, "-M", msp, "--csr.names", `O=${id}`]);
    if (!enrolled.ok) throw new ChatError(503, "CA_DOWN", `${owned(name)} certificate authority did not sign a certificate for ${handle}: ${lastLine(enrolled.text)}`);
    const keys = readdirSync(path.join(msp, "keystore"));
    return {
      certPem: readFileSync(path.join(msp, "signcerts", "cert.pem"), "utf8"),
      keyPem: readFileSync(path.join(msp, "keystore", keys[0]), "utf8"),
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
