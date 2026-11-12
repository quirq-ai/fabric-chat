# Fabric Chat for many companies: a simple guide

Today Fabric Chat runs three made-up companies on one laptop. This guide is about the next step: each company runs its own copy on its own server, adds its own people, and connects to other companies when it wants to talk to them.

![Each company runs its own chat app and node; workspaces are shared only by the companies in them](many-overview.svg)

## The idea

- **Each company runs one small server.** On it are the chat app its people sign in to, and a node: a certificate authority, a peer, an orderer and the chat's rules.
- **A company's own chat is a workspace only it is on.** Nobody else holds a copy, and it works whether or not anyone else's server is running.
- **Talking to another company means sharing a workspace with it.** A shared workspace is one ledger, held by exactly the companies in it. A company that is not in it cannot tell that it exists.
- **There is no central server and nobody to ask for permission.** Two companies connect by swapping public "cards" and agreeing on the same rules.

In Fabric's own words: a company is an organisation, a workspace is a channel, and the rules are chaincode. Fabric 2.5 has no network-wide object to join, only channels, which is why no operator is needed.

## What was tested for this guide

Each line below was run on 12 November 2026 in a throwaway copy of this project. The scripts are in [lab/](lab/).

| Claim | What was run | Result |
| --- | --- | --- |
| A company can launch alone | A `network.json` naming one company, Dune Freight, then `npm run net:up` | Up in 15 seconds: its own certificate authority, peer, orderer and rules, a home workspace and two people |
| Today's app already works as one company's chat | The app started against that one-company network | Dana created #general and posted; her colleague Dev read it |
| A home workspace needs nobody else | Every other company's peer and orderer stopped | Aster's own workspace kept taking messages. The shared one refused them until the others came back |
| Two companies set up separately can connect | Aster and Dune, each with its own folder, its own keys and its own Docker project | Connected in about 20 seconds. 18 public files and one block crossed between them, and no private key. Alice and Dana read each other's messages, each through their own company's node |
| A two-company workspace needs both companies | Birch's peer stopped, then its orderer | Posts were refused each time and went through again once the node was back |

Not run yet: two servers on different networks, over the internet. Adding a company to a shared workspace that already exists. Removing a person.

## What each company runs

| Part | What it is for | Who must be able to reach it |
| --- | --- | --- |
| Chat app | Where the company's people sign in and chat | The company's people, over HTTPS (port 443) |
| Certificate authority | Signs a certificate for each person and each node | Nobody outside the server |
| Peer | Holds the company's copy of each workspace and checks every block | Partner companies' nodes (port 7051) |
| Orderer | Takes part in putting messages in order | Partner companies' peers (port 7050) and orderers (port 7055) |
| The chat's rules | The same program at every company | Nobody outside the server |

- **Size.** In the lab one company's node used about 300 MB of memory when idle. A server with 2 CPUs, 4 GB of memory and 40 GB of disk is plenty to start.
- **Names.** Each company needs three names it controls, for example `chat.aster.example`, `peer.aster.example` and `orderer.aster.example`. They are written into certificates and into every shared workspace, so choose them once.
- **Certificates.** The nodes use certificates from the company's own certificate authority. Partners trust them because that authority's certificate is in the company's card. Only the chat app needs an ordinary web certificate.

## Launch your own

1. Get a small server and the three names.
2. Make your own copy of the node template (see the repositories below) and fill in `company.json`: the company's name and its three names.
3. Run `./chat up`. It makes the company's keys on that server, starts the node and the app, and creates the home workspace.
4. Open the chat address and sign in as the first administrator.

The `chat` command does not exist yet. What it wraps does: copy this project, write a `network.json` with one company and one workspace (the lab used [lab/one-company.network.json](lab/one-company.network.json)), then run `npm run net:up` and `npm run dev`.

## Add people

- An administrator adds a person in the app. The company's certificate authority signs a certificate for them, and they sign in at the company's chat address.
- A person's ID reads like an email address: `alice@aster`. The part after the @ is the company's ID. Base it on a domain name the company owns, so that no two companies can end up with the same one.
- The person's key stays on the company's server. As with company email, this means the company's administrator could act as any of its people. Keeping keys on people's own devices is a later step.

What works today is the "Add a person" button on the first screen. Still to build: real sign-in, an administrator role, and removing a person.

## Talk to another company

![Swap cards, invite, accept, agree on the rules](many-connect.svg)

Once the four steps are done, the shared workspace appears in both companies' apps. People on both sides can open channels and direct messages in it, exactly as in the demo.

- **Both companies must be online.** In a workspace of two, a message needs both companies' peers to endorse it and both orderers to order it. In a workspace of three or more, it needs more than half. A partner's outage pauses the shared workspace and nothing else: your home workspace carries on.
- **Nobody can write as another company's people.** Every message is signed with its author's key, and it counts only when another company's peer has checked it too.
- **Each company keeps a full copy.** Deleting a message blanks it, but cannot take it out of the copy the other company already holds.
- **Three or more companies.** Build the workspace from all their cards at the start. Adding a company to a workspace that already exists is possible in Fabric (more than half of the current companies sign the change), but it has not been run here. For a first version, start a new workspace instead.

