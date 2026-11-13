// The HTTP API the browser uses. Every route under /api/w/:ws acts as one person and goes to that
// person's own company's peer.
//
// In the sandbox there are no passwords: choosing a person on the first screen is the sign-in, and
// each request names that person in the x-chat-user header. On a company's own server a person
// signs in with a password, and each request is theirs because of its session cookie (company.ts).
// Either way, what stands behind it on Fabric is the same: each person has their own certificate
// and key, and every transaction is signed with it.
import { execFile } from "node:child_process";
import net from "node:net";
import express, { type Request, type Response, type Router } from "express";
import { ChatError, mode, network, orgByCode, owned, scopesOf, workspaceOf, type WorkspaceConfig } from "./config";
import * as chat from "./chat";
import { companyRoutes, joinNewWorkspaces, sessionAccount, sessionIdentity, shownTo } from "./company";
import { translate } from "./fabric";
import { feedOf } from "./ledger";
import { certificateOf, enrol, identityOf, note, people, type Identity } from "./people";

type Handler = (req: Request, res: Response) => unknown;

/** Runs a route and answers with JSON, or with {error: {code, message}} and a matching status. */
const route =
  (handler: Handler) =>
  async (req: Request, res: Response): Promise<void> => {
    try {
      const out = await handler(req, res);
      if (!res.headersSent) res.json(out ?? { ok: true });
    } catch (err) {
      const problem = translate(err);
      if (!res.headersSent) res.status(problem.status).json({ error: { code: problem.code, message: problem.message } });
    }
  };

/** The person a request acts as. On a company's own server the header is ignored: only the session counts. */
function who(req: Request): Identity {
  if (mode === "company") return sessionIdentity(req);
  return identityOf(String(req.get("x-chat-user") ?? ""));
}

/** The workspace in the address, as long as the person's company is on that channel. */
function workspaceFor(me: Identity, req: Request): WorkspaceConfig {
  const workspace = workspaceOf(String(req.params.ws));
  // A company that is not on a channel has no way to know it exists, so this is "not found", not "forbidden".
  if (!workspace.orgs.includes(me.org.code)) throw new ChatError(404, "NO_SUCH_WORKSPACE", `There is no workspace called ${req.params.ws}.`);
  return workspace;
}

const text = (value: unknown, name: string): string => {
  if (typeof value !== "string" || value.trim() === "") throw new ChatError(400, "BAD_INPUT", `${name} is required.`);
  return value;
};

const param = (req: Request, name: string) => String(req.params[name] ?? "");

/* ------------------------------------------------------------------ node status */

let containersAt = 0;
let containers: Record<string, string> = {};

/** Which of the network's containers are running, asked of Docker at most every two seconds. */
function containerStates(): Promise<Record<string, string>> {
  if (Date.now() - containersAt < 2000) return Promise.resolve(containers);
  return new Promise((resolve) => {
    execFile(
      "docker",
      ["ps", "--all", "--filter", `label=com.docker.compose.project=${network().name}`, "--format", "{{.Names}}\t{{.State}}"],
      { timeout: 10_000, windowsHide: true },
      (error, stdout) => {
        if (!error) {
          containers = Object.fromEntries(
            String(stdout)
              .trim()
              .split("\n")
              .filter(Boolean)
              .map((line) => line.split("\t") as [string, string]),
          );
          containersAt = Date.now();
        }
        resolve(containers);
      },
    );
  });
}

/** Whether something answers at an address. On a company's own server this is how the app sees its nodes. */
function reachable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1500, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

let probedAt = 0;
let probed: { kind: string; name: string; state: string }[] = [];

/** This company's five nodes, and whether each answers. Asked at most every two seconds. */
async function companyNodes(): Promise<typeof probed> {
  if (Date.now() - probedAt < 2000) return probed;
  const org = network().orgs[0];
  const nodes: [kind: string, name: string, port: number][] = [
    ["peer", org.peer.name, 7051],
    ["orderer", org.orderer, 7050],
    ["ca", org.ca, 7054],
    ["chaincode", org.chaincode, 9999],
    ["database", org.couchdb.name, 5984],
  ];
  probed = await Promise.all(nodes.map(async ([kind, name, port]) => ({ kind, name, state: (await reachable(name, port)) ? "running" : "not answering" })));
  probedAt = Date.now();
  return probed;
}

/** The containers a person may stop and start from the Network view: peers and orderers only. */
function controllable(): Set<string> {
  return new Set(network().orgs.flatMap((org) => [org.peer.name, org.orderer]));
}

function docker(action: "stop" | "start", name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("docker", [action, name], { timeout: 60_000, windowsHide: true }, (error) => {
      containersAt = 0;
      if (error) reject(new ChatError(503, "DOCKER_FAILED", `Docker could not ${action} ${name}.`));
      else resolve();
    });
  });
}

