// Lab only. Connects two companies that were set up separately: Aster (in ./lab) and Dune (in ./dune).
// Each has its own folder, its own keys and its own Docker project. The only things that cross from
// one to the other are public: a "company card" each way, and the new channel's first block.
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const exchange = path.join(here, "exchange");
const channel = "aster-dune";
const tools = "hyperledger/fabric-tools:2.5.16";

const side = (dir, code) => {
  const net = JSON.parse(fs.readFileSync(path.join(here, dir, ".generated", "network.resolved.json"), "utf8"));
  const org = net.orgs.find((o) => o.code === code);
  return { dir: path.join(here, dir), gen: path.join(here, dir, ".generated"), cli: net.cli, net: net.name, org, domain: org.peer.name.replace(/^peer0\./, ""), ordererDomain: org.orderer.replace(/^orderer0\./, "") };
};
const aster = side("lab", "aster");
const dune = side("dune", "dune");

const step = (text) => console.log(`\n\x1b[1m${text}\x1b[0m`);
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
/** Runs a bash script inside one company's own tools container, where only that company's keys are. */
const inCli = (who, script) => {
  const out = spawnSync("docker", ["exec", who.cli, "bash", "-c", `source /scripts/lib.sh; cd /work; ${script}`], { encoding: "utf8" });
  if (out.status !== 0) throw new Error(`${who.org.name}: ${(out.stderr || out.stdout).trim().split("\n").slice(-4).join("\n")}`);
  return out.stdout.trim();
};
const talk = (who, handle, action, text = "") => {
  const out = spawnSync("node", ["node_modules/tsx/dist/cli.mjs", "server/pairtalk.ts", handle, channel, action, text], { cwd: who.dir, encoding: "utf8" });
  return (out.stdout + out.stderr).trim().split("\n").pop();
};
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const from = Number(process.argv[2] ?? 0);

/* 0. On the internet each company's peer and orderer would have a public name. In the lab, putting
      Dune's two nodes on Aster's Docker network gives the same effect: they can reach each other by name. */
step("0  Making the two companies' nodes reachable to each other");
if (from <= 0) for (const name of [dune.org.peer.name, dune.org.orderer]) {
  spawnSync("docker", ["network", "connect", aster.net, name], { encoding: "utf8" });
}
console.log(`${dune.org.peer.name} and ${dune.org.orderer} can now reach, and be reached by, Aster's nodes`);

