# Deployment guide

> English · [简体中文](README.zh.md)

Everything an organiser does, in order, from a bare server to a finished draw. Two
machines are involved: **your computer**, where the event is frozen (that needs a build
toolchain), and **the server**, where it runs. Budget an afternoon the first time and
half an hour after that. [`../docs/RUNBOOK.md`](../docs/RUNBOOK.md) is this sequence as
a one-page checklist, for the second time.

Commands are given in full. Where a line needs a value of yours it is in `<angle
brackets>`. The reasons behind the steps are not here; the last section says where they
are.

> [!IMPORTANT]
> **What you need before starting**
> - **Node 24 or newer** on both machines (`node --version`). Older versions install
>   cleanly and fail at the first start.
> - A **Pantheon** instance the players have accounts on, and an admin account on it
>   that is an admin of the event.
> - A **git repository you can push to** — your own fork of this one. The freeze commits
>   your event into it, and players are given the tag.
> - A **domain name** pointing at the server, for TLS. Sign-in does not work over plain
>   http.
> - On the server: `sudo` for nginx and certbot only. The application itself needs no
>   root, no new user and no port below 1024.
> - The network: both machines reach `api.drand.sh`, the server reaches Pantheon, and
>   players' phones reach Frey (Pantheon's sign-in service) directly.

## Part 1 — Before the event, on your computer

### 1. The event in Pantheon

In Pantheon's admin interface:

1. Create the event, or open it, and mark it **prescripted** (a tournament, not a club
   event — only tournaments can be prescripted).
2. Register **exactly twelve** players. Anyone attending without playing gets
   `ignore_seating`.
3. Give every one of the twelve a **local id**, 1 to 12.
4. Make sure the admin account you will use for the seat-plan sync is an admin **of this
   event**.

Note the event's id; the freeze needs it once.

### 2. Your repository

```sh
git clone <your fork> mahjong-random-seating && cd mahjong-random-seating
npm ci
cp data/runtime.example.json data/runtime.json
```

Edit `data/runtime.json` → `pantheon`: set `frey_base_url` and `mimir_base_url` to your
Pantheon's Frey and Mimir addresses. The freeze reads the roster from Mimir, so they
must be reachable from this computer.

> [!NOTE]
> `runtime.json` is gitignored and never enters the tag, so it is written on each
> machine separately. You will write it again on the server in §6.

### 3. Choose the target round

```sh
cp data/protocol.example.json data/protocol.json      # the first event only
node tools/pick-round.js --in 72h --write
```

`--in 72h` puts the draw 72 hours from now and the submission cutoff ten minutes before
it. It writes `target_round`, `submission_cutoff_utc`, `chain_hash` and
`chain_public_key` together, from the live drand chain.

### 4. Freeze and tag

```sh
node tools/freeze.js --event <id> --write             # data/roster.json, read out of Pantheon
node tools/freeze.js --write --tag <name> --push      # commit, tag, push; prints the announcement
git ls-remote --tags <your fork> <name>               # from any other machine: the tag is public
```

The first command refuses — and writes nothing — if the seated count is not twelve, if
anyone lacks a local id or a title, or if an account is registered twice. Fix it in
Pantheon and run it again.

The second takes about a minute: it re-derives the seating template's invariants,
rebuilds the browser bundle from source and diffs it against the committed one, runs
the unit tests, then commits `data/protocol.json`, `data/roster.json`,
`data/schedule_template.json`, `generate.js` and the built bundle, tags, pushes, and
timestamps the commit id. It also prints the **announcement** for step 10 — copy it now.

> [!WARNING]
> - `<name>` is used once. A second event, or a retry after a void, needs a new one.
> - Keep `events/freeze/<name>.commit.ots`. It is the proof that the commit existed
>   before anyone submitted.
> - Nothing frozen may change from here on. A changed byte voids the event.

## Part 2 — The server

### 5. Install at the tag

```sh
git clone <your fork> ~/mahjong && cd ~/mahjong
git fetch --tags && git checkout <tag>                # the name from step 4
npm ci --omit=dev
node tools/build-client.js --verify-hash              # the committed bundle matches its hash
```

> [!NOTE]
> - `--omit=dev` is deliberate: the server needs `tlock-js` and nothing else.
> - If `--verify-hash` fails on a fresh clone, run `git check-attr text eol -- public/app.js`.
>   It must say `-text`; if it does not, git rewrote line endings and the checkout, not the
>   bundle, is wrong.