/* ------------------------------------------------------------------ routes */

export function api(): Router {
  const router = express.Router();
  // Large enough for an invitation, which carries a workspace's first block and its companies' cards.
  router.use(express.json({ limit: "512kb" }));

  // This server holds private keys. These two checks keep a web page from another site from using
  // it through someone's browser: it answers only under its own name, and it takes a change only
  // from its own pages.
  router.use((req, res, next) => {
    const host = String(req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
    const local = host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost");
    const own = local || (mode === "company" && host === network().company?.chatHost);
    const site = req.get("sec-fetch-site");
    const origin = req.get("origin");
    const foreign = (site && site !== "same-origin" && site !== "none") || (origin && URL.parse(origin)?.host !== req.headers.host);
    if (!own || (req.method !== "GET" && foreign)) {
      const where = mode === "company" ? "under its own name" : "on this machine";
      res.status(403).json({ error: { code: "FORBIDDEN", message: `This server answers only its own pages, ${where}.` } });
      return;
    }
    // Answers carry people's messages: nothing between the server and the browser may keep a copy.
    if (mode === "company") res.setHeader("Cache-Control", "no-store");
    next();
  });

  router.get(
    "/health",
    route(() => ({ ok: true, mode })),
  );

  if (mode === "company") {
    companyRoutes(router);
    // A person is put in a workspace's directory the first time they touch it. In a shared
    // workspace that takes the other companies' nodes, which may not be answering just then: so it
    // is tried again on every request until it has worked.
    router.use("/w/:ws", (req, _res, next) => {
      void joinNewWorkspaces(req).finally(next);
    });
  }

  /*
   * The whole network: who is in it and how it is laid out. The sandbox shows it before anyone
   * signs in. A company's own server shows a visitor its name and nothing else.
   */
  router.get(
    "/network",
    route((req) => {
      const net = network();
      const face = net.company ? { id: net.company.id, name: net.company.name, color: net.company.color } : undefined;
      if (mode === "company" && !sessionAccount(req)) {
        return { mode, locked: true, company: face, name: net.name, about: net.about, fabric: net.fabric, consensus: net.consensus, chaincode: net.chaincode, orgs: [], workspaces: [], people: [] };
      }
      return {
        mode,
        locked: false,
        company: face,
        name: net.name,
        about: net.about,
        fabric: net.fabric,
        consensus: net.consensus,
        chaincode: net.chaincode,
        orgs: net.orgs.map((o) => ({
          code: o.code,
          name: o.name,
          color: o.color,
          msp: o.msp,
          own: o.own,
          peer: o.peer.name,
          orderer: o.orderer,
          ca: o.ca,
          chaincode: o.chaincode,
          couchdb: o.couchdb.url,
        })),
        workspaces: net.workspaces.map((w) => ({ ...w, scopes: scopesOf(w) })),
        people: people(),
      };
    }),
  );

  /* How each company's peer is doing: how many blocks it holds on each channel, and which nodes run. */
  router.get(
    "/network/status",
    route(async (req) => {
      const net = network();
      if (mode === "company") who(req);
      // The sandbox asks Docker about every company's containers. A company's own server has no
      // say over Docker: it sees whether each of its own nodes answers.
      const states = mode === "company" ? {} : await containerStates();
      return {
        nodes:
          mode === "company"
            ? (await companyNodes()).map((node) => ({ org: net.orgs[0].code, ...node, controllable: false }))
            : net.orgs.flatMap((o) => [
                { org: o.code, kind: "peer", name: o.peer.name, state: states[o.peer.name] ?? "unknown", controllable: true },
                { org: o.code, kind: "orderer", name: o.orderer, state: states[o.orderer] ?? "unknown", controllable: true },
                { org: o.code, kind: "ca", name: o.ca, state: states[o.ca] ?? "unknown", controllable: false },
                { org: o.code, kind: "chaincode", name: o.chaincode, state: states[o.chaincode] ?? "unknown", controllable: false },
                { org: o.code, kind: "database", name: o.couchdb.name, state: states[o.couchdb.name] ?? "unknown", controllable: false },
              ]),
        ledgers: net.workspaces.flatMap((w) =>
          net.orgs.map((o) => {
            const feed = feedOf(o.code, w.channel);
            // Another company on this workspace holds its own copy, which only its own app can look at.
            if (!o.own && w.orgs.includes(o.code)) return { channel: w.channel, org: o.code, onChannel: true, height: 0, tip: "", state: "unseen", error: "" };
            return feed
              ? { channel: w.channel, org: o.code, onChannel: true, height: feed.height, tip: feed.tip, state: feed.state, error: feed.error }
              : { channel: w.channel, org: o.code, onChannel: false, height: 0, tip: "", state: "absent", error: "" };
          }),
        ),
      };
    }),
  );

  /* Stops or starts one peer or orderer, to see what the network does without it. */
  router.post(
    "/network/nodes/:name/:action",
    route(async (req) => {
      if (mode === "company") throw new ChatError(404, "NOT_FOUND", "There is nothing at that address.");
      who(req);
      const name = param(req, "name");
      const action = param(req, "action");
      if (!controllable().has(name)) throw new ChatError(404, "NO_SUCH_NODE", `${name} is not a peer or orderer of this network.`);
      if (action !== "stop" && action !== "start") throw new ChatError(400, "BAD_INPUT", "The action is stop or start.");
      await docker(action, name);
      return { name, action };
    }),
  );

  /* Adds a person: their company's CA signs them a certificate, then they join the company's workspaces. */
  router.post(
    "/people",
    route(async (req) => {
      // The sandbox lets anyone add a person. A company's own server leaves it to an administrator (company.ts).
      if (mode === "company") throw new ChatError(404, "NOT_FOUND", "There is nothing at that address.");
      const org = orgByCode(text(req.body?.org, "A company"));
      const handle = text(req.body?.handle, "A handle").trim().toLowerCase();
      const name = text(req.body?.name, "A name").trim();
      const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
      const outcome = await enrol(org.code, handle);
      // A handle belongs to whoever enrolled first. Otherwise anyone could rename an existing person.
      if (outcome !== "enrolled") throw new ChatError(409, "HANDLE_TAKEN", `${owned(org.name)} CA already has someone called ${handle}.`);
      const me = identityOf(`${handle}@${org.msp}`);
      note(org, handle, { name, title });
      const joined = [];
      for (const workspace of network().workspaces.filter((w) => w.orgs.includes(org.code))) {
        const done = await chat.join(me, workspace, { name, title });
        joined.push({ channel: workspace.channel, receipt: done.receipt });
      }
      return { person: { id: me.id, handle, org: org.code, name, title }, outcome, certificate: certificateOf(me.certPem), joined };
    }),
  );

  /* Who I am: my certificate, and the workspaces my company's peer is on. */
  router.get(
    "/me",
    route(async (req) => {
      const me = who(req);
      // A workspace shared since this person last looked: put them in its directory now.
      if (mode === "company") await joinNewWorkspaces(req);
      const onThem = network().workspaces.filter((w) => w.orgs.includes(me.org.code));
      const mine = mode === "company" ? shownTo(req, onThem) : onThem;
      return {
        id: me.id,
        handle: me.handle,
        org: me.org.code,
        msp: me.org.msp,
        // Only a company's own server has roles. In the sandbox everyone may do everything.
        role: mode === "company" ? (sessionAccount(req)?.role ?? "member") : null,
        certificate: certificateOf(me.certPem),
        workspaces: mine.map((w) => w.channel),
        // What the chaincode makes of the same certificate, asked of the ledger itself.
        asTheLedgerSeesMe: mine.length ? await chat.whoami(me, mine[0]).catch(() => null) : null,
      };
    }),
  );

  /* ---- one workspace ---- */

  router.get(
    "/w/:ws/overview",
    route((req) => {
      const me = who(req);
      return chat.overview(me, workspaceFor(me, req));
    }),
  );

  router.post(
    "/w/:ws/conversations",
    route((req) => {
      const me = who(req);
      const kind = req.body?.kind === "dm" ? "dm" : "channel";
      return chat.createConversation(me, workspaceFor(me, req), {
        kind,
        name: typeof req.body?.name === "string" ? req.body.name : "",
        topic: typeof req.body?.topic === "string" ? req.body.topic : "",
        members: Array.isArray(req.body?.members) ? req.body.members.map(String) : [],
        open: req.body?.open === true,
      });
    }),
  );

  router.post(
    "/w/:ws/conversations/:scope/:conv/members",
    route((req) => {
      const me = who(req);
      const members = Array.isArray(req.body?.members) ? req.body.members.map(String) : [];
      return chat.addMembers(me, workspaceFor(me, req), param(req, "scope"), param(req, "conv"), members);
    }),
  );

  router.get(
    "/w/:ws/conversations/:scope/:conv/messages",
    route((req) => {
      const me = who(req);
      return chat.messages(me, workspaceFor(me, req), param(req, "scope"), param(req, "conv"), typeof req.query.after === "string" ? req.query.after : "");
    }),
  );

  router.post(
    "/w/:ws/conversations/:scope/:conv/messages",
    route(async (req) => {
      const me = who(req);
      const done = await chat.post(me, workspaceFor(me, req), param(req, "scope"), param(req, "conv"), text(req.body?.text, "Some text"));
      return { message: { ...done.result, block: done.receipt.block }, receipt: done.receipt };
    }),
  );

  router.patch(
    "/w/:ws/conversations/:scope/:conv/messages/:msg",
    route(async (req) => {
      const me = who(req);
      const done = await chat.edit(me, workspaceFor(me, req), param(req, "scope"), param(req, "conv"), param(req, "msg"), text(req.body?.text, "Some text"));
      return { message: { ...done.result, block: done.receipt.block }, receipt: done.receipt };
    }),
  );

  router.delete(
    "/w/:ws/conversations/:scope/:conv/messages/:msg",
    route((req) => {
      const me = who(req);
      return chat.remove(me, workspaceFor(me, req), param(req, "scope"), param(req, "conv"), param(req, "msg"));
    }),
  );

  router.post(
    "/w/:ws/conversations/:scope/:conv/messages/:msg/reactions",
    route((req) => {
      const me = who(req);
      return chat.react(me, workspaceFor(me, req), param(req, "scope"), param(req, "conv"), param(req, "msg"), text(req.body?.emoji, "A reaction"), req.body?.on !== false);
    }),
  );

  router.get(
    "/w/:ws/conversations/:scope/:conv/messages/:msg/history",
    route((req) => {
      const me = who(req);
      if (param(req, "scope") !== "public") throw new ChatError(400, "NO_HISTORY", "Only the shared ledger keeps readable history. A private scope keeps hashes only.");
      return chat.history(me, workspaceFor(me, req), param(req, "conv"), param(req, "msg"));
    }),
  );

  /* What each company's peer holds for one message: the text, or only its hash. */
  router.get(
    "/w/:ws/conversations/:scope/:conv/messages/:msg/holdings",
    route(async (req) => {
      const me = who(req);
      const workspace = workspaceFor(me, req);
      // Asking is itself a read of the conversation, so the usual membership rule applies first.
      await chat.messages(me, workspace, param(req, "scope"), param(req, "conv"), param(req, "msg"));
      const key = chat.messageKey(param(req, "conv"), param(req, "msg"));
      return { key, holdings: await chat.holdings(workspace, param(req, "scope"), key) };
    }),
  );

  /* ---- the ledger itself, as my company's peer holds it ---- */

  router.get(
    "/w/:ws/blocks",
    route((req) => {
      const me = who(req);
      const feed = feedOf(me.org.code, workspaceFor(me, req).channel);
      if (!feed) return { height: 0, state: "absent", blocks: [] };
      const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 200);
      return { height: feed.height, state: feed.state, blocks: feed.blocks.slice(-limit) };
    }),
  );

  router.get(
    "/w/:ws/tx/:txId",
    route((req) => {
      const me = who(req);
      const feed = feedOf(me.org.code, workspaceFor(me, req).channel);
      const found = feed?.find(param(req, "txId"));
      if (!found) throw new ChatError(404, "NO_SUCH_TX", "Your company's peer has not committed a transaction with that ID.");
      const { block, tx } = found;
      return { block: { number: block.number, hash: block.hash, previousHash: block.previousHash, dataHash: block.dataHash, txCount: block.txs.length }, tx };
    }),
  );

  /* ---- live: every block my company's peer commits, as it commits it ---- */

  router.get("/stream", (req, res) => {
    let me: Identity;
    try {
      me = mode === "company" ? sessionIdentity(req) : identityOf(String(req.query.as ?? ""));
    } catch (err) {
      const problem = translate(err);
      res.status(problem.status).json({ error: { code: problem.code, message: problem.message } });
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    res.write("retry: 2000\n\n");

    // The workspaces this person's pages show. On a company's own server that is the ones they
    // are in the directory of, which for a newly shared workspace follows a few seconds after it is ready.
    const shown = () => {
      const onThem = network().workspaces.filter((w) => w.orgs.includes(me.org.code));
      return mode === "company" ? shownTo(req, onThem) : onThem;
    };
    const mine = shown();
    send("hello", { id: me.id, heights: Object.fromEntries(mine.map((w) => [w.channel, feedOf(me.org.code, w.channel)?.height ?? 0])) });
    const stops = mine.map((w) => feedOf(me.org.code, w.channel)?.on((block) => send("block", block)));
    const beat = setInterval(() => res.write(": still here\n\n"), 20_000);
    // A workspace can appear while someone is signed in. Their page is told, asks again who it is,
    // and opens this stream afresh, now following the new workspace's blocks too.
    let known = mine.map((w) => w.channel).join();
    const watch = setInterval(() => {
      const now = shown()
        .map((w) => w.channel)
        .join();
      if (now === known) return;
      known = now;
      send("workspaces", { channels: now.split(",") });
    }, 3000);
    req.on("close", () => {
      clearInterval(watch);
      clearInterval(beat);
      for (const stop of stops) stop?.();
    });
  });

  router.use((_req, res) => {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "There is nothing at that address." } });
  });

  return router;
}
