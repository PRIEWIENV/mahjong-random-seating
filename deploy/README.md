# Deployment (PROTOCOL.md §10)

> English · [简体中文](README.zh.md)

One Node process behind a reverse proxy, with SQLite for state. It serves the page and
runs the draw on a timer of its own, so there is nothing else to install and no root
needed. The app and Pantheon share a host, so backend-to-Pantheon calls go over
localhost.

> **Prerequisite: [`docs/RUNBOOK.md`](../docs/RUNBOOK.md) through step 11.** This is the
> deployment step of that checklist, between B and C. §1 checks out the tag step 11
> pushes; RUNBOOK E closes the event out afterwards.

Nothing here holds a secret that could open a submission early. The only credentials on
the box are the GitHub PAT used for mirroring and the Pantheon admin account used for
the seat-plan sync — and the worst either can do is write somewhere.

## 1. Install

**A pushed freeze tag is required.** `data/protocol.json` and `data/roster.json` are
gitignored, and RUNBOOK step 11 is the only thing that commits them, so a clone of the
default branch contains no event and the server refuses to start. Do not write those
files here instead: a protocol that is not the one inside the tag is not frozen, and the
tag is what players are given (PROTOCOL.md §9).

No root, and no new user. Everything lives in one directory that you already own:

```sh
git clone <repo> ~/mahjong && cd ~/mahjong
git tag -l                                 # the freeze tags this clone can see
git checkout <tag>                         # the one RUNBOOK step 11 announced
npm ci --omit=dev
node tools/build-client.js --verify-hash   # committed bundle matches its committed hash
node tools/verify-template.js              # template invariants; needs Python 3, skippable here
```

`<tag>` is a placeholder. This document cannot know your tag name and there is no
default; an empty `git tag -l` means it was never pushed, which
`git ls-remote --tags <repo>` confirms.

`verify-template.js` is a check rather than an install step, and the only command here
that needs anything but Node. A machine without Python 3 can skip the line and run it
elsewhere on the same tag. `.env` and the `chmod` that protects it are both in §2, since
neither can happen before the file exists.

Nothing on that list needs a privilege, and that is a property of the design rather than
a convenience. The process listens on a high port, because something else terminates TLS
in front of it (§4). It writes only inside its own checkout. It opens no device, joins no
group and registers nothing with the system. The two credentials it holds are a GitHub
PAT and a Pantheon account, and both are secrets belonging to **you** rather than to the
machine — which is why a dedicated system account buys less here than it usually does:
the thing worth protecting is in `.env` either way, and file mode does that.

So an organiser who has been given an ordinary account on a club's box can run the whole
event from `$HOME`, including the part that survives a reboot (§3).

<details>
<summary><b>A dedicated system account, if you have root and want one anyway</b></summary>

<br>

It is a reasonable thing to want: a separate account means a compromise of the relay
reaches nothing else of yours, and it lets the systemd hardening in
[`mahjong-relay.service`](mahjong-relay.service) apply, which a user unit cannot use.

```sh
sudo adduser --system --group --home /opt/mahjong mahjong
sudo -u mahjong git clone <repo> /opt/mahjong/app
cd /opt/mahjong/app && sudo -u mahjong git checkout <tag>
sudo -u mahjong npm ci --omit=dev
sudo -u mahjong node tools/build-client.js --verify-hash
sudo chown -R mahjong:mahjong /opt/mahjong
```

Paths in the rest of this document assume the rootless layout; substitute
`/opt/mahjong/app` throughout if you took this path.

</details>

`<repo>` is **your** repository, not the one the code was developed in. The freeze is a
commitment to an event you are running: `data/protocol.json` and `data/roster.json` hold
your target round and your twelve players, they are gitignored upstream for that reason,
and `tools/freeze.js` force-adds them into the tree you tag and push. Fork it or clone it
somewhere you can push to, and freeze there. Players are given that tag and that commit
id; a tag nobody but you can fetch is not a commitment (PROTOCOL.md §9).

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

`.env` at the root of the checkout — mode 600, covered by `.gitignore`, and **read by the
process itself** whatever starts it:

