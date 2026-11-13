# Fabric Chat in one container (XO Launchpad)

A normal Fabric Chat node is seven containers that `./chat up` starts with Docker Compose. A host
like XO Launchpad runs one image behind one web address, so this folder builds one image that
holds all seven parts and starts them in the same order, with the same admin scripts.

**A node in this image stands alone.** Its peer and orderer cannot be reached from outside the
container, so it cannot share a workspace with another company. People of one company chat with
each other, on that company's own ledger. To connect companies, run normal nodes
(`node-template/`).

## What is here

| File | What it is |
| --- | --- |
| `Dockerfile` | The image `fabric-chat-solo`. It compiles nothing: every program is copied out of the release's own images. |
| `start.sh` | What the container runs. Starts the parts in order and stops the container if one of them stops. |
| `waiting.mjs` | A small page that answers on the chat's port while the node starts. |
| `quirq/`, `xo/` | One folder per company: its `company.json` and a two-line `Dockerfile` that adds it to the image. These are what get deployed. |

## Build and deploy

1. Build the release's images, if they are not on this machine: `npm run images` in the repository.
2. Build the one-container image:

   ```bash
   docker build --platform linux/amd64 -t fabric-chat-solo:0.3.0 launchpad
   ```

3. Deploy a company's folder with Liftoff. It builds the folder on top of the image from step 2, pushes it and checks the registry:

   ```bash
   node D:\XO\quirq\liftoff\bin\liftoff.js deploy liftoff-1-xo-w9633d0 --src D:\XO\quirq\fabric-chat\launchpad\quirq
   ```

Launchpad puts the new image live by itself. The first start takes under a minute.

After a change to `start.sh` or to the chat itself, repeat steps 1 to 3. After a change to a
`company.json` only, step 3 is enough.

## What the Launchpad container needs

- **A disk at `/app/data`.** Everything that must last is kept there: the company's root key, every
  certificate, the ledger, accounts and each person's encrypted key. Without a disk the container
  starts, says so in its log, and loses everything when it is replaced.
- **Port 3000.**
- **To start as root.** Each part then runs as its own user, as in a normal node.

## company.json

The same file a normal node uses, with three differences:

- `hosts.chat` is the Launchpad address, without `https://`, for example
  `liftoff-1-xo-w9633d0.apps.hello-xo.nl`. The chat answers under this name and no other.
- `"https": "self-signed"` with `"listen": { "address": "0.0.0.0", "port": 443 }`. Launchpad does
  the HTTPS; this setting only tells the chat that people reach it over HTTPS, so its links and its
  sign-in cookie are right. No proxy runs in the container.
- No `dockerNetwork` and no `node`: nothing outside the container reaches the node.

`id`, `hosts.peer` and `hosts.orderer` cannot change once a company has started on a disk.

## The first sign-in

The first administrator (`admin` in `company.json`) gets a one-time link to choose a password.
Nobody can run a command inside a Launchpad container, so `start.sh` prints the link in the
container's log, between two lines of `=====`. While that administrator has not chosen a password,
every start prints a fresh link. After that the log shows only how many people there are.

An administrator who is signed in makes links for everyone else in the chat, under People.

There is no way here to make a new link for an administrator who has forgotten their password
after choosing one. Keep a second administrator.

### A starting password

A company folder may hold a file `first-password` (ignored by git), which its `Dockerfile` copies
to `/company/first-password`. The first administrator is then given that password at the first
start, so nobody has to read the log. It is used only while that administrator has no password.
Change it after signing in.

## Sign in with XO

Optional, and on for `xo/`. With `ENV XO_LOGIN_SERVER=https://xo.quirq.dev` in a company's
`Dockerfile`, the sign-in page gets a second button, "Sign in with XO". It uses the same Clerk
sign-in and the same public OAuth client as `xo login` (the xo server names them at `GET /login`),
with PKCE. The chat holds no secret of XO's.

- **One thing must be set outside this folder:** the chat's callback address,
  `https://<hosts.chat>/api/xo-login/callback`, must be in the redirect URLs of the "xo cli" OAuth
  application in Clerk. Until it is, Clerk refuses the sign-in.
- The first time someone signs in with XO they get an account as a member: a handle made from
  their email's name part, and a certificate from the company's CA. An administrator can make
  them an administrator under People.
- **Anyone with an XO account can come in.** To limit it, set `XO_LOGIN_ALLOW` to emails and
  `@domains`, separated by commas.
- The app with this sign-in is built under its own tag, so the release's images stay as they are:

  ```bash
  docker build --platform linux/amd64 -t fabric-chat-app:0.3.0-xologin .
  ```

  ```bash
  docker build --platform linux/amd64 --build-arg APP_IMAGE=fabric-chat-app:0.3.0-xologin -t fabric-chat-solo:0.3.0-xologin launchpad
  ```

## Starting again from nothing

Empty the disk (in Launchpad, remove the disk and add a new one) and restart the container. The
company is made again with new keys, and the log prints a new first link. Nothing of the old
company can be read afterwards.

## Try it on this machine

```bash
docker build --platform linux/amd64 -t solo-quirq launchpad/quirq
```

```bash
docker run --rm -p 127.0.0.1:3900:3000 -v solo-quirq:/app/data solo-quirq
```

The chat is at http://localhost:3900. The link in the log names the Launchpad address: put
`http://localhost:3900` in its place.

## Not here

Sharing a workspace with another company, HTTPS inside the container, `./chat backup` and
`./chat restore`. To move a company off Launchpad, there is no path yet.
