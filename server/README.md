# PRCY sync server

The server half of PRCY Manager's cross-device sync. No dependencies: `index.js`
is the whole server, `launch.js` supervises it so it can update itself, and
`ui.html` is the console. They run on plain Node 20+, so the container is
`node:22-alpine` plus three files and nothing to install.

It is a dumb, consistent store: it never merges. Every merge rule lives in the
desktop app (`src/main/sync.ts`), so there is one implementation of them and the
server stays something you can read in a sitting.

## The web console

Open `http://tower.local:8787` in a browser and sign in with `PRCY_ADMIN_TOKEN`.
The console shows what the server holds, manages accounts, and updates the
server itself.

Signing in exchanges the token for a session cookie, so the token is not sitting
in browser storage. Sessions last twelve hours and are held in memory, so a
restart signs you out. Ten wrong tokens from one address inside fifteen minutes
stop further attempts.

## Updating from the console

**Check for updates** compares the `index.js` on the server with the one in the
GitHub repository (`PRCY_UPDATE_URL` if you host it elsewhere). **Update and
restart** then does this, in order:

1. downloads the new `index.js` and `ui.html` to a staging folder;
2. **boots the candidate** on a spare port against a throwaway data directory
   and waits for it to answer `/health` — a file that does not parse, or that
   dies on start, is discarded here and nothing is changed;
3. copies `users.json`, `tokens.json` and every account's `library.json` into
   `/data/backups/pre-update-<timestamp>/`, keeping the last ten;
4. moves the current server aside as `index.js.prev` and swaps the new one in;
5. exits with code 75, which `launch.js` takes as "start me again".

**Saves, accounts and cover art are never read or written by an update.** They
live in `/data/u/` and `/data/blobs/`, and the update only touches
`/data/server/`. The new code lands on the data volume rather than in the image,
so it also survives the container being recreated.

If an update runs but misbehaves, **Roll back** puts `index.js.prev` back and
restarts. And if a new version somehow starts failing later, `launch.js` notices
three quick exits in a row and steps back on its own — first to the previous
update, then to the version baked into the image — so the server comes back up
without anyone logging in.

That safety net is why the container runs `launch.js` rather than `index.js`. A
server started directly refuses to self-update, and the console says so.

## Accounts

Several people can share one server. Each account has its own library, its own
saves and its own vault — nobody can see anybody else's games, and the app never
shows that other accounts exist. The only thing shared is the cover-art blob
store, which is content-addressed public artwork, so two people who own the same
game store one copy of its capsule image instead of two.

There are two credentials, and they are not interchangeable:

- **`PRCY_ADMIN_TOKEN`** (required) manages accounts. It is yours; it never goes
  into the app, and it cannot read anyone's library or saves.
- **`PRCY_INVITE_CODE`** (optional) lets someone create their own account from
  the app's sign-in screen. Leave it unset and sign-ups are closed — you add
  people yourself.

Each device signs in once with a username and password and gets its own token.
The password is never stored in the app, and signing one device out revokes only
that device. Passwords are hashed with scrypt; failed logins are rate-limited per
account and per address.

Adding someone with the admin token:

```bash
curl -X POST http://tower.local:8787/v1/admin/users \
  -H "Authorization: Bearer $PRCY_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"username":"alice","password":"a long passphrase"}'
```