```sh
PORT=8080
HOST=127.0.0.1
NODE_ENV=production

# Optional overrides for operational settings (PROTOCOL.md §4.2). The same values can
# go in data/runtime.json; neither is frozen, and changing either needs no re-tag.
# DRAND_API=https://api2.drand.sh
# PANTHEON_FREY_URL=http://frey.pantheon.local:4004
# PANTHEON_MIMIR_URL=http://mimir.pantheon.local:4001
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

Once the file exists, take the mode down — it holds a GitHub token and a Pantheon
account, and it is the only thing on the box worth protecting:

```sh
chmod 600 .env
```

**Who reads this file.** The process does, at startup, and it says which file it read in
its first few log lines. That used to be the systemd unit's job alone, through
`EnvironmentFile=`, which meant every other way of starting the relay in §3 — tmux,
`nohup`, a crontab, a terminal — produced a server that had never seen any of the above.
Nothing about that looked wrong: it served the page, it signed people in, it took their
ciphertexts, and it mirrored **none** of them, quietly removing the one property (§5)
that stops an organiser dropping an inconvenient submission after seeing the outcome.
A variable already set in the environment still wins over the file, so
`PORT=9000 node server/server.js` keeps meaning what it says.

`PORT` and `HOST` can also be given on the command line, and the flag wins:
`node server/server.js --port 9000 --host 127.0.0.1`. Useful when 8080 is already taken,
which on a box that also runs Pantheon it often is. Whichever you use, the reverse proxy
in §4 has to point at the same number; a port already in use is reported as that, with
the flag to use instead.

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

## 3. Running it

One process:

```sh
node server/server.js
```

That is the whole deployment. The server serves the page **and** runs the draw, spawning
`server/finalise.js --no-wait` every `server.finalise_interval_seconds` (§4.2, default
60). The draw stays a separate program — §9 keeps it off HTTP, so nothing a player can
poke may trigger or re-time it — but nothing outside this repository has to be set up
for it to happen.

Earlier versions asked for two systemd units. That was wrong twice over: registering
units needs root on a machine the organiser may not own, and it does not exist at all on
Windows, where this is developed and rehearsed. The realistic outcome was a deployment
that served the page perfectly and never drew.

**Keeping the one process alive** is whatever your box offers, and none of it is
special:

| | | survives a reboot |
|---|---|---|
| Linux, no root | `tmux new -d -s mahjong 'node server/server.js'`, or `nohup node server/server.js >> var/server.log 2>&1 &` | no |
| Linux, no root | a **user** unit — see below | yes |
| Linux, with root | `sudo cp deploy/mahjong-relay.service /etc/systemd/system/ && sudo systemctl enable --now mahjong-relay` | yes |
| Windows | run it in a terminal, or Task Scheduler with a trigger at log on | with the trigger |

**The rootless unit.** systemd runs a whole instance per user, and registering a service
with your own instance needs nothing from an administrator:

```sh
mkdir -p ~/.config/systemd/user
sed "s|@CHECKOUT@|$PWD|g" deploy/mahjong-relay.user.service \
  > ~/.config/systemd/user/mahjong-relay.service
