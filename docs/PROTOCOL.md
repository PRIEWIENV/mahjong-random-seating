# Randomised Seating Protocol (tlock edition)

> English · [简体中文](PROTOCOL.zh.md)

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

In **the operator's** repository. Anyone can run this code for their own event, so the commitment is made where that event is run, not where the code is written: `roster.json` and `protocol.json` are gitignored in the source tree and `tools/freeze.js` adds them with `-f`. A developer's test event committed upstream would publish twelve real Pantheon ids and prove nothing to anybody.

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
  "target_round_utc": "2026-09-10T20:10:00Z",
  "submission_cutoff_utc": "2026-09-10T20:00:00Z",
  "reveal_gap_seconds": 600,
  "quorum": 8,
  "total_slots": 12,
  "user_input_max": 255,
  "seed_domain_separation": "mahjong-seating-v1",
  "schedule_template_ref": "data/schedule_template.json@<git tag>",
  "generate_script_ref": "generate.js@<git tag>",
  "generate_final_script_ref": "generate-final.js@<git tag>",
  "final_round": { "enabled": true, "table_assignment": "rank_blocks",
                   "wind_draw": "max_completion_then_uniform" },
  "pantheon": { "wind_shuffle_mode": "WIND_SHUFFLE_MODE_PRESCRIPTED" }
}
```

| field | why it is frozen |
|---|---|
| `drand_chain`, `chain_hash`, `chain_public_key` | Identify the beacon the envelopes are sealed to. Swap the chain and you swap the randomness. |
| `target_round` | When the envelopes open. Moving it earlier opens them early. |
| `target_round_utc` | The same moment as a time, so the interval below can be checked without asking the network. Cross-checked against the chain when the job runs. |
| `submission_cutoff_utc` | The snapshot boundary (§8). Moving it changes who is counted. |
| `reveal_gap_seconds` | How long the roll of who submitted is settled before the key exists, ten minutes by default. Shortening it shrinks the window in which that roll can be published and anchored, and at zero there is no window at all — which is what makes a late submission forgeable (§9). |
| `quorum`, `total_slots` | The rule of §8, fixed before anyone can see who is missing. |
| `user_input_max` | The domain each player draws from, and a byte inside the contribution hash. |
| `seed_domain_separation` | `DOMAIN` in §7. Change it and every hash in the draw changes. |
| `schedule_template_ref`, `generate_script_ref`, `generate_final_script_ref` | Name the tag the other artefacts come from, so the five files commit to each other. |
| `final_round` | Whether there is a twelfth round, and the two rules it is drawn by (§11). Frozen because they are the rules of the competition, and because tagging them before the first game is what stops anybody designing them around standings they have already seen. Absent means an eleven-round event. |
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
    "mimir_service": "mimir.Mimir",
    "event_title": null
  },
  "ui":     { "status_poll_interval_ms": 15000 },
  "server": { "sse_heartbeat_ms": 25000, "session_ttl_days": 30, "rate_limit_per_minute": 30,
              "trust_proxy": false, "run_finalise": true, "finalise_interval_seconds": 60 }
}
```

`trust_proxy` deserves a word, because its default is wrong for the deployment §10 describes and right everywhere else. The rate limit is per source address, and behind a reverse proxy every request arrives from 127.0.0.1 — so the limit becomes one allowance shared by all twelve. Turning it on makes the server read `X-Forwarded-For` instead, taking the rightmost entry, which is the address the proxy itself observed rather than anything a caller can claim. It stays off by default because a server with nothing in front of it would otherwise hand an allowance to every invented address.

The file is optional and so is every key in it; anything absent falls back to the defaults shown, which are the ones compiled into `server/runtime.js`. None of this is a promise to players, and all of it may be changed mid-window without voiding anything — that is the whole point of it being here.

`drand.api` is where beacons are fetched from. `drand.mirrors` is the set the server cross-checks the answer against before it will draw: if two mirrors disagree about the signature for a round, the job stops rather than picking one (§9). Neither field can influence the result, because the chain is pinned by the two frozen fields above.