`GET /v1/admin/users` lists them, `DELETE /v1/admin/users/alice` removes an
account and everything it stored, and `POST /v1/admin/users/alice/password`
resets a forgotten password (which signs all of that account's devices out).

## Running it on Unraid

**Docker Compose** — the easiest route if you have the Compose Manager plugin,
or from a terminal:

```bash
cd server
cat > .env <<EOF
PRCY_ADMIN_TOKEN=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
PRCY_INVITE_CODE=$(node -e "console.log(require('crypto').randomBytes(8).toString('hex'))")
EOF
docker compose up -d
```

**From the Unraid Docker UI** — *Add Container*, toggle *Advanced view*, then:

| Field | Value |
| --- | --- |
| Name | `prcy-sync` |
| Repository | `prcy-sync:latest` (after `docker build -t prcy-sync:latest server/`) |
| Network Type | `Bridge` |
| Port | Container `8787` → Host `8787`, TCP |
| Path | Container `/data` → Host `/mnt/user/appdata/prcy-sync`, Read/Write |
| Variable | `PRCY_ADMIN_TOKEN` → a long random string |
| Variable | `PRCY_INVITE_CODE` → a shorter random string (optional) |
| Variable | `PRCY_CHUNK_MB` → `8` (optional; see below) |

To build the image on the Unraid box, copy the `server/` folder to
`/mnt/user/appdata/prcy-sync-src` and run
`docker build -t prcy-sync:latest /mnt/user/appdata/prcy-sync-src`.

Put `/mnt/user/appdata/prcy-sync` on a share that is set to **Cache: Yes** or
lives on the array — saves are small but they are the thing you would miss.

Open `http://tower.local:8787` in a browser and sign in with the admin token to
reach the console, where you can add accounts and update the server later
without touching a terminal.

Then in the app on each device: **Settings → Cross-device sync**, enter
`http://tower.local:8787`, and sign in (or press *Create an account* and enter
the invite code). Press **Test connection**, then **Sync now**.

Without a container:

```bash
PRCY_ADMIN_TOKEN=… PRCY_DATA=/mnt/user/appdata/prcy-sync node launch.js
```

Start `launch.js`, not `index.js` — the supervisor is what makes updating from
the console possible, and what rolls a bad one back.

## Reaching it from outside the house

The safest option is not to expose it at all: **Tailscale or WireGuard** puts a
laptop on your LAN wherever it is, and then `http://tower.local:8787` keeps
working with nothing published to the internet. Unraid has plugins for both.

If you do publish it, terminate TLS in front (Nginx Proxy Manager, Caddy,
Traefik) — the token is the only thing between a stranger and your saves, and
plain HTTP hands it to anyone on the path.

Set **`PRCY_TRUST_PROXY=1`** when you do. Behind a proxy every request arrives
from the proxy's address, so without it one person guessing passwords would
trip the rate limit for everybody. With it set, `X-Forwarded-For` (and
Cloudflare's `CF-Connecting-IP`) is believed instead. Leave it unset otherwise:
a directly reachable server must not trust a header anyone can invent.

Two settings the proxy itself needs: a request body limit at or above
`PRCY_CHUNK_MB` — nginx defaults to **1 MB**, which is smaller than a single
chunk and will break uploads — and a read timeout long enough for a slow chunk,
a few minutes rather than the default sixty seconds.

### Cloudflare and upload speed

Two things to know if you put this behind Cloudflare, whether proxied DNS or a
Tunnel:

**Request bodies are capped at 100 MB** on the Free and Pro plans (200 MB on
Business). A save set larger than that would simply be rejected — so the app
never sends one. The server advertises `maxBodyBytes` on `/health`, and anything
larger goes up in chunks of that size, reassembled server-side. Keep
`PRCY_CHUNK_MB` at or below **8**, comfortably under the cap and small enough
that a dropped connection costs you one chunk rather than the whole upload.
Downloads have no such limit and stream normally.

**Cloudflare does not throttle bandwidth, but it is not a file host either.**
Proxying large amounts of non-HTML content through the CDN is against
[section 2.8 of their Terms](https://www.cloudflare.com/terms/), and in practice
the proxy adds a hop that makes a big upload slower than talking to your server
directly. Your real ceiling will be your home connection's upload speed, which is
usually a tenth of the download figure — a 2 GB save set over a 40 Mbit upstream
is about seven minutes no matter what sits in front of it.

So: if you use Cloudflare, use it for the certificate and the hostname, and be
aware of the 100 MB cap it enforces regardless of plan tier below Enterprise.
For moving real save data, a VPN or a directly-exposed reverse proxy on a
grey-clouded (DNS-only) record is both faster and less likely to annoy anyone.
The other knobs worth setting if you do proxy it: a **Cache Rule bypassing cache
for `/v1/*`** (the server already sends `no-store`, but be explicit), and no
Rocket Loader or minification, which have nothing to transform here anyway.

## Security

Passwords are scrypt-hashed with a per-account salt. Device tokens are 32 random
bytes, stored only as SHA-256 hashes, and compared in constant time; the admin
token and invite code are compared in constant time too. A wrong username and a
wrong password take the same time and give the same message, so accounts cannot
be enumerated. Ten failed logins for one account or from one address inside
fifteen minutes stop further attempts.

Path segments are validated against strict patterns, so a request cannot walk out
of the data directory, and every save and library route is scoped to the signed-in
account's own subtree.

The vault password is not the account password: the app syncs its hash so hidden
games stay hidden everywhere, and the server never sees the password itself.

## What it stores

```
/data
  users.json            accounts: username, scrypt hash, salt
  tokens.json           device tokens, hashed, with a name and last-seen time
  u/<userId>/
    library.json        that account's metadata: titles, tags, playtime, vault hash
    saves/<gameKey>/    up to 20 versions per game, newest kept
      versions.json     which device wrote each one, and when
      <versionId>.prcysave
  blobs/<sha256>        cover art, content-addressed and shared between accounts
  uploads/<id>/         chunks mid-flight; cleared on start and after an hour
  app/                  desktop installers, three newest, plus index.json
  server/               an applied update: index.js, ui.html, index.js.prev
  backups/              account files copied before each update, last ten kept
```

Save versions are never overwritten. Uploading a save that conflicts with
another device's adds a version beside it — the app asks you which to keep, and
the one you did not pick stays here and in the app's local `save-backups`.

## API

`/health` is open. `/v1/admin/*` needs the admin token. Everything else needs a
device token from `Bearer <token>`.

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/health` | Liveness, whether sign-ups are open, and `maxBodyBytes` |
| POST | `/v1/auth/register` | New account, with the invite code |
| POST | `/v1/auth/login` | Sign a device in, returning its token |
| GET | `/v1/auth/me` | Who this token belongs to |
| POST | `/v1/auth/logout` | Revoke this device's token |
| POST | `/v1/auth/password` | Change password; signs other devices out |
| GET/DELETE | `/v1/auth/devices[/:id]` | List signed-in devices, or revoke one |
| GET | `/v1/library` | The account's metadata document, with its `rev` |
| PUT | `/v1/library` | Replace it; send `baseRev`, get `409` + current on a race |
| GET | `/v1/saves/:key` | Version list for one game |
| POST | `/v1/saves/:key` | Upload a version (`?device=&name=&capturedAt=`) |
| GET | `/v1/saves/:key/:versionId` | Download one version |
| HEAD/GET/PUT | `/v1/blobs/:sha256` | Cover art by content hash |
| POST | `/v1/uploads` | Start a chunked upload |
| PUT | `/v1/uploads/:id/:index` | One chunk |
| POST | `/v1/uploads/:id/finish` | Assemble into a save or a blob |
| GET | `/v1/app/latest` | The newest desktop build, with its checksum |
| GET | `/v1/app/download/:version` | That installer |
| GET/POST/DELETE | `/v1/admin/users[/:name]` | Manage accounts |
| POST/DELETE | `/v1/admin/session` | Sign the web console in or out |
| GET | `/v1/admin/status` | Version, uptime and per-account usage |
| GET | `/v1/admin/update/check` | Compare with the published version |
| POST | `/v1/admin/update/apply` | Test, install and restart |
| POST | `/v1/admin/update/rollback` | Put the previous version back |

## Hosting the desktop app

The server also hands out the desktop app's own installer, so devices update
themselves without anything being published publicly. From the project on your
build machine:

```bash
npm run dist
PRCY_URL=http://tower.local:8787 PRCY_ADMIN_TOKEN=… npm run publish
```

The upload is chunked like a save, and **only the admin token may publish** — a
signed-in account gets a 403. The server records the SHA-256 of what it stored;
each device checks the download against it and discards anything that does not
match, which is what stands in for a code signature on an unsigned build. The
three most recent builds are kept, under `/data/app/`.

## Backups

Everything is files under `/data`. Include it in whatever already backs up your
appdata share; there is no database to dump. `users.json` and `tokens.json` are
the two that matter — losing them means everyone signs in again, and losing
`users.json` means recreating the accounts.