systemctl --user daemon-reload
systemctl --user enable --now mahjong-relay
systemctl --user status mahjong-relay
loginctl enable-linger          # keep it running when you are not logged in
```

Everything there except the last line was verified on systemd 255 as an ordinary user.
`enable-linger` is the one piece that depends on the machine: it is governed by the
polkit action `org.freedesktop.login1.set-self-linger`, which ships allowed for any user
on Ubuntu and Debian, so enabling it **for yourself** normally needs no sudo. Check with
`loginctl show-user "$USER" -p Linger` — if it says `Linger=no` after you ran it, that
box has a stricter policy and an administrator has to run
`loginctl enable-linger "$USER"` once. Without linger the relay stops when you log out,
which for an event running over days is the same as not running.

The user unit cannot use the sandboxing in the system unit (`ProtectSystem`,
`ReadWritePaths` and the rest need root to enforce), and it drops `User=`/`Group=`
because it already is your user. What it keeps is the part that matters: restart on
failure, and a stop that lets a draw in flight finish.

The draw job restarting with the server is fine and is the point of it running on a
clock. Every run is a no-op until the cutoff, and after it the cadence is also the
recovery path, for three different failures:

- **drand unreachable at the target time** (§8 — a delay, not a failure). The job leaves
  the phase at `awaiting_round` and the next tick tries again. The snapshot was frozen at
  the cutoff, so the delay cannot change the outcome.
- **The process died between publishing the result and syncing to Pantheon.** If no sync
  outcome was ever recorded, the next tick completes it. `results.json` is written once
  and is not touched by this.
- **`var/` was lost after a completed draw.** The job reads `results.json`, reconciles the
  database and stops. It will not re-draw, and it will not declare a published round void.

Once a sync *failure* has been recorded, the job stops retrying: that path has a manual
remedy (RUNBOOK step 15) and a timer hammering Pantheon every minute would only bury it.

### If something else should run the draw

Set `server.run_finalise` to `false` in `data/runtime.json` and schedule it yourself. A
user crontab needs no root either:

```
* * * * * cd $HOME/mahjong && /usr/bin/node server/finalise.js --no-wait >> var/finalise.log 2>&1
```

Do not run both. Two draws in flight would agree with each other — the job is
deterministic, which is the whole point of the protocol — but they would stamp the roll
twice and write to Pantheon twice, and external side effects are worth not doing twice.

The job now also refuses to start while another holds `var/finalise.lock`, so a
misconfiguration here costs you a log line rather than a duplicate write. That is a
backstop, not permission: a lock whose holder has died or that is older than any real run
is taken over, because a lock nobody holds must never be able to stop an event drawing
at all.

### How you find out if nothing is drawing

This was a real failure and it was silent: players sign in, seal their numbers, watch the
countdown reach zero, and then nothing happens. Three things say so now.

- The server logs `[schedule]` lines for every run of the job, and a warning at boot if
  `run_finalise` is off and the job has never run against this database.
- `/admin` carries a row, **The draw job has run**, with when it last did. It is a
  warning while the beacon is still pending and a failure once the draw is late, which
  is the row that distinguishes a late beacon — wait — from a dead schedule — go and
  start something.
- The players' page stops saying "Drawing" after two intervals and says the draw has not
  run, together with the fact that the outcome was fixed at the cutoff regardless.

## 4. The reverse proxy

Pick one. Both configurations do the same three jobs — terminate TLS, forward to
127.0.0.1:8080, and set the security headers — and they cannot run side by side, because
only one process can hold :80 and :443.

**nginx** (`deploy/nginx.conf`) if the host already runs it, which it will if Pantheon
shares the box: every Pantheon container ships its own nginx. Adding Caddy alongside is
not redundancy, it is a port conflict.

```sh
cp deploy/nginx.conf /etc/nginx/sites-available/mahjong   # edit the domain first
ln -s /etc/nginx/sites-available/mahjong /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

**Caddy** (`deploy/Caddyfile`) on a host with nothing else on those ports. It obtains
and renews certificates by itself, which is the whole reason it is still offered here.

```sh
cp deploy/Caddyfile /etc/caddy/Caddyfile   # edit the domain first
systemctl reload caddy
```

Two things are load-bearing in whichever you choose:

- **The stream must not be buffered.** Caddy needs `flush_interval -1`; nginx honours
  the `X-Accel-Buffering: no` the app already sends (server/events.js) and gets
  `proxy_buffering off` as well. Without it the waiting stage stops updating and
  silently degrades to polling.
- **The `connect-src` list.** The **browser** authenticates against Frey directly
  (PANTHEON-INTEGRATION.md §2), so the Frey origin has to be added there or sign-in is
  blocked by the CSP — and blocked in a way no server log records, because the request
  never reaches a server.
- **`server.trust_proxy` in `data/runtime.json`.** Behind a proxy every request arrives
  from 127.0.0.1, so the per-source rate limit becomes one allowance shared by all
  twelve — enough that a few people signing in at the same moment can spend it between
  them. Set it to `true` once the proxy sets `X-Forwarded-For`; both configurations in
  this directory do. It is off by default because believing that header with nothing in
  front would let any caller invent an address and collect an allowance for each one.
  The app reads the **rightmost** entry, which is the address the proxy itself observed,
  so a forged prefix is stepped over rather than believed. The server prints a note at
  boot when it is listening on loopback with the setting off.

