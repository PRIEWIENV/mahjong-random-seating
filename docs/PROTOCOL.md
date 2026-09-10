# Randomised Seating Protocol (tlock edition)

Implementation specification. Once agreed, four artefacts — `protocol.json`, `roster.json`, `schedule_template.json` and `generate.js` — are frozen together and git-tagged **before** submissions open. After the freeze, changing a single byte of any of them invalidates the fairness guarantee and the run must be restarted.

Exactly four, and no more. Operational settings — which drand mirror is reachable today, where Pantheon sits on the host, how long a session cookie lives — are kept out of the freeze on purpose and live in `runtime.json`. §4.1 gives the test that decides which side a parameter falls on, and why drawing that line too generously weakens the freeze rather than strengthening it.

Companion documents: [`PANTHEON-INTEGRATION.md`](PANTHEON-INTEGRATION.md) for the login and seat-plan sync, [`UI-SPEC.md`](UI-SPEC.md) for the player-facing flow, [`seating-design.md`](seating-design.md) for the reasoning behind the template itself.

## 1. Overview

- **Goal.** Twelve known players must be mapped onto the twelve abstract positions of a fixed, provably optimal seating template. The mapping is decided by randomness all of them contribute to, which no single party — including whoever operates the server — can predict or steer.
- **Mechanism.** Timelock encryption (tlock, built on the drand public randomness beacon). Each player signs in, enters one number between 0 and 255, submits, and is finished: no second visit, no tab to keep open, no notion of "phases" exposed to them.
- **Identity.** Players sign in with their existing Pantheon account. Only accounts registered to the configured event can sign in at all.
- **Quorum.** At the target round the draw proceeds if **at least 8 of 12 (two thirds)** have submitted. Below that the round is void and everyone resubmits against a new target round.
- **Output.** The final seat plan is displayed in the app and pushed into Pantheon as the event's prescripted seating.

## 2. Roles

| Party | What they do | What they must be trusted for |
|---|---|---|
| Players (12) | Sign in, enter one number, submit | Nothing |
| Organiser | Freezes the artefacts, runs the server, holds a Pantheon admin account for the sync | Nothing about the draw itself |
| Server (VPS) | Verifies sign-ins, stores ciphertexts, finalises on schedule, syncs to Pantheon | Nothing — every ciphertext it holds is safe to publish |
| Pantheon | Supplies identity and the event roster; receives the final seat plan | Correctly reporting who is registered to the event |
| drand (quicknet) | Publishes the beacon value that opens the envelopes | Liveness at the target round |

## 3. What each player contributes

Each player types an integer in `0 … 255` — a small, human-scale number of the kind people actually enjoy choosing. What gets sealed is not that number on its own but a small payload:

```
{ user_input, client_nonce, client_timestamp }
```

`client_nonce` is 16 bytes from `crypto.getRandomValues`; `client_timestamp` is the browser's ISO-8601 time at the moment of submission. Both are sealed inside the envelope, so both become public at the reveal and every step below is recomputable by anyone.

The player's contribution is the **full, untruncated** 256-bit hash

```
contribution_i = SHA256(DOMAIN ‖ "contrib" ‖ local_id ‖ user_input ‖ client_nonce ‖ client_timestamp)
```

and the combined value is the XOR of all contributions:

```
R = contribution_1 XOR … XOR contribution_n      // 256 bits
```

### 3.1 Why it is built this way

**Hash first, XOR second.** XOR does not mix across bit positions. If contributions were the raw numbers and everybody picked something small — which is what people do — every contribution would have zeros in its high bits, and so would their XOR: the result would be structurally confined to a tiny subspace, no matter how wide the field was declared to be. Hashing spreads any input across all 256 bits, so `7` and `8` produce two unrelated, well-spread values. It also makes entropy *compound*: raw small integers keep their entropy trapped in the low bits, whereas hashed contributions behave like independent uniform values, so twelve people each supplying only a few bits of real choice together saturate the width.

