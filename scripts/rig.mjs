// A stand-in for the internet, for checks that need more than one server.
//
// Each "server" is a container that runs a Docker of its own, at an address of its own. Around them:
//
//   a name server   knows each company's three names, as public DNS would
//   a registry      holds the released images, as ghcr.io would
//   an authority    Pebble, Let's Encrypt's own test server, signs HTTPS certificates after
//                   checking that a server really answers to the name
//   a bystander     a machine that belongs to nobody, to see which ports are open
//
// The servers share nothing but that network. One reaches another only by name, and only through
// a port the other has opened.
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { root, sleep, version } from "./lib.mjs";

export const NET = "fabric-chat-rig";
const PREFIX = "10.77.0";
export const DNS = `${PREFIX}.2`;
export const REGISTRY = "registry.test:5000";
/** Where this machine sends images to the rig's registry. */
export const REGISTRY_HERE = "localhost:5077";
/** The certificate authority's name on the rig's network. A name with a dot: Docker does not look up one without. */
const AUTHORITY = "acme.test";
const AUTHORITY_PORT = 15077;
const IMAGES = { server: "docker:27-dind", dns: "coredns/coredns:1.11.3", registry: "registry:2", authority: "ghcr.io/letsencrypt/pebble:latest", bystander: "alpine:3.23" };
/** What every server needs besides the three Fabric Chat images. On a real server Docker downloads them. */
const { fabric } = JSON.parse(fs.readFileSync(path.join(root, "network.json"), "utf8"));
const BASE_IMAGES = [`hyperledger/fabric-peer:${fabric.version}`, `hyperledger/fabric-orderer:${fabric.version}`, `hyperledger/fabric-ca:${fabric.ca}`, `couchdb:${fabric.couchdb}`];

export function run(args, options = {}) {
  const result = spawnSync("docker", args, { encoding: "utf8", input: options.input, maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`docker ${args.slice(0, 5).join(" ")} failed:\n${(result.stderr || result.stdout).trim().split("\n").slice(-12).join("\n")}`);
  }
  return options.both ? `${result.stdout}${result.stderr}` : result.stdout;
}

/** Puts files into a container that has not been given a folder of this machine. */
function put(container, where, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-chat-rig-"));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  for (const name of Object.keys(files)) run(["cp", path.join(dir, name), `${container}:${where}/${name}`]);
  fs.rmSync(dir, { recursive: true, force: true });
}

export class Rig {
  /** @param servers one for each company: { name, id, address (last number), port (on this machine, for its chat) } */
  constructor(servers) {
    this.servers = servers.map((server) => ({ ...server, ip: `${PREFIX}.${server.address}`, container: `fc-${server.name}` }));
  }

  /** Removes everything a rig made, including what an interrupted run left behind. */
  remove() {
    const mine = run(["ps", "-aq", "--filter", `network=${NET}`], { allowFailure: true }).split("\n").filter(Boolean);
    const named = run(["ps", "-aq", "--filter", "name=^fc-"], { allowFailure: true }).split("\n").filter(Boolean);
    const all = [...new Set([...mine, ...named])];
    if (all.length) run(["rm", "-f", "-v", ...all], { allowFailure: true });
    run(["network", "rm", NET], { allowFailure: true });
  }