### TLS is not optional here

Serve this over plain HTTP and sign-in breaks, in a way that does not look like a TLS
problem. `NODE_ENV=production` marks the session cookie `Secure` (server/server.js), and
a browser will not store a `Secure` cookie that arrived over `http://`. The player signs
in, the page moves on, and every request after it is unauthenticated. Their submission
fails with a 401 they did nothing to cause.

There is a second reason. The browser posts the player's Pantheon password to Frey
itself. Over HTTP that password crosses the network in the clear, and it is not a
password this event owns — it is their Pantheon account.

If a certificate is genuinely not available yet, run the whole thing on HTTP with
`NODE_ENV=development` for testing only, and understand that the deployment is not fit
to run a real draw in that state: `/api/dev-authorize` exists there, and it accepts a
person id with no password at all.

### Do not log request bodies

The browser posts the player's Pantheon email and password to Frey, and the token it
gets back to `POST /api/session`. Both cross this proxy. nginx does not log bodies by
default and neither does Caddy — but a `log_format` with `$request_body` in it, added
one afternoon to debug a sign-in problem, writes every player's Pantheon password to a
file on disk, in a form that outlives the event and gets copied around with the logs.

The token is no better. Frey derives it as `sha384(password + salt)` and keeps accepting
it until the password changes, so it is password-equivalent (PANTHEON-INTEGRATION.md
§2). The app verifies it once, never stores it and never logs it; a proxy log is the one
place it could still be captured.

If you need to debug sign-in, the failure now names itself on the page and in the table
above. That is what it is for.

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

## 6. When sign-in fails

Sign-in is the one request that does not pass through this server. The browser posts the
email and password to Frey itself (PANTHEON-INTEGRATION.md §2), so a failure leaves no
trace in any log here, and for a long time the page reported every one of them as "wrong
email or password" — which sent more than one deployment looking at accounts when the
fault was a URL. The page now names them apart. What it shows, and where to look:

| What the player sees | What actually happened | Where to look |
|---|---|---|
| Pantheon did not recognise that email and password | Frey answered `400 invalid_argument` | It really is the password |
| Pantheon has no account with that email | Frey answered `404 not_found` | The address they signed up with |
| This draw is pointed at the wrong Pantheon address | `bad_route`, or a non-Twirp 404 | `runtime.json` → `pantheon.frey_base_url` and `twirp_path_template` |
| Pantheon could not be reached | The request got no answer at all | CSP `connect-src`, mixed content, DNS, firewall |
| Pantheon returned an error | A 5xx from Frey | Frey's own logs; Hugin being down does this |
| That account isn't registered for this event | Frey said yes, this server said no | The account is not in the twelve |

**The one that catches most deployments** is the third row, and it has a specific cause.
`pantheon.frey_base_url` is what the *backend* uses, and §1 of this file is right to
point it at localhost when Pantheon shares the host. But the *browser* is handed that
same URL and calls Frey itself, and on a player's phone localhost is the phone. Set
`pantheon.frey_public_url` to the address players resolve:

```json
{
  "pantheon": {
    "frey_base_url": "http://localhost:4004",
    "frey_public_url": "https://pantheon.example.com"
  }
}
```

The server warns at boot when the browser-facing URL is a loopback or private address,
and `/admin` carries a row for it. That origin also has to be in the proxy's CSP
`connect-src`, or the request is blocked before it leaves the browser.

Each of the middle four also prints the technical line underneath — the HTTP status and
the Twirp code — so a player can forward it verbatim.

Reproduce any of them against a live Pantheon before the day:

```sh
FREY=http://frey.pantheon.local:4004/v2/common.Frey/Authorize
curl -s -X POST $FREY -H 'content-type: application/json'   -d '{"email":"someone@example.com","password":"wrong"}'
# {"code":"invalid_argument","msg":"Password check failed"}
```

A wrong service name answers `{"code":"bad_route",...}` and a wrong version prefix misses
the Twirp router altogether and gets nginx's HTML 404. Both mean the same thing: the base
URL or the path template is wrong, and no account change will fix it.

`tools/pantheon-fixture.js --accounts` builds twelve accounts with known passwords on a
development instance so this whole path can be walked before it matters.
