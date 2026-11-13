# Fabric Chat

A Slack-style team chat where the database is a Hyperledger Fabric 2.5 ledger. It runs in two ways:

- **The sandbox.** Three made-up companies each run their own nodes on one laptop, and every message is a transaction on the ledger they share. It was built to explain Fabric: every message can be followed through the network, and the app shows which companies' nodes hold its text. Everything in it is test data.
- **A company's own server.** The same app for one real company: its own keys, its own certificate authority, real sign-in, and workspaces it shares with other companies that run their own. See [A company on its own server](#a-company-on-its-own-server).

Most of this page is about the sandbox.

![The chat with the ledger panel open](docs/screens/chat.png)

## Run it

You need Docker Desktop (with the WSL 2 backend on Windows) and Node 22.13 or newer. Nothing else: no Go, and no Fabric tools on the machine. Everything that needs them runs in containers.

```bash
npm install
```

```bash
npm run net:up
```

```bash
npm run dev
```

Then open http://localhost:4700 and choose who you are.

`net:up` takes under a minute once the images are downloaded (about 1.7 GB the first time). It starts 16 containers, creates two channels, deploys the chaincode, enrols six people and writes a few conversations.

| Command | What it does |
| --- | --- |
| `npm run net:status` | Which containers run, and how many blocks each company's peer holds |
| `npm run net:stop` / `net:start` | Pause and resume, keeping the ledgers |
| `npm run net:down` | Remove everything: containers, ledgers, certificates |
| `npm run net:chaincode` | Rebuild and restart the chaincode after changing the Go code |
| `npm test` | The chaincode's unit tests, then an end-to-end check against the running network |
| `npm run images` | Build the three images a company's own server runs. With `-- --push <name>`, send them to a registry too |
| `npm run company -- "<name>" <id>` | Start one more company on this machine, in a folder of its own under `companies/` |
| `npm run test:company` | Launch a throwaway company from those images, run 86 checks against it, and remove it |
| `npm run test:companies` | Launch three throwaway companies, have them share workspaces through their own apps, and remove them |
| `npm run test:servers` | Two companies on two stand-in servers: images from a registry, HTTPS, a shared workspace, a backup and a restore. Needs five more images, which it names if they are missing |
| `npm run test:upgrade -- scripts/releases/0.2.0 0.2.0` | Move two throwaway companies that share a workspace from an older release to this one. It needs the older release's two files, kept in that folder, and its images on the machine |

`npm test` writes a few test channels to the ledger. A ledger cannot forget them, so run `npm run net:down` and `npm run net:up` afterwards if you want a clean one.

After `net:down` and `net:up`, stop `npm run dev` and start it again. The app server keeps the certificates in memory, and a rebuilt network has new ones.

## What each thing is on Fabric

| In the app | On Fabric |
| --- | --- |
| A company, such as Aster Labs | An organisation. It runs its own peer, its own orderer and its own certificate authority (CA). |
| A person, such as Alice | A certificate her company's CA signed, and the private key that goes with it. Every message she sends is signed with that key. |
| A workspace | A channel: one ledger, held by the companies on it and by nobody else. |
| An open #channel | Records in the channel's shared state. Every company on the channel stores them, and they appear in the blocks in the clear. |
| A private channel or direct message | Records in a private data collection. Only the companies it names store the text. Everyone else on the channel gets a hash. |
| Pressing Send | A transaction: endorsed by peers, ordered into a block, then checked and applied by every peer on the channel. |
| The rules: who may post, edit or join | Chaincode. The same program runs on every company's peer, and a change counts only if they reach the same result. |
| A message arriving | A block event. Each company's app watches the blocks its own peer commits. Nothing travels between companies except through the ledger. |
| A message's edit history | The blockchain itself. Each earlier version sits in an earlier block, and each block names the hash of the one before it. |

## The network

![Three companies, each with a CA, a peer and an orderer, and two channels](docs/network.svg)

- **Three companies**, each with one peer (and its CouchDB state database), one orderer, one CA and one copy of the chaincode.
- **Two channels.** `commons` is on all three peers. `dealroom` is on Aster's and Birch's peers only, and only their two orderers order it, because an orderer sees every transaction it orders.
- **Ordering is Raft**, one orderer per company. Two of the three must be running for `commons` to take a transaction.
- **The rule for a change** on a channel is "more than half of its companies must endorse it". No single company can write to the shared ledger alone.