### 6. Configure

**`.env`**, at the root of the checkout. The process reads it itself, whatever starts
it:

```sh
PORT=8080
HOST=127.0.0.1
NODE_ENV=production
PANTHEON_MODE=twirp

# Mirroring: every ciphertext is published to the repository as it arrives.
# Do not fill these three in by hand — `node tools/setup-mirror.js` writes them below.
MIRROR_REPO=<owner>/<repo>
MIRROR_BRANCH=main
MIRROR_TOKEN=github_pat_...

# OPTIONAL — the organiser's dashboard at /admin?token=...  (openssl rand -hex 16)
# You usually do not need this: any event admin who signs in through the ordinary page
# opens the dashboard with their own session. Set it only if you want a link that works
# before anyone has signed in, or from a machine that is not signed in.
ADMIN_TOKEN=...
```

```sh
chmod 600 .env
```

#### The GitHub token for mirroring

```sh
node tools/setup-mirror.js          # asks, checks it works, writes the three settings
node tools/setup-mirror.js --check  # later: is the token still good?
```

Run it and it works out the repository from `git remote origin`, tells you exactly what
to click, takes the token at a hidden prompt, **proves it can actually write** to the
repository, and only then writes `MIRROR_REPO`, `MIRROR_BRANCH` and `MIRROR_TOKEN` into
`.env` at mode `600`. Nothing needs editing by hand, and the token never appears on a
command line or in your shell history.

The one step it cannot do for you is GitHub's: a token is issued to a human in a
browser, and no API mints one. (Device flow would need an OAuth App whose owner every
operator of this code then depends on, and it would still send you to github.com to type
a code.) So, once, at
[github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new)
— or Settings → Developer settings → Personal access tokens → **Fine-grained tokens** →
**Generate new token**:

| Field | What to put |
|---|---|
| Token name | anything, e.g. `seating mirror` |
| Expiration | past the day of the draw |
| Resource owner | the account or organisation that owns the mirror repository |
| Repository access | **Only select repositories** → your fork |
| Permissions | Repository permissions → **Contents** → **Read and write** |