`pantheon.event_title` is what the page calls this draw. Left null it is read from Mimir at boot and re-read until Mimir answers; set, it wins, which is what a deployment whose server cannot reach Mimir needs. It is on this side of the boundary because it is a label: no value it can take reaches the seed, the roster or the round, and a draw whose title is wrong is a draw with a typo, not a draw that has been steered.

Pantheon admin credentials for the sync are **not** in this file and never in the repository. They are environment variables (`deploy/README.md` §6).

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

**`events/final/lock.json`** and **`final.json`** — the twelfth round's commitment and its result. Both are described in §11, which is where the ordering argument that makes them evidence lives. Neither exists for an eleven-round event.

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
6. **The final round**, for an event that has one (§11). After the eleven rounds are played, the standings and a second drand round are locked and published together — before that round exists — and once it lands the twelfth round's winds are drawn from them. Players are asked to compare one more digest, during the interval, for the same reason as the first time.

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
    mirror_repo,                            // where §5 publishes the evidence, so
                                            // the result page can name it; null if off
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

### The attack this does not stop by itself

The paragraph above is true about *withholding*. It is not true about **adding**, and the difference is the one real weakness in this design.

Suppose one of the twelve agrees with the organiser not to submit. The cutoff passes with eleven ciphertexts. The beacon lands, the organiser decrypts all eleven, and now knows every other contribution and the drand signature. Because `R` is an exclusive-or, the twelfth contribution is a free variable: any value of `R` is reachable by choosing it. And a contribution is `SHA256(DOMAIN ‖ "contrib" ‖ local_id ‖ user_input ‖ client_nonce ‖ client_timestamp)`, where `client_nonce` is sixteen bytes the submitter picks. So they can grind: try nonces, compute the seed each one produces, run the shuffle, and keep the seat plan they like best. Each trial is two hashes and a shuffle. A few minutes of an ordinary machine buys millions of candidate seat plans.

Then the organiser publishes a `snapshot.json` with twelve entries and says the last one arrived just before the cutoff.

This is not a flaw in the timelock. tlock guarantees that nobody can open a ciphertext early; it says nothing about **when a ciphertext was written**. Encrypting to round *N* needs only the chain's public key, which is known from the start, so a ciphertext carries no evidence of its own age. One colluding player and the organiser are therefore enough to choose the outcome outright — not to nudge it.

### What actually binds a submission to a time

Nothing cryptographic. The binding has to come from the record of arrival being **public and fixed before the key exists**, and that needs three things, none of which is the server's word for it.

**An interval.** `submission_cutoff_utc` is `reveal_gap_seconds` earlier than `target_round_utc`, ten minutes by default (§4.1). The two used to be the same instant, which left nowhere to stand: any record of the roll was made at the moment the key became available, so it could not show which came first. The interval is the window in which the roll is settled and the outcome is still unknowable. `config.js` refuses a `protocol.json` where the three fields disagree, and refuses an interval under a minute.

**A timestamp the organiser cannot move.** The roll taken at the cutoff is anchored with OpenTimestamps during that interval. An anchor proves the set existed before a Bitcoin block, which is exactly the claim a forged twelfth submission cannot satisfy: choosing it requires the key, and the key does not exist yet.

The player-facing UI calls this file *the sealed ciphertexts* rather than *the roll* — same file, `events/snapshot.json`, and the same digest. "Roll" is this document's word for it and is not a word a player has to learn in order to compare a string with eleven other people.

**A single published value.** An anchor alone is not enough, because anchoring is cheap and nothing stops an organiser anchoring many candidate rolls during the interval and revealing whichever one suits afterwards. What rules that out is publishing the roll's digest to the players while the interval is open. Twelve people who can compare one short string among themselves are a harder thing to lie to than any single notary, because lying requires showing different people different values and every one of them can check.

The same argument applies to the freeze. A tag that exists only on the organiser's machine is not a commitment; it has to be pushed to a public host before submissions open, its commit id has to travel with the announcement, and it is anchored too.