  /** The network, the name server, the registry, the certificate authority and the bystander. */
  start() {
    this.remove();
    for (const image of [...Object.values(IMAGES), ...BASE_IMAGES, `fabric-chat-ctl:${version}`]) {
      if (spawnSync("docker", ["image", "inspect", image], { encoding: "utf8" }).status !== 0) throw new Error(`The image ${image} is not on this machine. Get it with: ${image.startsWith("fabric-chat") ? "npm run images" : `docker pull ${image}`}`);
    }
    run(["network", "create", "--subnet", `${PREFIX}.0/24`, NET]);

    const names = this.servers.map((s) => `        ${s.ip} chat.${s.id} peer.${s.id} orderer.${s.id}`).join("\n");
    const corefile = `. {\n    hosts {\n${names}\n        ${PREFIX}.3 registry.test\n        ${PREFIX}.4 ${AUTHORITY}\n        fallthrough\n    }\n    forward . /etc/resolv.conf\n}\n`;
    run(["create", "--name", "fc-dns", "--network", NET, "--ip", DNS, IMAGES.dns, "-conf", "/Corefile"]);
    put("fc-dns", "", { Corefile: corefile });
    run(["start", "fc-dns"]);

    run(["run", "-d", "--name", "fc-registry", "--network", NET, "--network-alias", "registry.test", "--ip", `${PREFIX}.3`, "-p", `127.0.0.1:${REGISTRY_HERE.split(":")[1]}:5000`, IMAGES.registry]);

    // The authority answers under a name of its own, like any site, so it needs a certificate for
    // that name. A server is told to trust the root this one is signed under ("https.root").
    const made = JSON.parse(
      run(["run", "--rm", "--entrypoint", "sh", `fabric-chat-ctl:${version}`, "-c", [
        "cd /tmp",
        'openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout root.key -out root.pem -days 30 -subj "/CN=Rig test authority" -addext basicConstraints=critical,CA:TRUE 2>/dev/null',
        `openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout key.pem -out leaf.csr -subj "/CN=${AUTHORITY}" 2>/dev/null`,
        `printf 'subjectAltName=DNS:${AUTHORITY}\\nbasicConstraints=CA:FALSE\\n' >ext.cnf`,
        "openssl x509 -req -in leaf.csr -CA root.pem -CAkey root.key -CAcreateserial -out cert.pem -days 30 -extfile ext.cnf 2>/dev/null",
        "jq -n --rawfile root root.pem --rawfile cert cert.pem --rawfile key key.pem '{root: $root, cert: $cert, key: $key}'",
      ].join(" && ")]),
    );
    this.root = made.root;
    // Pebble checks a name the way Let's Encrypt does: it calls the server on port 80 or 443.
    const pebble = { pebble: { listenAddress: "0.0.0.0:14000", managementListenAddress: "0.0.0.0:15000", certificate: "/rig-cert.pem", privateKey: "/rig-key.pem", httpPort: 80, tlsPort: 443, ocspResponderURL: "", externalAccountBindingRequired: false, retryAfter: { authz: 3, order: 5 }, keyAlgorithm: "ecdsa" } };
    run(["create", "--name", "fc-authority", "--network", NET, "--ip", `${PREFIX}.4`, "-p", `127.0.0.1:${AUTHORITY_PORT}:15000`, "-e", "PEBBLE_VA_NOSLEEP=1", "-e", "PEBBLE_WFE_NONCEREJECT=0", IMAGES.authority, "-config", "/rig.json", "-dnsserver", `${DNS}:53`]);
    put("fc-authority", "", { "rig.json": JSON.stringify(pebble), "rig-cert.pem": made.cert, "rig-key.pem": made.key });
    run(["start", "fc-authority"]);

    run(["run", "-d", "--name", "fc-bystander", "--network", NET, "--ip", `${PREFIX}.5`, "--dns", DNS, IMAGES.bystander, "sleep", "86400"]);
  }

  /** What a company.json says to get its certificate from the rig's authority. On the internet it is the one word "auto". */
  https() {
    return { authority: `https://${AUTHORITY}:14000/dir`, root: this.root };
  }

  /** The root the authority signs chat certificates under. A browser would hold Let's Encrypt's in its place. */
  async issuingRoot() {
    for (let i = 0; i < 30; i++) {
      try {
        return await new Promise((resolve, reject) => {
          https.get({ host: "127.0.0.1", port: AUTHORITY_PORT, path: "/roots/0", rejectUnauthorized: false }, (response) => {
            let text = "";
            response.on("data", (part) => (text += part));
            response.on("end", () => (text.includes("BEGIN CERTIFICATE") ? resolve(text) : reject(new Error("no certificate"))));
          }).on("error", reject);
        });
      } catch {
        await sleep(1000);
      }
    }
    throw new Error("The certificate authority did not start.");
  }

  server(name) {
    return this.servers.find((server) => server.name === name);
  }