**The nonce carries the entropy the human cannot.** Nobody should be asked to produce 256 bits of randomness by hand, and a player who types `7` should not weaken the draw. With the nonce inside the hash, every contribution is uniformly distributed whatever the player typed. The trust assumption drops from "at least one of twelve humans chose randomly" to "at least one browser's CSPRNG works", which is a far safer thing to rely on. The player's own choice still provably enters the result: the nonce is revealed with everything else, so anyone can recompute `SHA256(… ‖ user_input ‖ client_nonce ‖ …)` and confirm that this player's number is in there.

**The timestamp is free variability.** It need not be trustworthy. A client that lies about its clock only alters its own contribution — which it could equally do by typing a different number — so nothing rests on it.

**8 bits is enough for the human part.** Because the hash and the nonce do the work, the size of the typed number no longer bounds the outcome space. A number between 0 and 255 is easy to pick, easy to remember, and easy to check afterwards.

The drand signature for the target round is folded into the seed as well (§7). It is unpredictable before the round and, because BLS signatures are unique for a given round and key, it cannot be ground — not even by a compromised beacon. It costs nothing and means the draw does not rest on the twelve browsers alone.

## 4. Frozen artefacts

Four files are frozen together and git-tagged before submissions open: `roster.json`, `protocol.json`, `schedule_template.json` and `generate.js`.

### 4.1 What belongs in the freeze

One test decides it:

> Could changing this value, after submissions have opened, change the outcome or let somebody steer it?

**Yes** — it is frozen, and it belongs in `protocol.json`. **No** — it is an operational setting, it belongs in `runtime.json`, and that file is deliberately *not* part of the tag.

The split is not tidiness. Freezing something that fails the test makes the run less robust without making it any fairer. If `drand_api` were frozen and that mirror went down during the submission window, the only in-protocol remedy would be to void the round — for an outage that cannot influence the result, because the chain is pinned by `chain_hash` and `chain_public_key` and every beacon signature is checked against that key. And a frozen file the organiser has a legitimate operational reason to edit is a file players will eventually be asked to accept an edit to, which is the exact habit the freeze exists to prevent.

**`roster.json`** — a snapshot of the Pantheon event roster taken at freeze time.
```
{
  "pantheon_event_id": 42,
  "players": [
    { "local_id": 1, "person_id": 1234, "title": "Alice" },
    ... exactly 12 entries
  ]
}
```
`local_id` is Pantheon's per-event player number and is what the seat-plan sync writes back (see `PANTHEON-INTEGRATION.md`). `person_id` is the global Pantheon account id and is what a signed-in session is matched against. Freezing this list means nobody can be added, removed or swapped once submissions are open. `local_id` must be in `1 … 255`, because §7 encodes it as a single byte.

**`protocol.json`** — the frozen parameters, and nothing else.
```
{
  "drand_chain": "quicknet",
  "chain_hash": "<64 hex — the drand quicknet chain hash>",
  "chain_public_key": "<96 or 192 hex — that same chain's group public key>",
  "target_round": 123456,
  "submission_cutoff_utc": "2026-09-10T20:00:00Z",
  "quorum": 8,
  "total_slots": 12,
  "user_input_max": 255,
  "seed_domain_separation": "mahjong-seating-v1",
  "schedule_template_ref": "data/schedule_template.json@<git tag>",
  "generate_script_ref": "generate.js@<git tag>",
  "pantheon": { "wind_shuffle_mode": "WIND_SHUFFLE_MODE_PRESCRIPTED" }
}
```

| field | why it is frozen |
|---|---|
| `drand_chain`, `chain_hash`, `chain_public_key` | Identify the beacon the envelopes are sealed to. Swap the chain and you swap the randomness. |
| `target_round` | When the envelopes open. Moving it earlier opens them early. |
| `submission_cutoff_utc` | The snapshot boundary (§8). Moving it changes who is counted. |
| `quorum`, `total_slots` | The rule of §8, fixed before anyone can see who is missing. |
| `user_input_max` | The domain each player draws from, and a byte inside the contribution hash. |
| `seed_domain_separation` | `DOMAIN` in §7. Change it and every hash in the draw changes. |
| `schedule_template_ref`, `generate_script_ref` | Name the tag the other two artefacts come from, so the four files commit to each other. |
| `pantheon.wind_shuffle_mode` | Any mode but `WIND_SHUFFLE_MODE_PRESCRIPTED` re-randomises winds at the table and throws away most of what the template guarantees (hard rule 5). |

