# Deployment (PROTOCOL.md §10)

A small Node process behind Caddy, SQLite for state, and a systemd timer for the
finalisation job. The app and Pantheon share a host, so backend-to-Pantheon calls go
over localhost.

Nothing here holds a secret that could open a submission early. The only credentials on
the box are the GitHub PAT used for mirroring and the Pantheon admin account used for
the seat-plan sync — and the worst either can do is write somewhere.

## 1. Install

```sh
adduser --system --group --home /opt/mahjong mahjong
git clone <repo> /opt/mahjong/app && cd /opt/mahjong/app
git checkout frozen-v1                     # the tag from RUNBOOK step 11
npm ci --omit=dev
node tools/build-client.js --verify-hash   # committed bundle matches its committed hash
node tools/verify-template.js              # re-derive the template invariants
chown -R mahjong:mahjong /opt/mahjong
```

`npm ci --omit=dev` is deliberate: the server needs `tlock-js`, and nothing else.

If `--verify-hash` fails on a **fresh clone**, suspect the checkout before suspecting
the bundle. Git rewrites line endings on checkout when `core.autocrlf` is on, which is
the Windows default: the blob is 347717 bytes with no CR and the working copy comes out
347738 bytes with 21 CRs, and the digest is not the same digest. `.gitattributes` in this
repository switches that off for every byte-pinned artefact, so a checkout that still
shows it is one made before that file existed, or one where a local setting overrides it.
Check with `git check-attr text eol -- public/app.js`.

Note which bundle check runs where. `--verify-hash` compares the committed
`app.js` + `app.css` against their committed digest and needs no dependencies, which is
why it is the one that runs here — `--omit=dev` means esbuild is not installed on this
machine. The strong check, `node tools/build-client.js --check`, rebuilds from source
and diffs the result; run that on a dev machine or in CI **before** the freeze commit.

## 2. Environment

`/opt/mahjong/app/.env` — mode 600, owned by `mahjong`, covered by `.gitignore`:

```sh
PORT=8080
HOST=127.0.0.1
NODE_ENV=production

# Optional overrides for operational settings (PROTOCOL.md §4.2). The same values can
# go in data/runtime.json; neither is frozen, and changing either needs no re-tag.
# DRAND_API=https://api2.drand.sh
# PANTHEON_FREY_URL=http://localhost:4001
# PANTHEON_MIMIR_URL=http://localhost:4002
PANTHEON_MODE=twirp                  # the default; "stub" is for local runs only

# Mirroring: ciphertexts become public, timestamped by a third party, as they arrive.
MIRROR_REPO=youruser/mahjong-random-seating
MIRROR_BRANCH=main
MIRROR_TOKEN=github_pat_...          # contents:write, narrowed to this one repository

# Pantheon admin, for the seat-plan sync ONLY (PANTHEON-INTEGRATION.md §3).
# Never used on the player sign-in path.
PANTHEON_ADMIN_PERSON_ID=...
PANTHEON_ADMIN_TOKEN=...
```

```sh
# The organiser's dashboard. Without this the /admin route does not exist.
ADMIN_TOKEN=...                      # openssl rand -hex 16
```

`NODE_ENV=production` matters for more than logging: it marks the session cookie
`Secure` and makes `/api/dev-authorize` return 404. That endpoint is the development
stand-in for Frey; it must not exist here.

`ADMIN_TOKEN` gates `/admin`, which shows submission progress, who is still missing, the
pre-flight checks and the sync outcome. Unset, the route 404s like any other path, so an
organiser who never configured one has not accidentally published a roster and a
submission timeline. The page is read-only by design: the draw, the reset and the sync are
commands run on this box, because §9 keeps anything that could trigger or re-time the draw
off HTTP. Treat the token like the PAT — it reveals who has submitted and when, which is
public information anyway, but there is no reason to hand it out.

`data/runtime.json` is the file counterpart of those overrides and is optional in the
same way. It is gitignored on purpose: nothing in it can change the outcome, and keeping
it out of the tree makes it obvious that it was never covered by the freeze. If a drand
mirror dies during the submission window, this is the file you edit — not a tagged one.

Narrow the GitHub PAT to this repository and to contents:write only. Per §10, write
access to `main` should be restricted to that token, so the ciphertext history is
append-only in practice as well as in principle.

## 3. Services

```sh
cp deploy/mahjong-relay.service /etc/systemd/system/
cp deploy/mahjong-finalise.service deploy/mahjong-finalise.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now mahjong-relay
systemctl enable --now mahjong-finalise.timer
```

The finalise timer runs every five minutes and is a no-op until the cutoff. That cadence
is also the recovery path, for three different failures:

- **drand unreachable at the target time** (§8 — a delay, not a failure). The job leaves
  the phase at `awaiting_round` and the next tick tries again. The snapshot was frozen at
  the cutoff, so the delay cannot change the outcome.
- **The process died between publishing the result and syncing to Pantheon.** If no sync
  outcome was ever recorded, the next tick completes it. `results.json` is written once
  and is not touched by this.
- **`var/` was lost after a completed draw.** The job reads `results.json`, reconciles the
  database and stops. It will not re-draw, and it will not declare a published round void.

Once a sync *failure* has been recorded, the job stops retrying: that path has a manual
remedy (RUNBOOK step 15) and a timer hammering Pantheon every five minutes would only
bury it.

## 4. Caddy

```sh
cp deploy/Caddyfile /etc/caddy/Caddyfile   # edit the domain first
systemctl reload caddy
```

Two things in that file are load-bearing:

- `flush_interval -1` on the proxy. Without it the SSE stream is buffered, the waiting
  stage stops updating, and it silently degrades to 15 s polling.
- The `connect-src` list. The **browser** authenticates against Frey directly
  (PANTHEON-INTEGRATION.md §2), so the Frey origin has to be added there or sign-in is
  blocked by the CSP.

## 5. Before you tell anyone the URL

```sh
curl -s https://your.domain/api/status | jq     # 12 slots, submitted_count 0, phase "open"
curl -s https://your.domain/protocol.json | jq  # the frozen parameters, as tagged
curl -s https://your.domain/api/dev-authorize -X POST -d '{}'   # must be 404
curl -s -o /dev/null -w '%{http_code}\n' https://your.domain/admin   # must be 404
```

Then open `/admin?token=…` and read the pre-flight panel. Every row should be green.
`Mirroring to the repository: DISABLED` and `Pantheon adapter is the STUB` are the two
that make the deployment unfit to run a real draw.

In that status payload, `drand.chain_hash` and `drand.chain_public_key` must match the
tagged `protocol.json` exactly — they are what the browser pins the chain with, and the
draw is only bound to the beacon everyone was promised if both are right. `drand.api`
need not match anything: it is where that chain is currently reached (§4.2).

Then sign in yourself with a real Pantheon account that is registered to the event, and
with one that is not. Both answers must be right, and they must read differently
(UI-SPEC §3). RUNBOOK step A3 is that check; it is much cheaper now than on the day.