### What remains true, and what is assumed

With those in place: nothing needs to be trusted about the server for *secrecy* — it holds no key that could open a submission early, and every ciphertext it holds is safe to publish. Nothing needs to be trusted about any player, because at the moment anyone submits every other submission is still sealed.

What is assumed is weaker and should be said plainly: that at least one person other than the organiser looked at the roll during the interval, or kept the anchor. If nobody ever checks, the evidence is still there and still checkable years later — but an attack that nobody looks for is an attack nobody finds. The protocol makes cheating detectable. It cannot make anyone look.


One boundary is not about the draw at all, and is easy to state too weakly. Players sign in with their Pantheon accounts, and this app is not where that credential lives: the browser posts the email and password to Frey directly, and the backend receives only `{person_id, auth_token}` (PANTHEON-INTEGRATION.md §2). No code path here reads a password field.

But `auth_token` is not a session token. Frey derives it as `sha384(password + account_salt)`, returns it, and accepts it thereafter — it does not expire and does not rotate, so it is password-equivalent until the player changes their password. The backend therefore treats it as a secret in transit and nothing more: verified once against Frey, never written to the database, never logged, never echoed. The cookie it issues in exchange is 32 unrelated random bytes stored as a hash, so nothing in `var/` can be turned back into a Pantheon credential.

That leaves the transport as the whole of the protection, for the password on its way to Frey and for the token on its way here. §10's TLS is not a hardening step on top of a working deployment; without it neither of those is protected and the session cookie is not stored by the browser at all.

## 10. Deployment

The app and Pantheon run on the same host, so backend-to-Pantheon calls go over localhost. A small backend process (Node or Python), SQLite for state, a mirroring script holding a GitHub PAT, and a reverse proxy in front terminating TLS — nginx where the host already runs one, which it does when Pantheon shares the box, and Caddy otherwise. Write access to `main` is narrowed to the PAT used by the backend.

One address does not follow that rule. The browser reaches Frey itself, so the URL it is given has to resolve from the player's device rather than from the host; `runtime.json` keeps the two apart as `pantheon.frey_base_url` and `pantheon.frey_public_url`.

## 11. The final round

After the eleven template rounds a twelfth is played. Its **tables are earned** — ranks 1-4 at table one, 5-8 at table two, 9-12 at table three — and only its **winds are drawn**. The fairness argument for drawing them the way this does, including why "everybody gets three of every wind" is the exact target and what the design costs, is in [`docs/seating-design.md`](seating-design.md) and is not repeated here. This section is the mechanism.

The final round is **optional**: an event whose `protocol.json` has no `final_round` block is an eleven-round event, and every file and endpoint below simply does not exist for it.

### 11.1 Three commitments, in this order

The whole of the argument is that each input was fixed before the thing that uses it existed.

**T0 — at the freeze, before anyone plays.** `generate-final.js` is frozen and git-tagged with `generate.js`, `schedule_template.json`, `roster.json` and `protocol.json` (§4.1). `protocol.json` gains `generate_final_script_ref` and a `final_round` block naming the two rules in words:

```
"final_round": {
  "enabled": true,
  "table_assignment": "rank_blocks",
  "wind_draw": "max_completion_then_uniform"
}
```

Both values are pinned to exactly one legal value each, and both are also hard-coded in the script. That duplication is deliberate: `protocol.json` is the file that gets tagged, published and quoted at people, so a reader must be able to see what was committed to without reading JavaScript — and a value that disagreed with the script is fatal at startup rather than silently decorative.

**Timing is the point.** The rules for a round that will not be played for weeks are tagged before the first game, so nobody can design them around standings they have already seen.

**T1 — after the round-robin, before the beacon.** `tools/lock-final.js` fetches the standings, checks them, chooses a future drand round `F`, and writes both into **one** file, `events/final/lock.json`. One file because one file is one digest, one timestamp, and one short string for twelve people to read to each other; two files would be two digests and an argument about which was published first.