/* 1. Each company writes its card: public certificates and addresses, nothing secret. */
if (from <= 3) {
step("1  Each company exports its card (public files only)");
fs.rmSync(exchange, { recursive: true, force: true });
for (const who of [aster, dune]) {
  const cc = path.join(who.gen, "crypto-config");
  const out = path.join(exchange, who.org.code);
  const publicMsp = (from, to) => {
    for (const part of ["cacerts", "tlscacerts"]) fs.cpSync(path.join(from, part), path.join(to, part), { recursive: true });
    fs.copyFileSync(path.join(from, "config.yaml"), path.join(to, "config.yaml"));
  };
  publicMsp(path.join(cc, "peerOrganizations", who.domain, "msp"), path.join(out, "msp"));
  publicMsp(path.join(cc, "ordererOrganizations", who.ordererDomain, "msp"), path.join(out, "orderer-msp"));
  fs.copyFileSync(path.join(cc, "ordererOrganizations", who.ordererDomain, "orderers", who.org.orderer, "tls", "server.crt"), path.join(out, "orderer-tls.crt"));
  fs.copyFileSync(path.join(cc, "peerOrganizations", who.domain, "peers", who.org.peer.name, "tls", "ca.crt"), path.join(out, "peer-tls-ca.crt"));
  fs.writeFileSync(path.join(out, "card.json"), JSON.stringify({ name: who.org.name, msp: who.org.msp, ordererMsp: who.org.ordererMsp, peer: `${who.org.peer.name}:7051`, orderer: `${who.org.orderer}:7050`, cluster: who.org.ordererCluster }, null, 2) + "\n");
}
const files = fs.readdirSync(exchange, { recursive: true }).filter((f) => fs.statSync(path.join(exchange, f)).isFile());
const secret = files.filter((f) => /priv_sk|\.key$|keystore/.test(f));
console.log(`${files.length} files exchanged, ${secret.length} of them private keys`);
if (secret.length) throw new Error("a private key was about to leave its company");

/* 2. One company (Aster) writes the new channel's first block from the two cards. */
step("2  Aster builds the channel's first block from the two cards");
const members = [aster, dune].map((who) => JSON.parse(fs.readFileSync(path.join(exchange, who.org.code, "card.json"), "utf8"))).map((card, i) => ({ ...card, code: [aster, dune][i].org.code }));
const implicit = (rule) => `{ Type: ImplicitMeta, Rule: "${rule}" }`;
const signed = (rule) => `{ Type: Signature, Rule: "${rule}" }`;
const configtx = [
  "Profiles:",
  `  ${channel}:`,
  "    Policies:",
  `      Readers: ${implicit("ANY Readers")}`,
  `      Writers: ${implicit("ANY Writers")}`,
  `      Admins: ${implicit("MAJORITY Admins")}`,
  "    Capabilities: { V2_0: true }",
  "    Orderer:",
  "      OrdererType: etcdraft",
  "      BatchTimeout: 1s",
  "      BatchSize: { MaxMessageCount: 50, AbsoluteMaxBytes: 10 MB, PreferredMaxBytes: 2 MB }",
  "      EtcdRaft:",
  "        Consenters:",
  ...members.flatMap((m) => [`          - Host: ${m.cluster.split(":")[0]}`, `            Port: ${m.cluster.split(":")[1]}`, `            ClientTLSCert: ${m.code}/orderer-tls.crt`, `            ServerTLSCert: ${m.code}/orderer-tls.crt`]),
  "      Organizations:",
  ...members.flatMap((m) => [
    `        - Name: ${m.ordererMsp.replace(/MSP$/, "")}`,
    `          ID: ${m.ordererMsp}`,
    `          MSPDir: ${m.code}/orderer-msp`,
    "          Policies:",
    `            Readers: ${signed(`OR('${m.ordererMsp}.member')`)}`,
    `            Writers: ${signed(`OR('${m.ordererMsp}.member')`)}`,
    `            Admins: ${signed(`OR('${m.ordererMsp}.admin')`)}`,
    "          OrdererEndpoints:",
    `            - ${m.orderer}`,
  ]),
  "      Policies:",
  `        Readers: ${implicit("ANY Readers")}`,
  `        Writers: ${implicit("ANY Writers")}`,
  `        Admins: ${implicit("MAJORITY Admins")}`,
  `        BlockValidation: ${implicit("ANY Writers")}`,
  "      Capabilities: { V2_0: true }",
  "    Application:",
  "      Organizations:",
  ...members.flatMap((m) => [
    `        - Name: ${m.msp.replace(/MSP$/, "")}`,
    `          ID: ${m.msp}`,
    `          MSPDir: ${m.code}/msp`,
    "          Policies:",
    `            Readers: ${signed(`OR('${m.msp}.admin', '${m.msp}.peer', '${m.msp}.client')`)}`,
    `            Writers: ${signed(`OR('${m.msp}.admin', '${m.msp}.client')`)}`,
    `            Admins: ${signed(`OR('${m.msp}.admin')`)}`,
    `            Endorsement: ${signed(`OR('${m.msp}.peer')`)}`,
    "          AnchorPeers:",
    `            - Host: ${m.peer.split(":")[0]}`,
    "              Port: 7051",
  ]),
  "      Policies:",
  `        Readers: ${implicit("ANY Readers")}`,
  `        Writers: ${implicit("ANY Writers")}`,
  `        Admins: ${implicit("MAJORITY Admins")}`,
  `        LifecycleEndorsement: ${implicit("MAJORITY Endorsement")}`,
  `        Endorsement: ${implicit("MAJORITY Endorsement")}`,
  "      Capabilities: { V2_5: true }",
  "",
].join("\n");
fs.writeFileSync(path.join(exchange, "configtx.yaml"), configtx);
// The tools container sees the exchange folder and nothing else: no company's private keys are in reach.
sh("docker", ["run", "--rm", "-v", `${exchange}:/x`, "-e", "FABRIC_CFG_PATH=/x", "-w", "/x", tools, "configtxgen", "-profile", channel, "-channelID", channel, "-outputBlock", `/x/${channel}.block`]);
console.log(`${channel}.block written: ${fs.statSync(path.join(exchange, `${channel}.block`)).size} bytes, members ${members.map((m) => m.msp).join(" and ")}`);

/* 3. The block and the other side's card go to each company. Each joins its own orderer and peer. */
step("3  Each company joins its own orderer and its own peer, using its own keys");
for (const who of [aster, dune]) {
  fs.cpSync(exchange, path.join(who.gen, "exchange"), { recursive: true });
  const code = who.org.code;
  console.log(
    inCli(
      who,
      `tls="$(orderer_tls ${code})"; out="$(osnadmin channel join --channelID ${channel} --config-block exchange/${channel}.block -o \${ORG_ORDERER[${code}]}:7053 --ca-file $tls/ca.crt --client-cert $tls/server.crt --client-key $tls/server.key 2>&1 || true)"; grep -q '^Status: 201' <<<"$out" && echo "${who.org.name}: orderer joined as $(grep -o '"consensusRelation": *"[a-z]*"' <<<"$out" | cut -d'"' -f4)"; use_org ${code}; peer channel join -b exchange/${channel}.block >/dev/null 2>&1 && echo "${who.org.name}: peer joined"`,
    ),
  );
}

}