All of it comes from [network.json](network.json). Add a company or a person there and run `npm run net:down` then `npm run net:up`.

## What happens when you press Send

![Sign, endorse, order, check and commit](docs/send.svg)

In the app, click the small "block" link under any message. The panel on the right shows these four steps for that message, with the real names: whose certificate signed it, which peers endorsed it, which block it is in, and what every peer decided about it.

## How private is a conversation?

Every conversation shows three dots: one per company in the workspace. A filled dot means that company's node stores the text. A hollow dot means it stores only hashes.

| Kind | Aster's peer | Birch's peer | Cedar's peer | Orderers | What an outside company still sees |
| --- | --- | --- | --- | --- | --- |
| Open channel, such as #general | text | text | text | text, in the block | Nothing is outside: all three are in it |
| Private, two companies, such as #pricing | text | text | hash only | hash only | That Alice wrote something, when, and in which collection |
| Private, one company, such as #aster-team | text | hash only | hash only | hash only | The same |
| A separate workspace, such as Deal room | text | text | nothing | text, but only Aster's and Birch's orderers | Nothing at all, not even that the channel exists |

![A private message: Cedar holds only its hash](docs/screens/private.png)

The app chooses the scope for you: the smallest one that covers the company of everyone in the conversation. Add someone from a third company and the conversation can no longer be private from that company.

Three things are worth knowing before promising anyone privacy on Fabric:

1. **Privacy is between companies, not between people.** Whoever runs a company's peer can read everything that peer stores. The chaincode stops Arjun from reading a conversation Alice did not add him to, but Aster's administrator could open the database. Secrecy between colleagues would need the text to be encrypted before it is sent.
2. **A hash proves, but also leaks a little.** Cedar cannot read an Aster and Birch message, yet it holds the hash that proves what was said, which settles any later dispute between the two. It also sees who sent each private transaction and when.
3. **"Members only" is not "private" when all companies are involved.** A members-only channel with people from all three companies is kept in the shared state, in the clear. The app marks such channels with a warning.

This is the same #pricing message as Carol of Cedar Works can see it. Her peer received the transaction in a block like everyone else's: she can see that Alice sent something, and when, and hashes where the text would be.

![What an outside company sees of a private message](docs/screens/outsider.png)

The app tells you where a conversation will be kept before you create it:

![Choosing people changes where the channel is kept](docs/screens/new-channel.png)

## Ten minutes with it

![Alice, Bob and Carol side by side](docs/screens/side-by-side.png)

1. **Open three people side by side.** The button is on the first screen. Send a message as Alice in #general and watch it reach Bob and Carol about a second later.
2. **Follow a message.** Click the "block" link under it. Read the four steps, then scroll down to "What the block records".
3. **Go private.** As Alice, post in #pricing. Bob receives it. Carol has no #pricing at all, but her ledger panel shows a transaction marked "Aster Labs and Birch & Co". Click it as Carol: she sees who sent it and when, and hashes where the text would be.
4. **Edit, then delete.** In #general, the old versions stay under "Every version, still on the ledger". In #pricing, delete purges the text from both peers. Only the hashes in the old blocks remain.
5. **Start a channel.** Tick people from different companies and watch "Kept by" change before you create it.
6. **Add a person.** On the first screen, "Add a person" asks that company's CA to sign a new certificate. The new person can post at once.
7. **Take a node away.** In the ledger panel, under Network, stop Cedar's peer and post in #general: it still commits, because two of three companies can endorse. Start it again and its block count catches up. Stop Birch's peer and post in #pricing: refused, because both companies that keep it must endorse. Stop one orderer and posts still commit: if it was the one leading, the next post takes up to ten seconds while the other two choose a new leader. Stop two orderers and nothing commits.

   ![The Network tab: every node, and whether the peers agree](docs/screens/network.png)
8. **Switch to the Deal room** (the "De" tile). Under Network, Cedar is listed as holding nothing.
9. **Look inside each company's database.** Open http://localhost:45984/_utils (Aster), http://localhost:45985/_utils (Birch) and http://localhost:45986/_utils (Cedar). The user is `admin` and the password is in `.generated/secrets.json`. Aster has a database named `commons_chat$$p$aster$m$s$p-$birch$m$s$p` holding the private messages. Cedar has only `commons_chat$$h…`, the hashes, and no `dealroom` databases at all.

## A company on its own server