Order of operations, and it matters: write locally → offer to the mirror → wait for the push → OpenTimestamp the bytes → mirror the `.ots`. The anchor is best-effort but its failure is **loud**, because it cannot be repaired afterwards: a timestamp made after `F` has been emitted proves nothing about before it, which is the only thing it was ever for.

There is deliberately **no second git tag**. A tag binds code, and the code was bound at T0; the lock binds data that did not exist then. What binds the lock is the mirror's commit history — whose timestamps the organiser does not control — and the OpenTimestamps anchor, which needs no trust in the mirror or in us. This is the same reasoning under which the roll (§9) is mirrored and anchored but not tagged.

**T2 — once `F` lands.** `tools/draw-final.js` waits for the beacon, calls `generateFinal` in process, writes `final.json`, mirrors it, and syncs Pantheon. It does **not** timestamp anything: an anchor made after the beacon adds nothing to one made before it.

**Nobody runs T2.** It contributes nothing of its own — the tables came from a lock published before the beacon existed, the winds from a script frozen before the tournament started, the randomness from a round the lock names — so there is no decision in it and nobody who needs to be present for it. The server runs it on the same timer that runs the first draw (`server/schedule.js`), gated on three file checks and a clock: a lock exists, `final.json` does not, and the beacon is due. That is a timer and not an endpoint, so §9 is as untouched here as it is for the first draw. Expecting an organiser to open a terminal between two rounds of a tournament is how a final round does not happen.

### 11.2 The seed

```
SEP = 0x1F

seed_final = SHA256(
      DOMAIN            utf8, validated to contain no SEP
    ‖ SEP ‖ "final"     ascii — the third label, beside "contrib" and "seed"
    ‖ SEP ‖ R           32 raw bytes, from results.json
    ‖ SEP ‖ signature   raw bytes, hex-decoded, for round F
    ‖ SEP ‖ standings   1 byte each, local_ids in FINISHING order, rank 1 first
    ‖ SEP ‖ local_ids   1 byte each, ascending — who contributed to R
)
```

`R` is reused rather than re-collected. It is already the joint contribution of all twelve, already public, and re-running a submission round for the final would ask twelve people to do work that adds nothing: `F`'s signature is randomness none of them could predict, and folding it into the same `R` gives a value no participant and no organiser can steer.

§7's injectivity argument does **not** carry over as written. There it holds because every field is fixed-width or validated SEP-free, with the single variable-count field last; here two fields may legitimately contain `0x1f` — the signature and the standings. It is restored, at no cost, by pinning both lengths instead:

- `standings` is exactly `total_slots` bytes and is a permutation of the roster's `local_id`s;
- `local_ids` equals `sort(results.participating_local_ids)`, whose length `results.json` already fixes;
- the signature decodes to exactly as many bytes as `results.drand_signature` does — same chain, same curve, same length.

With those three checks every field is fixed-width, so no two distinct inputs produce the same byte string. The separators remain as belt and braces.

### 11.3 The draw

Each template position is short of exactly one wind after eleven rounds; the deficits are **derived from the frozen template** every time and never written down, and the derivation asserts its own shape (each position at `k, k, k, k-1`; each wind short for equally many positions).

For a table, a *seating* is the map from the four players in rank order to the four seat indices `0=E, 1=S, 2=W, 3=N`. The 24 are enumerated in lexicographic order; `optima` is the sub-list completing the most players, in that same order; and the draw is `optima[rng.below(optima.length)]`.

**Exactly one `below()` call per table, tables 1 → 3, off one `Sha256CounterStream(seed_final)`, and nothing else reads that stream.** Per-table optimisation is globally optimal and per-table uniformity is globally uniform: the three tables partition the twelve players with no constraint crossing a table, so the global optima are the Cartesian product of the per-table optima, and drawing independently and uniformly from each factor is exactly the uniform distribution on the product.