**`chain_public_key` is required, and it is required *in addition to* `chain_hash`, not instead of it.** `drand-client` decides whether it is talking to the right chain in `isValidInfo`, which compares the hash **and** the public key and demands both. Pin only the hash and `publicKey` is `undefined`, the comparison fails against every real chain, and the path of least resistance becomes switching chain verification off — leaving the client trusting whatever the endpoint says it is. Read the key once at freeze time from `<drand api>/<chain_hash>/info` (`runtime.json` → `drand.api`) and record it alongside the hash. It is frozen because it is half of the answer to "which randomness source is this draw bound to".

**`schedule_template.json`** — the reference template on twelve abstract points, already exported and independently re-verified. Its structure and invariants are documented in `seating-design.md`; `tools/verify_template.py` re-derives every one of them from the data.

### 4.2 `runtime.json` — operational, not frozen, not tagged

```
{
  "drand": {
    "api": "https://api.drand.sh",
    "mirrors": ["https://api.drand.sh", "https://api2.drand.sh",
                "https://api3.drand.sh", "https://drand.cloudflare.com"],
    "health_poll_ms": 30000
  },
  "pantheon": {
    "frey_base_url": "http://localhost:4001",
    "mimir_base_url": "http://localhost:4002",
    "twirp_path_template": "/twirp/{service}/{method}",
    "frey_service": "frey.Frey",
    "mimir_service": "mimir.Mimir"
  },
  "ui":     { "status_poll_interval_ms": 15000 },
  "server": { "sse_heartbeat_ms": 25000, "session_ttl_days": 30, "rate_limit_per_minute": 30, "trust_proxy": false }
}
```

`trust_proxy` deserves a word, because its default is wrong for the deployment §10 describes and right everywhere else. The rate limit is per source address, and behind a reverse proxy every request arrives from 127.0.0.1 — so the limit becomes one allowance shared by all twelve. Turning it on makes the server read `X-Forwarded-For` instead, taking the rightmost entry, which is the address the proxy itself observed rather than anything a caller can claim. It stays off by default because a server with nothing in front of it would otherwise hand an allowance to every invented address.

The file is optional and so is every key in it; anything absent falls back to the defaults shown, which are the ones compiled into `server/runtime.js`. None of this is a promise to players, and all of it may be changed mid-window without voiding anything — that is the whole point of it being here.

`drand.api` is where beacons are fetched from. `drand.mirrors` is the set the server cross-checks the answer against before it will draw: if two mirrors disagree about the signature for a round, the job stops rather than picking one (§9). Neither field can influence the result, because the chain is pinned by the two frozen fields above.

Pantheon admin credentials for the sync are **not** in this file and never in the repository. They are environment variables (`deploy/README.md` §2).

To keep the two kinds of setting from drifting back together, the loader **rejects `protocol.json` outright** if it contains any operational key, and names the one it found.

### 4.3 Files written by the run

**Submission record** (`events/submissions/<local_id>.json`, mirrored into the repository as it arrives)
```
{ "local_id": 3, "ciphertext": "<tlock ciphertext>", "received_at": "..." }
```
The ciphertext seals `{user_input, client_nonce, client_timestamp}` (§3). The server stores and mirrors it without being able to read it.
Ciphertexts are safe to publish: nobody can decrypt them, including the organiser, until the target round arrives.

**`events/snapshot.json`** (written at the cutoff, before the beacon exists)
```
{ "cutoff_utc": "...", "taken_at": "...", "local_ids": [1,2,3,...],
  "submissions": [ { "local_id": 1, "ciphertext": "...", "received_at": "..." }, ... ] }
```
The roll of who submitted in time. It is fixed before anybody can know which omission
would be useful, and it is published, which is what lets a verifier check that
`results.json` accounts for every submission rather than only for the ones it chose to
list. It is mirrored **before** `results.json`, so a result is never readable without
the file needed to audit it.