The sandbox runs every company on one machine and asks for no passwords. The plan is for each company to run its own copy on its own server, add its own people, and connect to other companies when it chooses to. [docs/many-companies.md](docs/many-companies.md) is a short guide to that plan, in five steps. The first three are built: a company can launch on its own with real sign-in, two or more such companies can share a workspace, and they can do it from separate servers, over HTTPS, with backups. That last step has run on a stand-in for two servers, not yet on two real ones.

![The sign-in page of a company's own server](docs/screens/company-sign-in.png)

Build the three images once:

```bash
npm run images
```

Then start a company from the template folder. `./chat` needs only Docker. On Windows run it in Git Bash, as `sh chat up`.

```bash
cd node-template
```

```bash
./chat up
```

The first start takes about 25 seconds. It makes the company's root key on that machine, has the company's own certificate authority issue a certificate to each node, creates a home workspace that only this company is on, and prints a one-time link for the first administrator. She opens it, chooses a password, and adds everyone else from the People button. Each person gets a link of their own and chooses their own password.

![The first administrator and a colleague in #general, with the company's own ledger beside them](docs/screens/company-chat.png)

| | The sandbox | A company's own server |
| --- | --- | --- |
| Companies | Three, on one machine | One |
| Started with | `npm run net:up`, then `npm run dev` | `./chat up` |
| Needs | Docker and Node | Docker |
| Signing in | Choose a person | A handle and a password. An administrator adds people |
| A company's ID | `AsterMSP` | A domain name it owns, such as `aster.example`. People read like email addresses: `alice@aster.example` |
| Certificates | Made by Fabric's test tool, `cryptogen` | Issued by the company's own certificate authority, under a root key made on its server |
| People's keys | Plain files | Locked on disk. The key that locks them is kept in a different volume |
| Other companies | In one network from the start | Each on its own. Two or more share a workspace by swapping cards and accepting an invitation |

The template is three files: [company.json](node-template/company.json), the [chat](node-template/chat) command and [compose.yaml](node-template/compose.yaml). The [template's README](node-template/README.md) is the runbook: every setting, every command, and what is kept where. The same files are published by themselves as the template repository [fabric-chat-node](https://github.com/quirq-ai/fabric-chat-node).

### Two companies share a workspace

![An administrator starts a shared workspace from another company's card](docs/screens/companies-start.png)

An administrator opens **Other companies** and does three things with the other company's administrator. Nothing secret changes hands.

1. **They swap cards.** A card is a company's public face: its name, its root certificate and where its nodes are.
2. **One starts a workspace** from the other's card, and sends back an invitation: the new ledger's first block, with both cards.
3. **The other accepts.** Its node first works out what the block should say for those cards, and joins only if the block says exactly that.

The two nodes then agree on the rules by themselves, and the workspace appears for everyone at both companies. Each company's people talk through their own company's node, and every message in an open channel is endorsed by both.

![People of two companies in one workspace, each through their own company's node](docs/screens/companies-chat.png)

To try it on one machine, start two companies:

```bash
npm run company -- "Aster Labs" aster.example
```

```bash
npm run company -- "Dune Freight" dune.example
```

Each command makes a folder for the company under `companies/`, starts it on the next free port, and prints its first administrator's link. Every company started this way joins one Docker network, which stands in for the internet between them: it is the `dockerNetwork` setting in each `company.json`. `npm run test:companies` does the same with three throwaway companies, and checks the result.

### On a real server

Two lines in `company.json` put a company on the internet, once its three names point at the server:

```json
  "https": "auto",
  "node": { "address": "0.0.0.0" },
```

- **HTTPS comes by itself.** A small proxy on the server asks Let's Encrypt for a certificate for the chat's name, and renews it.
- **The node opens three ports** for other companies' servers: 7051, 7050 and 7055. Nothing else is opened, and `./chat status` says what is.
- **The app says whether it can reach another company's node** as soon as an administrator pastes that company's card, and whether what answers there really is that company's.
- **`./chat backup`** puts everything a company has into one file, locked with a passphrase. **`./chat restore`** brings the company back on an empty server.
- **The images come from a registry.** `npm run images -- --push <name>` sends a release there, and `./chat up` downloads it.

`npm run test:servers` proves all of it on one computer. Each company's server is a container running a Docker of its own, at its own address. Around them are a name server, a registry and Pebble, the test server Let's Encrypt publishes. The two servers share nothing but that network. The check launches a company on each, connects them, switches one off and on, and then destroys one and restores it on an empty server from its backup: 59 checks in about six minutes.

What it does not do yet: run on two real servers, which is the one thing left of this step. Removing a person. Adding a company to a workspace, or leaving one. And the images are not on a public registry, so today a company builds them or gets them from a registry of yours.

## How it is built

```
chaincode/chat/       the chat's rules, in Go. The same for the sandbox and for a company's own server
server/               the app server: Fabric Gateway client, block decoder, HTTP API, sign-in
web/                  the pages: React
docs/                 the figures on this page, and the guide to many companies

The sandbox
network.json          the three companies, their people and their workspaces
network/              turns network.json into a running Fabric network
  generate.mjs        writes the certificate, channel and Docker Compose files into .generated/
  net.mjs             up, down, status, stop, start: it only calls Docker
  scripts/            what runs inside the containers: channels, chaincode, enrolment

A company's own server
node-template/        what a company copies: company.json, the chat command, compose.yaml
ctl/                  the admin tool its server runs: certificates, first blocks, the rules, and the agent that
                      shares a workspace with another company when the app asks
companies/            companies started on this machine, each in a folder of its own. Git ignores it
Dockerfile            the image of the app
scripts/              images.mjs builds the three images; company-check.mjs and companies-check.mjs test
                      one company, and three sharing workspaces, end to end
```

### The chaincode

One contract, `chat`, in [chaincode/chat](chaincode/chat). Every function that writes takes a scope and one JSON document, and refuses with a coded error such as `CHAT_NOT_MEMBER`.

| Function | What it does |
| --- | --- |
| `Join`, `Directory`, `Whoami` | The workspace's directory of people. An ID such as `alice@AsterMSP`, or `alice@aster.example` on a company's own server, is read from the caller's certificate, never from an argument. |
| `CreateConversation`, `AddMembers`, `Overview` | Channels and direct messages. Everyone in a conversation must work at a company that keeps its scope. |
| `Post`, `Messages`, `Edit`, `Delete`, `React` | Messages. Only the author may edit or delete. Delete blanks a public message and purges a private one. |
| `History` | Every version a public message has had. |
| `Inspect` | What the peer running it holds for one key: the record, or only its hash. This is what "Who holds this message" asks each company's peer. |

Records are kept under readable keys: `profile~alice@AsterMSP`, `conv~general`, `msg~general~1794489506634-ee38f29a`, `react~general~<message>~tada~bob@BirchMSP`.

### The app server

[server/fabric.ts](server/fabric.ts) talks to Fabric through the Gateway service each 2.5 peer runs. A read asks the person's own company's peer. A write goes through `endorse`, `submit` and `getStatus`, and the time each took is shown under the message.

[server/ledger.ts](server/ledger.ts) follows each peer's blocks from block 0, and [server/decode.ts](server/decode.ts) unpacks them: the signer, the endorsers, the reads and writes, the validation result. The ledger panel is drawn from that, and so is the live update of the chat.

On a company's own server the same code runs with five more files. [server/company.ts](server/company.ts) is sign-in, invitations and what an administrator can do. [server/accounts.ts](server/accounts.ts) keeps accounts and sessions: passwords as scrypt hashes, and links and cookies as hashes too. [server/wallet.ts](server/wallet.ts) locks each person's key with AES-256-GCM. [server/ca.ts](server/ca.ts) asks the company's certificate authority for a new person's certificate. [server/desk.ts](server/desk.ts) passes an administrator's request to share a workspace on to the node's agent, which holds the key that takes. Which way the app runs is decided once, in [server/config.ts](server/config.ts).

## From the test-network tutorial to this network

The Fabric tutorial at [Using the Fabric test network](https://hyperledger-fabric.readthedocs.io/en/release-2.5/test_network.html) does these steps one at a time with `network.sh`. Here `npm run net:up` does the same steps for three companies, and prints them as it goes.

| Tutorial | Here | The Fabric tool behind it |
| --- | --- | --- |
| Before you begin: install samples, binaries and images | Nothing to install: the tools run in the `fabric-tools` container | |
| `./network.sh up` | Steps 1, 2 and 4 | `cryptogen`, then `docker compose up` |
| `./network.sh createChannel` | Step 5, once per channel | `configtxgen` for the first block, `osnadmin channel join` for each orderer, `peer channel join` for each peer |
| `./network.sh deployCC` | Steps 3 and 6 | `peer lifecycle chaincode` `install`, `approveformyorg`, `commit` |
| "Interacting with the network" with the `peer` command | The app, through the Gateway | `@hyperledger/fabric-gateway` |
| "Bring up the network with Certificate Authorities" | Step 7: each company's CA enrols its people | `fabric-ca-client register` and `enroll` |

What is different from the tutorial's network: three companies instead of two, an orderer per company instead of one shared orderer, two channels with different members, private data collections, and the chaincode running as a service.

## If you have used Fabric 1.4

Much of what is written about Fabric describes version 1.4. These are the places where 2.5 works differently, and what this project does in each.

| | Fabric 1.4 | Fabric 2.5, as used here |
| --- | --- | --- |
| Starting a channel | An orderer system channel and a consortium first. Then a channel transaction, then an anchor-peer update per company. | No system channel. One first block per channel holds everything, anchor peers included. Each orderer is handed it with `osnadmin channel join`. |
| Deploying chaincode | `install`, then one company runs `instantiate` and sets the endorsement policy for everyone. | Each company installs and approves for itself. It is committed only once more than half have approved the same definition. |
| Running chaincode | The peer builds a Docker image and starts it, which needs the Docker socket inside the peer. | Chaincode as a service: an image built once, one container per company, and the peer connects to it. No Docker socket in the peer. |
| Sending a transaction | The app picks the endorsing peers, collects their answers and sends them to an orderer. | The app talks only to its own peer's Gateway, which finds the endorsers and the orderer itself. |
| Finding a transaction's block | A query to the peer afterwards, then decoding the block by hand. | The app follows block events and decodes them as they arrive. |
| Private data | Collections that every company must list up front. | The same, plus a collection per company that Fabric provides for free, and purge (new in 2.5). |
| Endorsement rule | One rule per chaincode. | A default for the channel, and a separate rule for each private collection. |
| Go chaincode library | `fabric/core/chaincode/shim` | `fabric-contract-api-go/v2` |

## Things this build taught

1. **CouchDB hands JSON back with its keys in alphabetical order.** A record written with keys in another order comes back as different bytes, so the hash of what a peer holds no longer equals the hash on the ledger. The chaincode writes every record with sorted keys ([ledger.go](chaincode/chat/ledger.go), `canonical`).
2. **Private details travel in the transient field, never as arguments.** Arguments are recorded in the block for every company. The chaincode refuses a private call that carries its details as an argument.
3. **A hash of a short message can be guessed.** Everyone on the channel sees the hash of each private record, and could hash "yes" and "no" to compare. Every private record carries a random salt.
4. **A private transaction may not search and write.** Fabric refuses a transaction that runs a range query on a collection and also writes to it. Reads of one key are fine. So a private delete is told which reactions to clear instead of looking them up.
5. **Avoid records that everyone updates.** Two transactions that read the same record and land in the same block cannot both win. A conversation's "last message" pointer is overwritten without being read, and each reaction is its own record, so people posting at the same moment never knock each other out.
6. **Events are public.** A chaincode event is part of the block. A private conversation's event says only that something happened in its collection.
7. **An orderer sees what it orders.** A channel that must be hidden from a company cannot use that company's orderer. `dealroom` is ordered by Aster's and Birch's orderers alone.
8. **Private IDs must not be guessable.** A private conversation's key is hashed on the shared ledger. If the key were built from its members' names, an outsider could test every pair. Private IDs come from the transaction ID.
9. **Orderers that start at different times need their own port.** When one company's orderer joins a new channel before the other's, its first link to the other is made without a certificate, and Fabric keeps using that link, so no leader is ever elected. In this demo every orderer starts together and it never shows. With `ports.cluster` set in `network.json`, orderers talk to each other on a second port that refuses a link without a certificate, and they simply try again until it works.

## The limits of the sandbox

A company's own server removes the first three of these for one company. Its own limits are listed in [the template's README](node-template/README.md).

- **One app server plays all three companies** and holds every person's private key. In a real deployment each company runs its own, and keys live in an HSM or on the person's device. "Who holds this message" works only because this one server can ask each company's peer as that company.
- **There are no passwords.** Choosing a person is the sign-in. The certificate behind it is real.
- **People's certificates come from each company's test CA**, which signs with the key `cryptogen` made. Fine for a test network and nothing else.
- **A message's time is the sender's clock.** Block order is the truth; the time shown is what the sender's app claimed.
- **The app server listens on this machine only** and refuses requests from other sites, because it holds keys and can stop the test network's containers.
- Left out: threads, files, search, paging through long conversations, leaving a conversation, and revoking a person's certificate.