The enumeration order is part of the result, because what is published is an *index* into it. A reimplementation that enumerated differently would agree on the seed and disagree on the seats — which throws nothing anywhere. It is pinned in `test/final-vectors.json`, printed in `seating-design.md`, and checked by `tools/freeze.js` before the tag is made.

### 11.4 Files

**`events/final/lock.json`** (T1, mirrored and anchored, `.ots` beside it)
```
{ "event": "final", "locked_at": "...",
  "target_round": 32200000, "target_round_utc": "...",
  "chain_hash": "...", "chain_public_key": "...",
  "results_sha256": "...", "results_round_used": 123456, "R": "...",
  "standings": [7,2,11,4,9,1,12,5,3,10,8,6],
  "standings_detail": [ { "rank": 1, "local_id": 7, "person_id": 41, "table": 1,
                          "rating": 1500, "chips": 8, "avg_place": 2.1,
                          "avg_score": 4200, "games_played": 11 }, ... ],
  "order_by": "rating", "order": "desc", "ties": [ ... ],
  "generate_final_script_ref": "generate-final.js@<tag>" }
```
`standings` is the load-bearing field: local ids in finishing order, and the only thing that decides who sits at which table. `standings_detail` is what a reader checks it against.

**`final.json`** (T2, beside `results.json`, never inside it)
```
{ "final_round": 12, "round_used": 32200000, "drand_signature": "...",
  "results_sha256": "...", "lock_sha256": "...",
  "standings": [ ... ], "R": "...", "seed": "<sha256 hex>",
  "deficient_winds": { "1": "E", ... },
  "tables": [ { "table": 1, "players": [7,2,11,4], "deficiencies": ["W","N","N","W"],
                "completed": 2, "optima_count": 8, "optimum_index": 5,
                "assignment": [2,1,3,0] }, ... ],
  "completed_local_ids": [ ... ], "completed_count": 8,
  "seating": { ... one round, seats carry `rank`, not `point` ... },
  "pantheon_prescript": "... all twelve blocks ...",
  "pantheon_prescript_final": "... the twelfth block alone ...",
  "pantheon_next_session_index": 12 }
```

**`events/final/sync.json`** (T2) — the Pantheon outcome, in the shape `events/sync.json` uses.

`results.json` is never rewritten. It is the published artefact of the first draw and it reproduces byte for byte (§4.3); appending a round to it would break that for the sake of tidiness. The twelfth round lives beside it, and `/api/result` serves them as `seating` and `final` respectively for the same reason.

### 11.5 Standings, ties and refusals

The standings come from Mimir's `GetRatingTable`, which has **no rank field** — the rank is the position in the list (PANTHEON-INTEGRATION.md §5). Which column the league ranks on is operational and lives in `runtime.json`; the *rule* — ranks 1-4 at table one — is frozen.

`tools/lock-final.js` refuses to write anything unless:

1. `results.json` exists and reproduces from its own payloads;
2. the twelve in the standings are exactly the twelve in the frozen roster;
3. every one of them has played all eleven games;
4. the order the server returned is the order re-deriving it locally on the same key produces — which is what makes an `order_by` this project has never verified safe to depend on: if Mimir ignored it, the two orders differ and nothing is written;
5. `F` is at least 60 seconds away and after `results.round_used`;
6. no tie crosses a band boundary without a human naming the rule that settles it.

**Ties.** Inside a band a tie changes nobody's table — the same four people sit together either way, and all that moves is a byte of the seed, which is fixed before the beacon and so cannot be polished against a result. It is recorded and allowed. **Across** a band boundary it decides a table, and the tool refuses: it never breaks a tie and never breaks one silently. Settling it means applying the league's own rule at the source and then recording that rule in the published lock:

```sh
node tools/lock-final.js --tiebreak 4 --tiebreak-reason "league rule 6b: more chips" --confirm
```

Either rank on the boundary names it. Acknowledging a tie does not reorder anybody; if the order shown is not what the league's rule gives, the standings are wrong at the source and that is where it is fixed.

### 11.6 Substitutes