One trap, found in the lab and already fixed. Two orderers that start at different times, as two companies' always will, could not reach agreement: the first link between them was made before the second company had joined, without a certificate, and Fabric kept using that link. Giving each orderer a second port, used only between orderers and strict about certificates, fixes it. That is the `ports.cluster` setting in `network.json`, and the template should always set it.

## What has to change in the code

| | Today | In the template |
| --- | --- | --- |
| Keys | One run makes every company's keys on one machine | Each company makes its own on its own server. Only cards leave it |
| Node certificates | `cryptogen`, Fabric's test tool | Issued by the company's own certificate authority, whose key is kept offline |
| Settings | `network.json` lists every company and every workspace | `company.json` describes one company. Workspaces are read from its node |
| Workspaces | Fixed when the network starts | A home workspace at launch. Shared ones by invite and accept |
| Links between orderers | The same port as everything else | A second port that insists on certificates (`ports.cluster`, already in the generator) |
| App server | Plays all three companies, with no sign-in, and holds everyone's keys | One company. Real sign-in. Keys encrypted on disk. An administrator role |
| "Who holds this message" | Asks every company's peer | Asks your own peer, and shows the hash that proves what the others hold |
| The chat's rules | Built on the spot by `net:up` | A released image. The same version at every company in a workspace |
| Company IDs | `AsterMSP`, letters and digits only | Based on the company's domain name, so they are unique without a registry |

The chat's rules barely change. The lab connected two companies with the chaincode exactly as it is, and only the last row above touches it.

## The GitHub repositories

Make two. Add a third only if you need it.

![The product repository publishes images; each company runs them from its own copy of the template](many-repos.svg)

| Repository | What is in it | Who uses it | What it publishes |
| --- | --- | --- | --- |
| `fabric-chat` | The chat's rules, the app, the admin tool, the sandbox and the documents | You, and anyone who wants to read or change the code | Three images on every release: `fabric-chat-chaincode`, `fabric-chat-app`, `fabric-chat-ctl` |
| `fabric-chat-node` | A template: `compose.yaml`, `company.json`, the `chat` command and the runbook | Every company. Each makes its own private copy from it | Nothing. A copy names which release of the images to run |
| `fabric-chat-directory`, later and only if needed | A public list of company cards | Companies looking for one another | Nothing |

Where today's folders go:

| Today | Goes to |
| --- | --- |
| `chaincode/chat` | `fabric-chat/chaincode` |
| `server` and `web` | `fabric-chat/app` |
| `network/generate.mjs`, `network/net.mjs`, `network/scripts` | `fabric-chat/ctl`. The compose file they write becomes `fabric-chat-node/compose.yaml` |
| The three-company demo and its `network.json` | `fabric-chat/sandbox` |
| `docs/lab` | The `connect` commands of `fabric-chat/ctl` |

- **How a release reaches a server.** A version tag on `fabric-chat` makes GitHub Actions run the tests, build the three images and publish them to GitHub's container registry. A company changes one version number in its copy of the template and runs `./chat up` again. Its server only ever downloads images.
- **Why not one repository.** A company should not have to read or build source code to run its node. Its copy of the template holds only its settings, so it stays small and rarely changes.
- **Why not more.** The rules, the app and the tool still change together, and one repository lets one change cover all three. Split the rules into their own repository on the day another company wants to review rule changes on its own.
- **What never goes into any repository.** Private keys, the `.generated` folder, wallets and passwords.

## Build order

| Step | What gets built | Done when |
| --- | --- | --- |
| 1. One company, properly | `company.json`, `chat up`, the app for one company with real sign-in, the home workspace | A new company on a clean machine is chatting among its own people within ten minutes |
| 2. Connect two | Cards, invite and accept as buttons in the app. The sandbox runs three companies that were each set up separately | The lab's result, reached by clicking rather than by script |
| 3. Two real servers | Names, firewall rules, the runbook, backups | Two companies on different networks exchange messages over the internet |
| 4. Living with it | Removing a person, moving every company to a new version of the rules, adding a company to an existing workspace | Each has been done once, start to finish, in the sandbox |
| 5. Hardening | Keys in a hardware module or on people's devices, the certificate authority's key offline, monitoring | Someone outside the team has reviewed it |

## Decide before building

1. **A name, and whether the code is public.** Public repositories let another company see exactly what it is being asked to run.
2. **Company IDs.** Recommended: base them on the company's domain name.
3. **How people sign in.** Recommended: the company's existing single sign-on. Passwords are enough for a first version.
4. **Who can join a shared workspace.** Recommended for a first version: the companies named when it is created, and no changes afterwards.
5. **Where it runs.** Recommended: Docker Compose on one server per company. Kubernetes can wait.