**`results.json`** (written automatically after the draw, exactly once)
```
{
  "round_used": 123456,
  "drand_signature": "...",
  "participating_local_ids": [1,2,3,5,6,7,8,9,10,11,12],
  "excluded_local_ids": [ { "local_id": 4, "reason": "..." } ],
  "revealed": { "1": { "user_input": 7, "client_nonce": "...", "client_timestamp": "..." }, ... },
  "contributions": { "1": "<sha256 hex>", ... },
  "R": "<256-bit hex>",
  "seed": "<sha256 hex>",
  "permutation": [ ... ],
  "seating": { ... 11 rounds, real names ... },
  "pantheon_prescript": "..."
}
```

**Everything in this file is produced by `generate.js`, and nothing else is.** That is
the property `--verify` rests on: it recomputes the whole file and compares every byte,
with no field set aside and therefore no footnote about what was really checked. Two
things that used to live here have moved out for that reason, and the rule they broke is
worth stating, because it is the rule for anything added later:

> A file cannot make a byte-for-byte claim about a value it could not have computed.

- **`excluded_local_ids` stayed, and moved *into* the computation.** A submission that
  would not open is not a contribution (§8), so who was excluded is part of the answer to
  "who took part" and belongs inside the claim. `generate.js` now takes the list as an
  input, validates it (every id in the roster, none of them also a participant, each with
  a reason) and emits it in canonical order.
- **`pantheon_sync` left.** See below.

Note what the byte comparison still cannot do on its own: it recomputes *from* the
payloads this file lists, so a file that omits a player from both `revealed` and
`excluded_local_ids` is self-consistent. `events/snapshot.json` is what closes that, and
`generate.js --verify` performs the check whenever the snapshot is available, saying
plainly when it is not.

**`events/rounds/<target_round>/`** (written when an attempt is declared void, §8)
```
manifest.json     digests of everything below, plus the counts and how to check them
protocol.json     the frozen parameters THAT attempt ran under
roster.json
void.json         the notice as published
snapshot.json     the roll taken at the cutoff
submissions/<local_id>.json
```
Kept so that a voided round can be audited rather than taken on trust, and listed in
`events/rounds/index.json`. See §8.

**`events/sync.json`** (written after the Pantheon sync, which is after the draw)
```
{ "round_used": 123456, "status": "ok", "at": "...", "event_id": 42, "attempts": 1 }
```
The sync outcome is deliberately **not** in `results.json`. It records a network call
carrying a wall-clock timestamp, made after `results.json` already existed, so a
`results.json` containing it would have to describe an event that postdates itself and
could never be recomputed. Keeping it separate is what lets `results.json` be written
once and verified without qualification. `GET /api/result` joins the two back together
for the UI; the files are what a verifier uses.

## 5. End-to-end sequence

1. **Freeze.** Snapshot the Pantheon roster into `roster.json`; choose the drand chain, target round and cutoff; write `protocol.json` — the frozen parameters only, §4.1 — and commit it with `schedule_template.json` and `generate.js`; git-tag. Announce the tag to the players. `runtime.json` is not part of this and is not tagged.
2. **Submission window.** Any time before the cutoff, each player opens the app, signs in with their Pantheon account, enters one number and submits. Their browser seals the number with tlock against the chain and target round from `protocol.json` and posts only the ciphertext.
3. **Waiting.** The app shows a live view: countdown to the target round, drand chain health, and how many of the twelve have submitted. Nothing is required of the player here.
4. **Finalisation.** At `submission_cutoff_utc` the server snapshots the submissions received. With ≥ 8 it waits for drand to publish the signature for `target_round`, decrypts, computes the result and publishes it. With < 8 the round is declared void.
5. **Sync.** The resulting seat plan is written into the Pantheon event as its prescripted seating, and shown to players with next-step instructions.

## 6. Backend API

All endpoints are JSON over HTTPS.