Generate it and copy the `github_pat_…` value; GitHub shows it once. Paste it at the
prompt. If you already use the [GitHub CLI](https://cli.github.com/) on this machine and
are signed in, the tool offers `gh auth token` instead and you can skip the browser
entirely — at the price of a token covering your whole account rather than one
repository, which is a poor trade for a credential that then lives on a server.

> [!NOTE]
> The check is a real write: it creates `.mirror-check` on the branch and deletes it
> again, leaving two commits. That is deliberate. `GET /repos` reports the permissions
> of the *user*, not of the token, so a read-only token on your own repository looks
> writable — and the thing that would otherwise discover it is a player's submission
> during the window. `--no-probe` skips it and says so.

> [!WARNING]
> Mirroring is what makes ciphertexts public as they arrive, timestamped by someone the
> organiser does not control (PROTOCOL.md §5). Leave `MIRROR_REPO`/`MIRROR_TOKEN` unset
> and the server still runs — it logs `[mirror] disabled` and keeps everything locally —
> but you lose the thing that stops an organiser dropping an inconvenient submission
> after seeing the result. Do not run a real event without it.

> [!NOTE]
> **No Pantheon admin token to obtain.** Writing the seat plan back to Pantheon needs an
> account that administers the event. You do not have to find its token and paste it
> here: when an event admin signs in through the ordinary page, the server recognises
> them (Frey `GetOwnedEventIds`), shows them the organiser panel, and captures the token
> the sync needs — stored `0600` in `var/`, never logged, never committed. So the one
> requirement is that **an event admin signs in at some point before the draw**, which
> the organiser does anyway. Confirm your own account qualifies with
> `node tools/check-signin.js --email you@example.com` (step 3b). If you would rather use
> a fixed service account instead, set `PANTHEON_ADMIN_PERSON_ID` and
> `PANTHEON_ADMIN_TOKEN` in `.env` and that wins over the captured one.
> Frey's tokens never expire, so closing the event (§14) deletes the captured one.

**`data/runtime.json`**:

```sh
cp data/runtime.example.json data/runtime.json
```

Set, under `pantheon`: `frey_base_url` and `mimir_base_url` as the server reaches them,
and `frey_public_url` as a **player's phone** reaches Frey — an `https://` address. Under
`server`: `"trust_proxy": true`.

> [!WARNING]
> `frey_public_url` is the address players' browsers call to sign in. A name that only
> resolves on the server (`*.local`, `localhost`, a LAN address) fails on every phone.
> The server warns at boot when it sees one, and `/admin` carries a red row for it.

**If Pantheon runs on this same box** in Docker, its services answer only to their
hostnames, and nothing on a server resolves those until you add them:

```sh
echo '127.0.0.1  mimir.pantheon.local frey.pantheon.local' | sudo tee -a /etc/hosts
getent hosts mimir.pantheon.local        # must print 127.0.0.1
```

Check with `getent`, not `curl`. Even then `frey_public_url` still has to be a public
address: the phone is not on this box.

### 7. TLS and the reverse proxy

nginx will not load a configuration whose certificate file does not exist, and certbot
cannot issue one until nginx answers for the domain on port 80. So: the port-80 half
first, then the certificate, then the full configuration.

```sh
sudo cp deploy/nginx-bootstrap.conf /etc/nginx/sites-available/mahjong   # edit server_name
sudo ln -s /etc/nginx/sites-available/mahjong /etc/nginx/sites-enabled/
sudo mkdir -p /var/www/html && sudo nginx -t && sudo systemctl reload nginx
sudo certbot certonly --webroot -w /var/www/html -d <your domain>
sudo cp deploy/nginx.conf /etc/nginx/sites-available/mahjong             # edit: see below
sudo nginx -t && sudo systemctl reload nginx
sudo certbot renew --dry-run --deploy-hook 'systemctl reload nginx'
```

Edit in `deploy/nginx.conf` before the second `cp`:

- every `example.com` → your domain (three places: `server_name` twice, the certificate
  paths);
- in the `Content-Security-Policy` line, add your `frey_public_url` origin to
  `connect-src`, for example `connect-src 'self' https://userapi.example.org
  https://api.drand.sh ...`. Without it the browser blocks sign-in before any request
  leaves the phone, and no log anywhere shows it.

> [!NOTE]
> The file already sets `X-Forwarded-For` and `X-Forwarded-Proto`. Both are required:
> the first gives each player their own rate-limit allowance, the second is how the
> server knows the request came over TLS. A custom nginx configuration must set both.

<details>
<summary><b>Caddy instead of nginx</b> — only on a box where nothing else holds ports 80 and 443</summary>

<br>

```sh
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile     # edit the domain and connect-src
sudo systemctl reload caddy
```

Caddy obtains and renews the certificate itself and sets both forwarded headers.

</details>

### 8. Start it

One process. It serves the page and runs the draw on its own timer; nothing else needs
scheduling.

Pick one:

| | Command | Survives a reboot |
|---|---|---|
| Try it out | `node server/server.js` in a terminal | no |
| Linux, no root | `tmux new -d -s mahjong 'node server/server.js'` | no |
| **Linux, no root (recommended)** | the user unit below | yes |
| Linux, with root | `sudo cp deploy/mahjong-relay.service /etc/systemd/system/ && sudo systemctl enable --now mahjong-relay` — edit its paths first | yes |

The user unit:

```sh
mkdir -p ~/.config/systemd/user
sed "s|@CHECKOUT@|$PWD|g" deploy/mahjong-relay.user.service > ~/.config/systemd/user/mahjong-relay.service
systemctl --user daemon-reload
systemctl --user enable --now mahjong-relay
loginctl enable-linger                                # keep it running after you log out
loginctl show-user "$USER" -p Linger                  # must say Linger=yes
journalctl --user -u mahjong-relay -f                 # the log
```

Whichever you chose, the first lines of the log must include these three, and not the
word STUB:

```
[server] listening on http://127.0.0.1:8080
[server] pantheon: TwirpPantheon
[server] running server/finalise.js every 60s (server.run_finalise)
```

> [!NOTE]
> - If `Linger=no` after `enable-linger`, this box needs an administrator to run
>   `loginctl enable-linger <you>` once; without it the service stops when you log out.
> - Port 8080 taken (common on a box that also runs Pantheon)? Set `PORT` in `.env` and
>   `proxy_pass` in the nginx file to the same number.
> - Stopping: `systemctl --user stop mahjong-relay`, or Ctrl+C. A draw in flight is left
>   to finish.

### 9. Check before you announce

From anywhere:

```sh
curl -s https://<your domain>/api/status | head -c 300      # "phase":"open", 12 slots, submitted_count 0
curl -s https://<your domain>/protocol.json | head -c 300   # the frozen parameters, as tagged
curl -s -X POST https://<your domain>/api/dev-authorize      # must be 404
curl -s -o /dev/null -w '%{http_code}\n' https://<your domain>/admin   # must be 404
```

Then open `https://<your domain>/admin?token=<ADMIN_TOKEN>`. Every row of the pre-flight
panel must be green. The two that make a deployment unfit for a real draw are
**Mirroring to the repository: DISABLED** and **Pantheon adapter is the STUB**.

The panel's mirroring row only says the settings are present. To confirm the token still
writes — tokens expire, and a fine-grained one can lose the repository when an
organisation changes its policy:

```sh
node tools/setup-mirror.js --check       # reads .env, changes nothing
```

Then sign in on the page yourself, with your own Pantheon account. If that fails, on any
machine with Node:

```sh
node tools/check-signin.js --email <your email> --event <id>   # asks for the password, prints nothing secret
node tools/check-signin.js --admin --event <id>                # the sync's credentials, as far as a read can check
```

The first walks the three steps a sign-in takes and says which one failed and what the
page would have shown. The second confirms the admin token is valid and the event
answers; write rights are only proven by the sync itself.

## Part 3 — The event

### 10. Announce

Send the players the announcement the freeze printed (step 4): the address, one number
between 0 and 255, once; that they can close the page as soon as it says sealed; when
the draw happens; the tag and the commit id. One link for everyone — no personal links,
no tokens. They sign in with the Pantheon accounts they already have.

### 11. During the window

Nothing to run. `/admin` lists who has not submitted yet, by name, and the player-facing
page shows the same count. Chase the missing as the cutoff approaches.

> [!WARNING]
> - At least 8 of 12 must submit, or the attempt is void and everyone submits again
>   (§15). The number is frozen; do not negotiate it on the day.
> - A player who is not in the twelve cannot be added mid-window. The honest fix is to
>   void and re-freeze with the right twelve.
> - Keep an eye on the pre-flight panel. A row turning red during the window is worth
>   acting on now, not after the draw.

### 12. The draw

At the cutoff the server fixes and publishes the list of submissions. When the beacon's
target round lands — ten minutes later with the defaults — the draw runs by itself,
within a minute. Then:

1. `/admin` shows the result: `round_used`, R, the seed, the permutation, and the digest
   of `results.json`. The players' page shows the seat plan on its own.
2. `results.json` and `events/` are in the repository (mirroring).
3. The sync panel says the seat plan was written to Pantheon and read back — and
   Pantheon's admin interface shows it.

**If the sync failed**: the draw is still final and `results.json` is authoritative.
Open `results.json`, copy the `pantheon_prescript` field, paste it into the event's
prescript in Pantheon, and apply it with `WIND_SHUFFLE_MODE_PRESCRIPTED`. Any other
wind mode discards most of what the seating template guarantees. **Never re-run the
draw.**

### 13. What a player can check

The result page prints this, filled in. Anyone can do it, from a machine that has never
seen the server:

```sh
git clone <your fork> draw && cd draw
git checkout <tag>                                   # the tag from the announcement
git checkout origin/HEAD -- results.json events/     # written after the freeze, so not inside the tag
node generate.js --verify results.json               # every byte, plus the roll-call against the cutoff snapshot
python3 tools/verify_template.py data/schedule_template.json
```

> [!NOTE]
> The third line fetches what the draw published through mirroring (§6). With mirroring
> off, `results.json` and `events/` exist only on the server, and nobody can check
> anything — which is why `/admin` refuses to call such a deployment ready.

### 14. Close the event

**Before** the next freeze, not after:

```sh
node tools/end-event.js --dry-run     # what it would archive and clear
node tools/end-event.js
```

It archives the attempt — ciphertexts, the cutoff roll, the result, the sync outcome, the
frozen files it ran under — into `events/rounds/<target_round>/`, verifies every digest,
and only then clears `var/` and the live files under `events/`. If the archive does not
verify, nothing is cleared. Stop the server first (`systemctl --user stop mahjong-relay`).

It also deletes `var/admin-credential.json`, the admin token captured at sign-in, which
is never archived or mirrored. Frey's tokens do not expire, so it goes with the event
rather than staying on disk. The next event captures a fresh one.

> [!WARNING]
> Freeze the next event first and this event's `protocol.json` is overwritten before it
> is archived. The tool notices and says so, but the evidence is then incomplete. And
> until this is done, the server refuses to start for the next event rather than serve
> last event's seat plan.

## Part 4 — Reference

### 15. When something goes wrong

**Sign-in.** The page names the failure; this is what each one means and where to look.

| What the player sees | What happened | Where to look |
|---|---|---|
| Pantheon did not recognise that email and password | Frey answered `400 invalid_argument` | It really is the password |
| Pantheon has no account with that email | Frey answered `404 not_found` | The address they signed up with |
| This draw is pointed at the wrong Pantheon address | `bad_route`, or a non-Twirp 404 | `runtime.json` → `pantheon.frey_public_url`, `twirp_path_template` |
| Pantheon could not be reached | The browser got no answer from Frey | CSP `connect-src` (§7), mixed content, DNS, firewall |
| Pantheon returned an error | A 5xx from Frey | Pantheon's own logs |
| That account isn't registered for this event | Frey said yes, this server said no | The account is not in the twelve |
| The draw server could not be reached — this one, not Pantheon | nginx answered 502/504, or nothing answered | Is the server running? Its log (§8), then nginx's error log |
| Too many sign-in attempts from this address | This server answered 429 | `trust_proxy` is not `true` (§6): everyone shares one allowance |
| This page was opened over http | Production, and the proxy did not report https | TLS (§7); `X-Forwarded-Proto` in the proxy config |
| Pantheon accepted the sign-in, but this browser did not keep the session | `GET /api/me` answered 401 right after sign-in | The browser: cookies blocked, a private window |
| The draw server returned an error | A 500 from this server | This server's log, which carries the stack |

Every row but the first two and the not-registered one prints the technical line
underneath, so a player can forward it. `tools/check-signin.js --email` (§9) reproduces
the Pantheon half from any machine.

**Fewer than 8 submissions.** The job declares the attempt void, publishes
`events/void.json` and archives everything under `events/rounds/<target_round>/`.
Nothing is deleted. Then, in order:

1. `node tools/new-round.js --dry-run` — confirms the archive is complete.
2. On your computer: `node tools/pick-round.js --in 72h --write`, then
   `node tools/freeze.js --write --tag <new-name> --push` (§3–§4). Same twelve players.
3. On the server: `git fetch --tags && git checkout <new-name>`, then
   `node tools/new-round.js`. It re-verifies the archive, clears the live submissions and
   opens the new round. It refuses if step 2 has not happened.
4. Tell the players: the new tag, that **all twelve** submit again (old ciphertexts are
   bound to the lapsed round), and where the voided attempt is published.

**drand unreachable at draw time.** Wait. The job retries every minute; the outcome was
fixed at the cutoff and cannot change.

**A drand mirror is down, or Pantheon moved.** Edit `data/runtime.json`, restart the
server. Nothing frozen changes, so no re-tag and no announcement.

**The server died, or `var/` was lost.** Start it again. If the draw was published, it
reconciles from `results.json` and never re-draws or declares the round void. If the
sync was not recorded, the next tick finishes it.

**Nothing is drawing.** The `/admin` row **The draw job has run** says when the timer
last fired. Never: check the log for `[schedule]` lines, and that `server.run_finalise`
is not `false` in `runtime.json`. If you scheduled it yourself instead, the crontab line
is `* * * * * cd ~/mahjong && node server/finalise.js --no-wait >> var/finalise.log 2>&1`.
Do not run both.

### 16. The next event

Close this one (§14), then start again at §1 with a new event id and, in step 4, a new
tag name. On the server, §5's `git fetch --tags && git checkout <tag>` picks up the new
freeze; §6–§8 stay as they are.

### 17. Why it is like this

The reasons are in [`../docs/IMPLEMENTATION_NOTES.md`](../docs/IMPLEMENTATION_NOTES.md):
no root and the user unit (§6n), the install order and why the tag comes first (§6r, §6s),
who runs the draw (§6j), what a stop is allowed to interrupt (§6l, §6m), the finish
procedure (§6o), the hosts entry and the ENOTFOUND message (§6x), the runtime file (§6y),
TLS and what the sign-in page says (§6z). What is frozen and why is
[`../docs/PROTOCOL.md`](../docs/PROTOCOL.md) §4; the trust argument is §9 and §10 there.
