# Your company's Fabric Chat server

This folder is everything one company needs to run its own team chat on its own Hyperledger Fabric node, and to share a workspace with other companies that do the same: three files, and Docker.

These files belong to release 0.3.0 of [Fabric Chat](https://github.com/quirq-ai/fabric-chat). Its three images are public on GitHub's container registry, and `./chat up` downloads them: there is nothing to build and no account to make.

| File | What it is |
| --- | --- |
| `company.json` | The one file you fill in |
| `chat` | The command that starts the server and looks after it |
| `compose.yaml` | The list of what runs. You should not need to change it |

`./chat up` writes two more files from `company.json`: `.env`, the settings, and `compose.generated.yaml`, which lists everything this server opens to the outside. Read that one when you want to know what is open. Do not edit either.

Nothing secret is ever written into this folder, with one exception you ask for: a backup, which is locked with a passphrase. Every key and password is made on the server and stays in Docker volumes.

These files are also published by themselves, as the template repository [fabric-chat-node](https://github.com/quirq-ai/fabric-chat-node). Choose **Use this template** there to make your company's own copy. Keep the copy private if you like: it holds your settings and nothing secret.

## Before you start

- **A machine with Docker** and Docker Compose version 2. One company's whole server used 300 MB of memory when idle in testing. 2 CPUs, 4 GB of memory and 40 GB of disk is plenty to start.
- **The three images** of the release you want to run. `images` in `company.json` says where they come from, and `./chat up` downloads them: about 400 MB the first time. As the template comes, that is GitHub's container registry, where they are public. They are built for servers with Intel or AMD processors, not yet for ARM ones. To run your own build instead, run `npm run images` in the `fabric-chat` repository and put `fabric-chat` in `images`.
- **On Windows**, run the commands in Git Bash, as `sh chat up`.

## 1. Fill in company.json

| Setting | What it is | Can it change later? |
| --- | --- | --- |
| `name` | The company's name, as people will see it | Yes. Run `./chat restart` afterwards |
| `id` | The company's ID on every ledger. Use a domain name the company owns, in lower case. People's IDs end in it: `alice@aster.example` | No |
| `color` | The company's colour in the app, as six hex digits | Yes |
| `hosts.chat` | The name people's browsers reach the chat by | Yes |
| `hosts.peer`, `hosts.orderer` | The names other companies' nodes reach this company's node by. They are written into its certificates and its workspaces | No |
| `admin` | The first administrator: a handle, a name and a job title | Only before the first `./chat up` |
| `listen` | The address and port of this machine the chat answers on. `127.0.0.1` means this machine only. `0.0.0.0` means every network it is on. Leave it out and you get `127.0.0.1` and port 8080 over plain HTTP, or every network and port 443 over HTTPS | Yes |
| `https` | Leave it out for plain HTTP. `"auto"` gets a certificate from Let's Encrypt and renews it. `"self-signed"` is for trying HTTPS on a private network: browsers will warn. See section 5 | Yes |
| `node.address` | Opens the node's three ports on this address of the server, so that other companies' servers can reach it. `0.0.0.0` means every network. Leave it out and the node is closed to every other server | Yes |
| `images`, `release` | Where the images come from, and which version to run. Keep each on a line of its own | Yes. See "A new release" |
| `dockerNetwork` | Only for several companies on one machine: the name of a Docker network they all join, which stands in for the internet between them. Leave it out on a server of its own | Yes |

The ID and the two node names cannot change after the first start, because every certificate and every record carries them. `./chat up` refuses to go on if they differ from the first time.

## 2. Start it

```bash
./chat up
```

The first run takes about 25 seconds once the images are on the machine. It:

1. makes the company's root key and certificate, on this machine;
2. starts the company's certificate authority and has it issue a certificate to the peer, the orderer and the chat app;
3. creates the home workspace: a ledger only this company is on;
4. deploys the chat's rules to it;
5. starts the chat app, which makes the first administrator and a #general channel.

It ends by printing where the chat is, and a one-time link for the first administrator. They open the link and choose a password.

Run `./chat up` again whenever you like. Whatever is already in place is left alone, the first administrator's link included, and it takes about 12 seconds. If a step fails, it says which one and why, and starts nothing after it.

If the server itself restarts, everything on it starts again by itself. In testing a company answered within two seconds of its server's Docker being up, and people were still signed in.

## 3. Add people

An administrator signs in, opens **People** in the left rail and chooses **Add a person**.

- The company's certificate authority signs the new person a certificate, and they join the workspace's directory.
- The administrator gets a one-time link to pass on. The person opens it and chooses their own password, so no administrator ever knows it.
- A link works once, for seven days. **New link** makes another. For someone who has forgotten their password, **Reset password** does the same.
- An administrator can make another person an administrator. There is always at least one.

If every administrator is locked out, whoever runs the server can let one back in:

```bash
./chat admin-link
```

## 4. Share a workspace with another company

Any two companies that each run this server can share a workspace: a second ledger, held by exactly the two of them. Their servers must be able to reach each other, which is section 5. An administrator opens **Other companies** in the left rail.

1. **Swap cards.** Copy your company's card and send it to the other company's administrator, by email or any other way. Ask for theirs. A card holds a company's name, its root certificate and where its nodes are, and nothing secret.
2. **One of you starts the workspace.** Choose **Start a workspace**, give it a name and paste the other company's card. You get an invitation to send back.
3. **The other accepts.** Choose **Accept an invitation**, paste it, look at who is in it, and accept.

The two nodes then agree on the rules by themselves, and the workspace appears at the left edge of the chat for everyone at both companies. Nobody has to click again.

- **Check the fingerprint.** A card shows a fingerprint of the company's root certificate. Read it to the other administrator by phone or in person the first time. It is how you know the card was not swapped on the way.
- **The app says whether your server reaches theirs.** When you paste a card, and again when you check an invitation, your node tries the other company's peer and orderer. It tells you if one does not answer, and it tells you if what answers is not that company's node: its certificate must be signed under the root certificate on the card. Whether their server reaches yours shows on their side, the same way.
- **Your node checks the invitation.** Before it joins, it works out what the workspace's first block should say for the cards in the invitation, and joins only if the block says exactly that: these companies, each with one vote, and no others.
- **Three or more companies.** Paste several cards when you start the workspace, and send every company the same invitation. The workspace is usable as soon as more than half have accepted.

What to know about a shared workspace:

- A workspace of two takes messages only while both companies' nodes are running. A workspace of three or more needs more than half. Your own workspace is never affected.
- A message can take a few seconds longer just after a company's node stops or starts, and while a company that was invited has not accepted yet. The app offers the message to the workspace's orderers again until one takes it, for up to half a minute. If a message is refused, `./chat logs app` says which orderers did not take it.
- Each company on it holds a full copy of every open channel, and of every conversation its people are in. A conversation among your own people only stays on your node: the others receive hashes.
- In a workspace of three or more, a conversation among people of two of the companies is still kept by all of them. The app says so before you create it.
- The list of companies cannot be changed afterwards, and a company cannot leave. Start a new workspace instead.

## 5. Put it on the internet

Three things make a server reachable: names, open ports and a certificate.

**Names.** Point three names at the server's public address, with your DNS provider: the ones in `hosts.chat`, `hosts.peer` and `hosts.orderer`. All three lead to the same server.

**Settings.** Add two lines to `company.json`, and take `listen` out:

```json
  "https": "auto",
  "node": { "address": "0.0.0.0" },
```

Then run `./chat up`. The chat is now at `https://` followed by `hosts.chat`, and links the server hands out start with that. Signing in uses a cookie browsers send over HTTPS only.

**Ports.** These are open on the server afterwards, and nothing else is.

| Port | Who needs to reach it | What answers |
| --- | --- | --- |
| 443 | Your people's browsers, and Let's Encrypt | The chat, over HTTPS |
| 80 | The same | Sends plain HTTP on to HTTPS, and lets Let's Encrypt check the name |
| 7051 | Other companies' servers | The peer |
| 7050 | Other companies' servers | The orderer, for their peers |
| 7055 | Other companies' servers | The orderer, for their orderers. It insists on a certificate from both ends |

Never open these, and `./chat` never does: 7054 (the certificate authority), 5984 (the database), 7053 and 9443 (the orderer's admin and status ports), 8080 (the app behind the proxy).

Docker opens the ports above by itself, past a firewall that runs on the same server, such as `ufw`. To limit who reaches them, use the firewall your hosting provider puts in front of the server. `./chat status` says what is open.

**The certificate.** With `"auto"`, the server asks Let's Encrypt for a certificate for `hosts.chat`, proves it answers to that name, and renews the certificate before it runs out. It needs ports 443 and 80 open and the name pointing at the server before `./chat up`. A company with its own certificate authority that speaks the same protocol writes a block in place of the word:

```json
  "https": { "authority": "https://ca.aster.example/acme/directory", "root": "-----BEGIN CERTIFICATE-----\n…", "email": "it@aster.example" },
```

This was tested against Pebble, the test server Let's Encrypt publishes, on machines standing in for two servers. It has not been run against Let's Encrypt itself, which needs a public name.

**The node's own traffic** is always encrypted and signed, with certificates from each company's own authority. Anyone on the internet can connect to ports 7051 and 7050, as with any Fabric network, but a node acts only on requests signed by a member of the workspace concerned.

## 6. Back it up

```bash
./chat backup
```

It asks for a passphrase twice, pauses everything, copies every volume into one file in `backups/`, and starts everything again. In testing the chat was away for 30 seconds. The file holds every key the company has, so it is locked: without the passphrase it cannot be opened, by you either. Copy the file off the server and keep the passphrase somewhere else.

To run it on a schedule, give the passphrase in `CHAT_BACKUP_PASSPHRASE`, for example from a file only root can read.

To bring a company back on an empty server, put this folder's three files there with the same `company.json`, put the backup in `backups/`, and run:

```bash
./chat restore backups/aster.example-20261112-211309.fcbackup
```

It refuses a wrong passphrase, a file that was changed or cut short, a `company.json` for another company, and a server that already holds something. In each case it leaves the server empty. In testing a company was back 28 seconds after the command, on a new server at the same names: people signed in with the passwords they had, and the chat kept its HTTPS certificate.

What a restore brings back:

- **Everything up to the backup**: the ledger, every key, the accounts.
- **What was said in a shared workspace after the backup.** Your node gets it again from the other companies' nodes.
- **Not what was said after the backup in your own workspace, or in a conversation among your own people only**, even inside a shared workspace. No other server ever held it. Back up as often as you can bear to lose.
- **Not an edit made after the backup to a message among your own people.** The message shows its old words again. It can be read, but no longer changed or deleted, and the app says why when someone tries. The rest of the conversation works as before.
- **Not sign-ins made after the backup.** Those people sign in again.

Restore a backup once, onto one server. Two servers running as the same company would each sign in its name.

## Everyday commands

| Command | What it does |
| --- | --- |
| `./chat up` | Start everything. Safe to run again |
| `./chat status` | What is running, where the chat is, whether the node is open, and how many blocks the ledger holds |
| `./chat logs app` | What one part has printed: `app`, `agent`, `proxy`, `peer`, `orderer`, `ca`, `couchdb` or `chaincode` |
| `./chat restart` | Restart the chat app, for example after changing the company's name. People stay signed in |
| `./chat admin-link [handle]` | A new one-time link for an administrator |
| `./chat backup` | Copy everything into one locked file in `backups/` |
| `./chat restore backups/<file>` | Bring a backup back on an empty server |
| `./chat stop` | Pause everything. Nothing is lost |
| `./chat down` | Remove the containers. The ledger, the keys and the accounts stay, and `./chat up` brings everything back |
| `./chat wipe` | Remove everything for good. It asks for the company ID first. Backups are not touched |

## A new release

`chat` and `compose.yaml` belong to a release, like the images. To move to a newer one:

1. Make a backup.
2. Replace `chat` and `compose.yaml` with the ones that come with the new release. Leave `company.json` alone, except for the next step.
3. Set `release` in `company.json` to the new version.
4. Run `./chat up`.

If the files and the release do not match, `./chat up` says so and changes nothing. In testing a company moved from 0.2.0 to 0.3.0 in about 20 seconds, with people still signed in.

A release that leaves the chat's rules as they are can be taken by each company in its own time: two companies kept talking with one on 0.2.0 and the other on 0.3.0. A release that changes the rules must be taken by every company in a shared workspace, and moving the rules is not built yet.

## What is kept where

Each of these is a Docker volume on the server, named after the company. A backup holds all of them except `desk`.

| Volume | What is in it | If it is lost |
| --- | --- | --- |
| `ca` | The company's root key, and the register of every certificate it has signed | The company can no longer add people or prove who it is |
| `node` | The nodes' own keys and certificates, the cards of the companies it knows, and each workspace's first block | The nodes cannot start |
| `peer`, `orderer` | The ledger: every block of every workspace | The home workspace's history is gone |
| `couchdb` | The current value of every record: a fast index of the ledger | Fabric can rebuild it from the ledger. Not tried here |
| `data` | Accounts, sessions and each person's private key, locked | People must be added again. They keep their IDs and their messages. This was tested for one person |
| `app` | The key that unlocks the keys in `data`, and the app's own certificates | The keys in `data` can no longer be unlocked |
| `proxy` | The HTTPS certificate for the chat's name, and its key | The server asks for a new one at the next start |
| `rules`, `couchdb-config` | Small settings made at the first start | The node cannot start |
| `desk` | Requests from the chat app to the node's agent while they are being answered | Nothing: it is emptied at every start |

## What to know before relying on it

- **Over plain HTTP, keep the chat on this machine.** Without `https`, keep `listen.address` at `127.0.0.1` unless the machine's network is private. On an open network, passwords would travel in the clear.
- **Whoever runs this server is trusted.** They hold the company's root key, so they can read every message and sign a certificate in anyone's name. That is the same trust a company places in whoever runs its email.
- **The app signs on people's behalf.** Each person's key stays on the server, locked with a key kept in a separate volume. Keys on people's own devices are a later step.
- **Certificates of the company's own authority last ten years.** Renewing one is not built yet. The HTTPS certificate is another matter: it renews by itself.
- **It has run on machines standing in for servers, not yet on two real ones.** Each stand-in was a Docker of its own with its own address, reached only by name and only through the ports above.

## Not built yet

- Leaving a shared workspace, or adding a company to one.
- Removing a person. A person who leaves keeps a working certificate.
- Moving every company in a shared workspace to a new version of the chat's rules.
- Backups that run by themselves and leave the server by themselves.

The plan for these is in the `fabric-chat` repository, in [docs/many-companies.md](https://github.com/quirq-ai/fabric-chat/blob/main/docs/many-companies.md).
