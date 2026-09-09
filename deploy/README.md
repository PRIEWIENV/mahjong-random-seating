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

# Mirroring: ciphertexts become public, timestamped by a third party, as they arrive.
MIRROR_REPO=youruser/mahjong-random-seating
MIRROR_BRANCH=main
MIRROR_TOKEN=github_pat_...          # contents:write, narrowed to this one repository

# Pantheon admin, for the seat-plan sync ONLY (PANTHEON-INTEGRATION.md §3).
# Never used on the player sign-in path.
PANTHEON_ADMIN_PERSON_ID=...
PANTHEON_ADMIN_TOKEN=...
```

`NODE_ENV=production` matters for more than logging: it marks the session cookie
`Secure` and makes `/api/dev-authorize` return 404. That endpoint is the development
stand-in for Frey; it must not exist here.

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
is also the recovery path: if drand is unreachable at the target time (§8 — a delay, not
a failure), the job leaves the phase at `awaiting_round` and the next tick tries again.
The snapshot was frozen at the cutoff, so the delay cannot change the outcome.

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
```

Then sign in yourself with a real Pantheon account that is registered to the event, and
with one that is not. Both answers must be right, and they must read differently
(UI-SPEC §3). RUNBOOK step A3 is that check; it is much cheaper now than on the day.