/* 4. Both approve the same chaincode definition. It is committed only when both have. */
step("4  Both approve the same rules; then the channel is live");
const definition = `-C ${channel} -n chat -v 1.0 --sequence 1`;
for (const who of [aster, dune]) {
  console.log(inCli(who, `use_org ${who.org.code}; retry 20 peer lifecycle chaincode approveformyorg -o "$ORDERER_ENDPOINT" --tls --cafile "$ORDERER_CA" ${definition} --package-id "$(cat chaincode/package.id)" >/tmp/approve.log 2>&1 || { tail -3 /tmp/approve.log; exit 1; }; echo "${who.org.name}: approved"`));
}
console.log(
  inCli(
    aster,
    `use_org aster; retry 10 peer lifecycle chaincode commit -o "$ORDERER_ENDPOINT" --tls --cafile "$ORDERER_CA" ${definition} --peerAddresses ${aster.org.peer.name}:7051 --tlsRootCertFiles exchange/aster/peer-tls-ca.crt --peerAddresses ${dune.org.peer.name}:7051 --tlsRootCertFiles exchange/dune/peer-tls-ca.crt >/tmp/commit.log 2>&1 || { tail -3 /tmp/commit.log; exit 1; }; peer lifecycle chaincode querycommitted -C ${channel} -n chat 2>/dev/null | tail -1`,
  ),
);

/* 5. People at the two companies talk, each through their own company's peer. */
step("5  Alice (Aster) and Dana (Dune) talk");
fs.copyFileSync(path.join(here, "pairtalk.ts"), path.join(aster.dir, "server", "pairtalk.ts"));
fs.copyFileSync(path.join(here, "pairtalk.ts"), path.join(dune.dir, "server", "pairtalk.ts"));
console.log("alice:", talk(aster, "alice", "join"));
console.log("dana: ", talk(dune, "dana", "join"));
console.log("alice:", talk(aster, "alice", "create"));
console.log("alice:", talk(aster, "alice", "post", "Hello Dune. Our two companies were set up separately."));
sleep(1500);
console.log("dana reads on Dune's peer: ", talk(dune, "dana", "read"));
console.log("dana: ", talk(dune, "dana", "post", "Hello Aster. All we exchanged was a card each and one block."));
sleep(1500);
console.log("alice reads on Aster's peer:", talk(aster, "alice", "read"));

/* 6. Who is on the new channel, and who is not. */
step("6  Who has the new channel");
for (const [who, code] of [[aster, "aster"], [aster, "birch"], [aster, "cedar"], [dune, "dune"]]) {
  const list = inCli(who, `use_org ${code}; peer channel list 2>&1 | grep -vE 'INFO|Channels peers' | tr '\\n' ' '`);
  console.log(`${code.padEnd(6)} peer is on: ${list}`);
}
