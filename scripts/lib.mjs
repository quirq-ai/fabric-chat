// Shared by the end-to-end checks that launch throwaway companies from node-template.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const { version } = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
export const images = process.env.FABRIC_CHAT_IMAGES || "fabric-chat";
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const tokenOf = (link) => new URL(link).searchParams.get("invite");
/** Which template the chat script is, as it tells the images. */
export const template = /^TEMPLATE=(\d+)$/m.exec(fs.readFileSync(path.join(root, "node-template", "chat"), "utf8"))[1];

export function docker(args, options = {}) {
  const result = spawnSync("docker", args, { encoding: "utf8", cwd: options.cwd, input: options.input, maxBuffer: 32 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`docker ${args.slice(0, 4).join(" ")} failed:\n${(result.stderr || result.stdout).trim().split("\n").slice(-12).join("\n")}`);
  }
  return result.stdout;
}

/** Counts checks, and prints each as it is made. */
export function checker() {
  let passed = 0;
  const failed = [];
  return {
    check(name, ok, detail = "") {
      if (ok) {
        passed++;
        console.log(`  ok    ${name}`);
      } else {
        failed.push(name);
        console.log(`  FAIL  ${name}${detail ? `  (${detail})` : ""}`);
      }
    },
    section: (title) => console.log(`\n${title}`),
    get passed() {
      return passed;
    },
    failed,
  };
}

/** One browser: it keeps its own session cookie, as a person's browser would. */
export class Browser {
  cookie = "";
  setCookie = "";

  constructor(base) {
    this.base = base;
  }

  async call(method, pathname, body, headers = {}) {
    const response = await fetch(this.base + pathname, {
      method,
      headers: { ...(this.cookie ? { cookie: this.cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const set of response.headers.getSetCookie()) {
      const pair = set.split(";")[0];
      if (!pair.startsWith("chat_session=")) continue;
      this.setCookie = set;
      this.cookie = pair === "chat_session=" ? "" : pair;
    }
    const text = await response.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      // A page, not JSON.
    }
    return { status: response.status, data, headers: response.headers, code: data?.error?.code ?? "", message: data?.error?.message ?? "" };
  }
  get = (pathname, headers) => this.call("GET", pathname, undefined, headers);
  post = (pathname, body = {}, headers) => this.call("POST", pathname, body, headers);
  patch = (pathname, body) => this.call("PATCH", pathname, body);
  del = (pathname) => this.call("DELETE", pathname);
}

/** A throwaway company in a folder of its own, started the way ./chat up starts one. */
export class Company {
  constructor({ name, id, port, color, admin, dockerNetwork, ...more }) {
    this.id = id;
    this.name = name;
    this.base = `http://localhost:${port}`;
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), `fabric-chat-${id.split(".")[0]}-`));
    this.settings = {
      name,
      id,
      color,
      hosts: { chat: `chat.${id}`, peer: `peer.${id}`, orderer: `orderer.${id}` },
      admin,
      listen: { address: "127.0.0.1", port },
      ...(dockerNetwork ? { dockerNetwork } : {}),
      images,
      release: version,
      ...more,
    };
  }

  compose(args, options = {}) {
    return docker(["compose", ...args], { cwd: this.dir, ...options });
  }

  /** The steps ./chat up takes, in the same order, without needing a shell. */
  bringUp() {
    // Run attached, and the finished container kept, as ./chat does.
    const step = (name) => this.compose(["up", "--no-deps", "--no-log-prefix", "--exit-code-from", name, name]);
    step("prepare");
    this.compose(["up", "-d", "--no-deps", "ca", "couchdb"]);
    step("init");
    this.compose(["up", "-d", "--no-deps", "peer", "orderer", "chaincode"]);
    step("setup");
    this.compose(["up", "-d", "--no-deps", "agent", "app"]);
    if ((this.settings.https ?? "off") !== "off") this.compose(["up", "-d", "--no-deps", "proxy"]);
  }

  launch() {
    for (const name of ["compose.yaml", "chat"]) fs.copyFileSync(path.join(root, "node-template", name), path.join(this.dir, name));
    fs.writeFileSync(path.join(this.dir, "company.json"), JSON.stringify(this.settings, null, 2) + "\n");
    // The two files ./chat writes from company.json: the settings, and what the server opens to the outside.
    fs.writeFileSync(path.join(this.dir, ".env"), docker(["run", "--rm", "-i", "-e", `CHAT_TEMPLATE=${template}`, `${images}-ctl:${version}`, "env"], { input: JSON.stringify(this.settings) }));
    fs.writeFileSync(path.join(this.dir, "compose.generated.yaml"), docker(["run", "--rm", "-i", `${images}-ctl:${version}`, "compose"], { input: JSON.stringify(this.settings) }));
    // Made once for all the companies of a check. Asking again when it exists does no harm.
    if (this.settings.dockerNetwork) docker(["network", "create", this.settings.dockerNetwork], { allowFailure: true });
    this.bringUp();
    this.welcome = this.operator("welcome");
    return this;
  }

  /** What ./chat prints through the app's own door: the first administrator's link, or a new one. */
  operator(...args) {
    return this.compose(["exec", "-T", "app", "node", "build/operator.mjs", ...args]);
  }

  get firstLink() {
    return /(https?:\/\/\S+\?invite=\S+)/.exec(this.welcome)?.[1] ?? "";
  }

  async answering() {
    for (let i = 0; i < 90; i++) {
      try {
        if ((await fetch(`${this.base}/api/health`)).ok) return;
      } catch {
        // Not listening yet.
      }
      await sleep(1000);
    }
    throw new Error(`${this.name}'s app did not start answering.`);
  }

  /** The first administrator opens their link and chooses a password. Returns their browser. */
  async firstAdmin(password) {
    await this.answering();
    const browser = new Browser(this.base);
    const accepted = await browser.post(`/api/invites/${tokenOf(this.firstLink)}`, { password });
    if (accepted.status !== 200) throw new Error(`${this.name}'s first administrator could not sign in: ${accepted.message}`);
    return browser;
  }

  remove() {
    this.compose(["down", "--volumes", "--remove-orphans"], { allowFailure: true });
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}