- `POST /api/session` — body `{person_id, auth_token}` obtained by the browser from Pantheon (see `PANTHEON-INTEGRATION.md` §2). The server verifies the pair with Frey `QuickAuthorize`, confirms the person is in the frozen roster, and issues an httpOnly session cookie. **The server never sees a Pantheon password.**
- `GET /api/me` — `{local_id, title, submitted: bool}` for the signed-in player.
- `POST /api/submit` — body `{ciphertext}`. Rejected if the session's slot has already submitted, or the cutoff has passed. Stored and mirrored to the repository.
- `GET /api/status` — public, no session required. Everything the waiting view needs:
  ```
  { phase: "open" | "awaiting_round" | "revealing" | "done" | "void",
    submitted_count, quorum, total_slots,
    submitted_local_ids: [...],            // who, not what
    cutoff_utc, target_round, user_input_max,
    drand: { chain_hash, chain_public_key,  // frozen: what the browser pins the chain with
             api,                           // operational (§4.2): where it is reached
             latest_round, expected_round_at_cutoff, healthy: bool, last_seen_utc },
    frey_base_url, status_poll_interval_ms, // operational (§4.2)
    server_time_utc }                       // so the countdown never drifts

  Every frozen number the app shows a player comes from here, so the page can never
  state a rule other than the one the draw is tagged to.
  ```
- `GET /api/result` — after the draw: the contents of `results.json`, plus the derived per-player statistics the seat-plan explorer renders (see `UI-SPEC.md` §6).
- `GET /api/events` — Server-Sent Events stream pushing `status` changes, so the waiting view updates without polling. Polling `/api/status` is the fallback when the stream drops; the cadence defaults to 15 s and is served in the status payload as `status_poll_interval_ms` (`runtime.json` → `ui`, §4.2) rather than compiled into the bundle.
- **Scheduled job** — not an HTTP endpoint. Runs the finalisation of §5 at the cutoff, then the Pantheon sync.

## 7. `generate.js` specification

```
input:
  decrypted = [(local_id, user_input, client_nonce, client_timestamp), ...]   // n entries, 8 <= n <= 12
  drand_signature                                                             // for target_round

1. sort by local_id ascending                    // XOR is order-independent; this only
                                                 // makes the audit log reproducible
2. contribution_i = SHA256(DOMAIN || "contrib" || local_id || user_input
                                  || client_nonce || client_timestamp)        // 256 bits, untruncated
3. R = contribution_1 XOR ... XOR contribution_n                              // 256 bits
4. seed = SHA256(DOMAIN || "seed" || R || drand_signature || sorted(local_ids))
5. expand seed with a CSPRNG (SHA256 in counter mode) into enough bytes for an
   unbiased Fisher-Yates shuffle, producing a permutation pi of the twelve roster slots
6. map roster slots onto abstract points 0..11 of schedule_template.json by pi
7. substitute real names to obtain the final 11-round seat plan
8. emit results.json (§4) and the Pantheon prescript string (PANTHEON-INTEGRATION.md §3)
```

`DOMAIN` is `seed_domain_separation` from `protocol.json`. Fixing the byte encoding matters as much as the algorithm: `local_id` and `user_input` as single unsigned bytes, `client_timestamp` as its ASCII ISO-8601 form, all fields separated by a byte that cannot occur inside them. Write the encoding down in the implementation and test it against a fixed vector, or two independent re-computations of the same draw will disagree.

Including `sorted(local_ids)` in step 4 removes any ambiguity about who took part when `n < 12`.

Use rejection sampling in step 5, not modulo, so the shuffle is exactly uniform.

## 8. Quorum and failure handling

