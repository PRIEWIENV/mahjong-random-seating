# Randomised Seating Protocol (tlock edition)

Implementation specification. Once agreed, four artefacts — `protocol.json`, `roster.json`, `schedule_template.json` and `generate.js` — are frozen together and git-tagged **before** submissions open. After the freeze, changing a single byte of any of them invalidates the fairness guarantee and the run must be restarted.

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
`local_id` is Pantheon's per-event player number and is what the seat-plan sync writes back (see `PANTHEON-INTEGRATION.md`). `person_id` is the global Pantheon account id and is what a signed-in session is matched against. Freezing this list means nobody can be added, removed or swapped once submissions are open.

**`protocol.json`**
```
{
  "drand_chain": "quicknet",
  "chain_hash": "<public chain hash of the drand quicknet chain>",
  "drand_api": "https://api.drand.sh",
  "target_round": 123456,
  "submission_cutoff_utc": "2026-09-10T20:00:00Z",
  "quorum": 8,
  "total_slots": 12,
  "user_input_max": 255,
  "seed_domain_separation": "mahjong-seating-v1",
  "schedule_template_ref": "data/schedule_template.json@<git tag>",
  "generate_script_ref": "generate.js@<git tag>"
}
```

**`schedule_template.json`** — the reference template on twelve abstract points, already exported and independently re-verified. Its structure and invariants are documented in `seating-design.md`; `tools/verify_template.py` re-derives every one of them from the data.

**Submission record** (`events/submissions/<local_id>.json`, mirrored into the repository as it arrives)
```
{ "local_id": 3, "ciphertext": "<tlock ciphertext>", "received_at": "..." }
```
The ciphertext seals `{user_input, client_nonce, client_timestamp}` (§3). The server stores and mirrors it without being able to read it.
Ciphertexts are safe to publish: nobody can decrypt them, including the organiser, until the target round arrives.

**`results.json`** (written automatically after the draw)
```
{
  "round_used": 123456,
  "drand_signature": "...",
  "participating_local_ids": [1,2,3,5,6,7,8,9,10,11,12],
  "revealed": { "1": { "user_input": 7, "client_nonce": "...", "client_timestamp": "..." }, ... },
  "contributions": { "1": "<sha256 hex>", ... },
  "R": "<256-bit hex>",
  "seed": "<sha256 hex>",
  "permutation": [ ... ],
  "seating": { ... 11 rounds, real names ... },
  "pantheon_prescript": "...",
  "pantheon_sync": { "status": "ok", "at": "..." }
}
```

## 5. End-to-end sequence

1. **Freeze.** Snapshot the Pantheon roster into `roster.json`; choose the drand chain, target round and cutoff; write `protocol.json`; commit with `schedule_template.json` and `generate.js`; git-tag. Announce the tag to the players.
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
    cutoff_utc, target_round,
    drand: { latest_round, expected_round_at_cutoff, healthy: bool, last_seen_utc },
    server_time_utc }                       // so the countdown never drifts
  ```
- `GET /api/result` — after the draw: the contents of `results.json`, plus the derived per-player statistics the seat-plan explorer renders (see `UI-SPEC.md` §6).
- `GET /api/events` — Server-Sent Events stream pushing `status` changes, so the waiting view updates without polling. Polling `/api/status` every 15 s is the fallback when the stream drops.
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

- `quorum = 8` is frozen with everything else and cannot be adjusted once submissions open — an adjustment made after seeing who is missing is itself a manipulable step.
- The snapshot is taken at exactly `submission_cutoff_utc`. Anything arriving later does not count, even if the drand round has not landed yet. This removes any argument about late arrivals.
- Falling short of quorum has one pre-agreed remedy: void the round, announce a new `target_round`, and have **all twelve** submit again. Existing ciphertexts are bound to the lapsed round and cannot be reused.
- **drand late or unreachable at the target time** is a delay, not a failure. The ciphertexts and the round are unchanged, so the outcome is already determined; re-run the job when the beacon is reachable.

## 9. Trust boundary

Nothing needs to be trusted about the server: every ciphertext it holds is safe to publish, and it holds no key that could open one early. Nothing needs to be trusted about any player: at the moment anyone submits, every other submission is still sealed, so no one can choose adaptively. The live dependencies are drand's availability at the target round, and Pantheon's answer to "who is registered for this event".

A player who never submits has abstained from an outcome nobody could see yet — an absence, not a manoeuvre. Nobody can withhold a *reveal*, because opening is not an action any participant performs.

## 10. Deployment

The app and Pantheon run on the same host, so backend-to-Pantheon calls go over localhost. A small backend process (Node or Python), SQLite for state, a mirroring script holding a GitHub PAT, and Caddy in front for reverse proxying and automatic TLS. Write access to `main` is narrowed to the PAT used by the backend.