  /** A new, empty server: Docker and nothing else. */
  async startServer(name) {
    const server = this.server(name);
    run(["rm", "-f", "-v", server.container], { allowFailure: true });
    // The name server is given twice: to the server itself, whose Docker downloads images by name,
    // and to that Docker, which hands it on to the containers it runs.
    run(["run", "-d", "--privileged", "--name", server.container, "--hostname", name, "--network", NET, "--ip", server.ip, "--dns", DNS, "-p", `127.0.0.1:${server.port}:443`, "-e", "DOCKER_TLS_CERTDIR=", IMAGES.server, "dockerd", "--host=unix:///var/run/docker.sock", "--dns", DNS, "--insecure-registry", REGISTRY]);
    await this.dockerUp(name);
    // The Fabric and CouchDB images, which a real server downloads from Docker Hub.
    await new Promise((resolve, reject) => {
      const save = spawn("docker", ["save", ...BASE_IMAGES]);
      const load = spawn("docker", ["exec", "-i", server.container, "docker", "load"], { stdio: ["pipe", "ignore", "pipe"] });
      let complaints = "";
      load.stderr.on("data", (part) => (complaints += part));
      save.stdout.pipe(load.stdin);
      save.on("error", reject);
      load.on("error", reject);
      load.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`The images could not be put on ${name}: ${complaints.trim().slice(-300)}`))));
    });
    return server;
  }

  /** Waits until a server's own Docker answers. */
  async dockerUp(name) {
    for (let i = 0; i < 90; i++) {
      if (spawnSync("docker", ["exec", this.server(name).container, "docker", "info"], { encoding: "utf8" }).status === 0) return;
      await sleep(1000);
    }
    throw new Error(`Docker did not start on ${name}.`);
  }

  /** Runs a command on a server, in the company's folder. Returns what it printed, errors included. */
  on(name, command, options = {}) {
    const env = Object.entries(options.env ?? {}).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
    return run(["exec", ...(options.input === undefined ? [] : ["-i"]), ...env, "-w", options.cwd ?? "/srv/chat", this.server(name).container, "sh", "-c", command], { both: true, ...options });
  }

  /** Puts the template's files and a company.json on a server. Nothing else of this repository goes there. */
  install(name, settings) {
    const { container } = this.server(name);
    run(["exec", container, "mkdir", "-p", "/srv/chat"]);
    for (const file of ["chat", "compose.yaml"]) run(["cp", path.join(root, "node-template", file), `${container}:/srv/chat/${file}`]);
    put(container, "/srv/chat", { "company.json": JSON.stringify(settings, null, 2) + "\n" });
  }

  /** Whether a machine that belongs to nobody can open a connection to a name and port. */
  reaches(host, port) {
    return spawnSync("docker", ["exec", "fc-bystander", "sh", "-c", `nc -w 3 ${host} ${port} </dev/null`], { encoding: "utf8" }).status === 0;
  }

  /** What a machine that belongs to nobody gets from plain HTTP. */
  plainHttp(host) {
    return run(["exec", "fc-bystander", "sh", "-c", `printf 'GET / HTTP/1.0\\r\\nHost: ${host}\\r\\n\\r\\n' | nc -w 3 ${host} 80 | head -n 8`], { allowFailure: true });
  }
}

/** One person's browser, reaching a company's chat by its name, through the port this machine has for that server. */
export class Visitor {
  cookie = "";
  setCookie = "";

  constructor({ host, port, ca }) {
    Object.assign(this, { host, port, ca });
  }

  call(method, pathname, body) {
    return new Promise((resolve, reject) => {
      const request = https.request(
        {
          host: "127.0.0.1",
          port: this.port,
          servername: this.host,
          ca: this.ca,
          method,
          path: pathname,
          headers: { host: this.host, ...(this.cookie ? { cookie: this.cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json", origin: `https://${this.host}` }) },
        },
        (response) => {
          let text = "";
          response.on("data", (part) => (text += part));
          const certificate = response.socket.getPeerCertificate();
          response.on("end", () => {
            for (const set of response.headers["set-cookie"] ?? []) {
              const pair = set.split(";")[0];
              if (!pair.startsWith("chat_session=")) continue;
              this.setCookie = set;
              this.cookie = pair === "chat_session=" ? "" : pair;
            }
            let data = null;
            try {
              data = JSON.parse(text);
            } catch {
              // A page, not JSON.
            }
            resolve({ status: response.statusCode, data, text, headers: response.headers, certificate, code: data?.error?.code ?? "", message: data?.error?.message ?? "" });
          });
        },
      );
      request.on("error", reject);
      if (body !== undefined) request.write(JSON.stringify(body));
      request.end();
    });
  }
  get = (pathname) => this.call("GET", pathname);
  post = (pathname, body = {}) => this.call("POST", pathname, body);
  patch = (pathname, body) => this.call("PATCH", pathname, body);

  /** Tries until the chat answers: a server needs a moment to get its certificate. */
  async answering(seconds = 120) {
    const started = Date.now();
    let last = "";
    while (Date.now() - started < seconds * 1000) {
      try {
        const health = await this.get("/api/health");
        if (health.status === 200) return health;
        last = `answered ${health.status}`;
      } catch (err) {
        last = err.message;
      }
      await sleep(1500);
    }
    throw new Error(`${this.host} did not answer over HTTPS: ${last}`);
  }
}