- `quorum = 8` is frozen with everything else and cannot be adjusted once submissions open — an adjustment made after seeing who is missing is itself a manipulable step. This is the clearest case of the §4.1 test: the value is nothing but a number in a config file, and it is frozen precisely because knowing who is missing would make choosing it a move.
- The loader refuses a quorum at or below half the field. §8 intends a two-thirds rule, and a minority quorum is not one anyone would have agreed to in advance — which is the only moment at which agreeing to it means anything.
- The snapshot is taken at exactly `submission_cutoff_utc`. Anything arriving later does not count, even if the drand round has not landed yet. This removes any argument about late arrivals.
- Falling short of quorum has one pre-agreed remedy: void the round, announce a new `target_round`, and have **all twelve** submit again. Existing ciphertexts are bound to the lapsed round and cannot be reused.
- **A voided attempt is archived, never discarded.** "Fewer than eight submitted" is a claim, and it is exactly the claim an organiser would make who wanted a second try after seeing who had turned up. What makes it a fact is the evidence, so at the moment a round is declared void the job writes `events/rounds/<target_round>/` holding every ciphertext as received, the roll taken at the cutoff, the void notice, **the frozen `protocol.json` and `roster.json` that attempt ran under**, and a `manifest.json` of SHA-256 digests. All of it is mirrored, so it is timestamped by a third party like the ciphertexts themselves.

  The archived `protocol.json` is the load-bearing part. The next attempt overwrites that file with a new `target_round`, and without the copy the archived ciphertexts would name a chain and a round that nothing in the repository records.

  The voided round's beacon lands three seconds later whatever anyone does, so the archive is verifiable by anybody, at leisure:
  ```sh
  node tools/decrypt-submissions.js \
    --dir events/rounds/<target_round>/submissions \
    --protocol events/rounds/<target_round>/protocol.json
  ```
  It opens every archived ciphertext and counts them. `events/rounds/index.json` lists the attempts and the digest of each manifest.
- **Re-freeze first, reset second.** Opening the next attempt is a deliberate operator action (`tools/new-round.js`), and it refuses unless: the round really was declared void, its archive verifies byte for byte, `protocol.json` already names a later `target_round` with a cutoff in the future, and no `results.json` exists. So there is never a moment when the organiser holds an open round with no announced target. Restarting a round that is merely open, because of who has submitted so far, is the manipulable step this rule exists to remove.
- **drand late or unreachable at the target time** is a delay, not a failure. The ciphertexts and the round are unchanged, so the outcome is already determined; re-run the job when the beacon is reachable.
- **A drand mirror going down** is not even a delay. Point `runtime.json` at another one and restart; nothing frozen is touched, because the chain is pinned by `chain_hash` and `chain_public_key` rather than by an address (§4.2).

## 9. Trust boundary

Nothing needs to be trusted about the server: every ciphertext it holds is safe to publish, and it holds no key that could open one early. Nothing needs to be trusted about any player: at the moment anyone submits, every other submission is still sealed, so no one can choose adaptively. The live dependencies are drand's availability at the target round, and Pantheon's answer to "who is registered for this event".

A player who never submits has abstained from an outcome nobody could see yet — an absence, not a manoeuvre. Nobody can withhold a *reveal*, because opening is not an action any participant performs.

One boundary is not about the draw at all, and is easy to state too weakly. Players sign in with their Pantheon accounts, and this app is not where that credential lives: the browser posts the email and password to Frey directly, and the backend receives only `{person_id, auth_token}` (PANTHEON-INTEGRATION.md §2). No code path here reads a password field.

But `auth_token` is not a session token. Frey derives it as `sha384(password + account_salt)`, returns it, and accepts it thereafter — it does not expire and does not rotate, so it is password-equivalent until the player changes their password. The backend therefore treats it as a secret in transit and nothing more: verified once against Frey, never written to the database, never logged, never echoed. The cookie it issues in exchange is 32 unrelated random bytes stored as a hash, so nothing in `var/` can be turned back into a Pantheon credential.

That leaves the transport as the whole of the protection, for the password on its way to Frey and for the token on its way here. §10's TLS is not a hardening step on top of a working deployment; without it neither of those is protected and the session cookie is not stored by the browser at all.

## 10. Deployment

The app and Pantheon run on the same host, so backend-to-Pantheon calls go over localhost. A small backend process (Node or Python), SQLite for state, a mirroring script holding a GitHub PAT, and a reverse proxy in front terminating TLS — nginx where the host already runs one, which it does when Pantheon shares the box, and Caddy otherwise. Write access to `main` is narrowed to the PAT used by the backend.

One address does not follow that rule. The browser reaches Frey itself, so the URL it is given has to resolve from the player's device rather than from the host; `runtime.json` keeps the two apart as `pantheon.frey_base_url` and `pantheon.frey_public_url`.