A seat in this event is a `local_id`, not a person. The schedule template, the deficient wind, the opponents and the Pantheon prescript are all written in local ids, and Mimir resolves a local id to whoever holds it. That is what makes a substitute possible at all, and it decides the shape of the rule.

`final_round.substitutes` is **frozen**, because a league that decides how substitutes are handled *after* somebody has dropped out is deciding it with the standings in view. Two values:

- **`"same_registration"`** — the substitute plays on the seat's existing Pantheon registration. Mimir still reports twelve players with eleven games each, so the standings, the bands, the seed bytes and the prescript are all exactly what they would have been. Nothing about the draw changes.
- **`"forbidden"`** — no substitutes. A seat that loses its player has no final round, and the league has to say in advance what happens instead.

**Why only these two.** Every alternative registers the substitute as a thirteenth person. Mimir builds the rating table from *played games* (verified against a live instance), so the departed player and the substitute then appear as two rows, each with a partial record — thirteen rows for twelve seats. Ranking the seat from those means inventing an arithmetic for merging two partial records, and that arithmetic would decide a table. `same_registration` needs none. That is also why the declaration may be written late without becoming a lever: **it is a record, not an input.**

**The record.** `data/substitutes.json` names, for each substitution, the seat, the round from which the substitute played, who left, who took over, the league rule that allows it, and when it was declared. It is not frozen — it cannot be, since a player drops out weeks after the tag is made — and it is validated on load:

- the seat is one in the frozen roster;
- `outgoing.person_id` **equals** the roster's `person_id` for that seat. If it does not, the registration really did change hands, the standings now hold two partial rows for one seat, and every count in `tools/lock-final.js` would be wrong *silently*, because both rows look like ordinary rows;
- `from_round` is a round that exists;
- a reason is given, naming the rule. A substitution with no stated rule behind it is the thing this file exists to make impossible;
- the frozen policy allows them at all. If `protocol.json` says `"forbidden"`, the frozen rule wins and nothing loads.

`tools/lock-final.js` prints the substitutions before it writes anything, marks the affected seats in the standings it shows, and copies the record into `events/final/lock.json` — so it falls under the same digest and the same OpenTimestamps anchor as the standings, and cannot be revised afterwards. `/api/result` serves the **lock's** copy once a lock exists rather than the live file, so the page can never show a record that differs from the one under the fingerprint people were asked to compare.

`tools/freeze.js` refuses to tag an event whose `substitutes.json` already declares something: at freeze time nobody has played a game, so there is nothing yet to substitute into. The likely cause is the file surviving from the previous event, and `tools/end-event.js` is what prevents that — it archives the record with the round and clears it, so it cannot follow the checkout into the next tournament.

### 11.7 Re-locking, and what may never be redone

`--relock --reason "…"` replaces a published lock, and only while `final.json` does not exist. The superseded lock is moved to `events/final/lock.<n>.json` rather than overwritten — it was published too — and the new lock names where its predecessor went.

`tools/draw-final.js` is idempotent in the strong sense: an existing `final.json` is re-verified, re-mirrored and re-synced, and never recomputed. "Recompute" and "redraw" are indistinguishable from outside, and the second is the one thing nobody should be able to do. A `final.json` that does not reproduce from the lock and `results.json` is **kept**, not overwritten, and the tool stops.

Closing an event (`tools/end-event.js`) refuses while a lock exists without a `final.json` beside it. Everything else about that state looks finished — `results.json` is on disk, the phase is `done` — so without this refusal one routine command would delete a published, timestamped commitment, which from the outside is indistinguishable from withdrawing it. `--abandon` is the way past, and it says on the record that the final round was given up on.

### 11.8 Phase

`phase` stays `done` through all three states of the final round. It is not a fourth phase and must not become one: everything that branches on it — the submission gate, the finalisation job's refusals, `resetForNewRound`, `endEvent` — is about the **first** draw and has to go on answering exactly as it did. `/api/status` carries `final.state` (`none` | `locked` | `drawn`) instead, and that is what the page watches.
