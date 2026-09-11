# Implementation notes

> English · [简体中文](IMPLEMENTATION_NOTES.zh.md)

Everything the implementation had to decide that the specification does not settle,
plus the places where following one rule literally would have broken another.

**Read this before the freeze.** Items 1 and 2 decide what goes into `protocol.json`
and what is verified, so they have to be settled before RUNBOOK step 11, not after.

---

## 1. `chain_public_key`, and where the freeze line actually falls

**Both halves of this are now in the specification** — `chain_public_key` is listed in
`PROTOCOL.md` §4, and §4.1/§4.2 draw the frozen/operational boundary. This note records
why, because the reasoning is not obvious from the field list alone.

### 1a. The hash alone verifies nothing

§4 originally listed `chain_hash` and no public key. That is not enough to verify
anything. `drand-client` checks the two together:

```js
// node_modules/drand-client/http-caching-chain.js
function isValidInfo(chainInfo, validParams) {
  return chainInfo.hash === validParams.chainHash && chainInfo.public_key === validParams.publicKey;
}
```

Pass only `chainHash` and `validParams.publicKey` is `undefined`, so the comparison
fails against every real chain. The trap is what happens next: the error looks like a
misconfiguration, and the obvious fix is to drop `chainVerificationParams` altogether —
which silently turns chain verification off. At that point a hostile or merely wrong
`drand_api` could serve a fabricated chain and both the browser and the finalisation
job would believe it.

So `protocol.json` carries `chain_public_key`, `server/config.js` refuses to start
without it (and refuses a 64-character value, which is the shape of a chain hash rather
than a group key), and both `server/tlock.js` and `client/seal.js` pin both values. For
quicknet, verified against `https://api.drand.sh/<chain_hash>/info` on 2026-09-09:

```
chain_hash       52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971
chain_public_key 83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a
scheme           bls-unchained-g1-rfc9380      period 3s
```

`tools/pick-round.js --in 72h --write` fills all of it in, and sets `target_round` and
`submission_cutoff_utc` together so they cannot disagree. It no longer carries its own
copy of the quicknet hash: the chain is whatever `protocol.json` is frozen to, and a
second copy in a tool is a second place for it to be wrong.

### 1b. The same argument says `drand_api` must **not** be frozen

Pinning the hash and the key is exactly what makes the endpoint safe to leave loose. A
swapped or hostile `drand_api` cannot substitute a chain — `isValidInfo` rejects it — so
it can only fail loudly. Which means it fails the test that decides the freeze:

> Could changing this value, after submissions have opened, change the outcome or let
> somebody steer it?

Freezing it anyway would have made the run strictly worse. A drand mirror going down
mid-window is an ordinary operational event with no bearing on the result, and under a
frozen `drand_api` the only in-protocol remedy would have been to void the round. Worse,
the realistic outcome is not a voided round: it is the organiser editing a tagged file
and telling everyone it was fine — which is the precise habit the freeze exists to
prevent. A freeze that covers things people have good reason to change teaches everyone
that frozen files get changed.

**Resolution.** `protocol.json` holds only what could change or steer the outcome.
Everything else moved to `data/runtime.json` (`server/runtime.js` holds the defaults,
and the file is optional and gitignored): the drand endpoint and mirror list, the
Pantheon base URLs and Twirp naming, the SSE heartbeat, the status poll interval, the
session TTL, the rate limit. `config.js` **refuses to start** if an operational key
appears in `protocol.json`, and names where it belongs instead — the split is only worth
anything if it cannot quietly erode.

Two knock-on cleanups follow from the same principle, that a frozen value must exist in
exactly one place:

- **Nothing frozen is defaulted in the browser bundle.** `Void.jsx` used to render
  `quorum ?? 8` and `total_slots ?? 12`, `Submit.jsx` and `seal.js` used
  `user_input_max ?? 255`. Those are placeholder copies of tagged values, free to state
  a rule the draw was not actually run under. They now come from `/api/status` or the
  screen does not render.
- **The one-byte bounds come from `generate.js`.** `local_id` in `1..255` and
  `user_input_max <= 255` are consequences of the §7 byte encoding, not preferences, so
  `generate.js` exports `ENCODING_LIMITS` and `config.js` validates against it instead
  of repeating the literals.

## 2. `results.json` holds only what `generate.js` computes

§4 originally put `pantheon_sync` inside `results.json`, while RUNBOOK step A5 asked
that a finished draw be recomputed from `results.json` alone and match byte for byte.
Both cannot hold. The e2e test caught it on its first run, which is exactly what it is
for.

`pantheon_sync` is unreproducible three times over, and the third reason is the one that
settles it:

| | why it cannot be recomputed |
|---|---|
| `at` | a wall-clock timestamp, and `generate.js` may not read the clock |
| `status`, `attempts`, `error` | the outcome of a network call to another system |
| the field itself | it records something that happened **after** `results.json` was written |

A file cannot make a byte-for-byte claim about a value it could not have computed. The
first version of this implementation carved the field out of the comparison and named it
in the output, which was honest but left a verification with a footnote — and a footnote
is the part nobody reads.

**Resolution.** The sync outcome moved to `events/sync.json`. `results.json` is now
written exactly once, before the sync runs, and `--verify` compares every byte of it with
nothing set aside. `GET /api/result` joins results, statistics and sync back together for
the UI, because that is a view rather than an artefact.

`excluded_local_ids` went the other way, and deliberately. A submission that will not
open is not a contribution (item 5), so *who was excluded* is part of the answer to "who
took part" and has to be inside the claim, not annotated onto it. `generate.js` now takes
the list as an input and validates it: every id in the roster, none of them also a
participant, each with a reason, emitted in canonical order with the empty list written
out explicitly so that "nobody was excluded" and "the field was dropped" cannot look
alike.

### 2a. What the byte comparison still cannot see, and what does

`--verify` recomputes **from the payloads the file lists**. So a `results.json` that omits
a player from both `revealed` and `excluded_local_ids` reproduces perfectly. There is a
test that constructs exactly that file and confirms it is self-consistent, because the
limit is worth pinning rather than hoping nobody notices.

`events/snapshot.json` is what closes it. It is written at the cutoff — before the beacon
exists, so before anyone can know which omission would help — and it is mirrored publicly
along with the ciphertexts. Every id in it must appear in exactly one of the two lists:

```
OK    results.json reproduces byte for byte — the whole file, no fields set aside
OK    12 submitted at the cutoff = 10 participating + 2 excluded
```

`--verify` looks for the snapshot beside `results.json` and runs the roll-call
automatically. When it is not there it says so in terms that cannot be mistaken for a
pass, and the e2e run asserts that the check actually happened rather than merely that
the byte comparison did. The finalisation job also mirrors the snapshot **before** the
result, so a reader never finds a published result without the file needed to audit it.

Two independent claims, then, and they should not be conflated:

- **the draw follows from these payloads** — the byte comparison
- **these payloads are everyone who submitted** — the roll-call, plus the fact that every
  ciphertext was published, timestamped by a third party, as it arrived

## 3. Choices §7 leaves open, now pinned

§7 warns that fixing the byte encoding matters as much as fixing the algorithm. What
is pinned, and enforced by validation rather than by convention:

```
SEP = 0x1F

contribution_i = SHA256(DOMAIN ‖SEP‖ "contrib" ‖SEP‖ u8(local_id) ‖SEP‖ u8(user_input)
                        ‖SEP‖ nonce16 ‖SEP‖ ascii(client_timestamp))
R              = XOR of all contributions, 256 bits, untruncated
seed           = SHA256(DOMAIN ‖SEP‖ "seed" ‖SEP‖ R ‖SEP‖ hexdecode(signature)
                        ‖SEP‖ u8(local_id) for each participant, ascending)
```

- **The signature is hex-decoded, not appended as text**, so upper- and lower-case hex
  cannot produce two different seeds from one beacon value.
- **Injectivity is earned, not assumed.** Every field is either fixed-width
  (`local_id`, `user_input`, nonce, `R`) or validated to contain no `0x1F` (`DOMAIN`,
  the timestamp), and the one variable-count field (the local ids) is last. A field
  that could smuggle a separator is *rejected*, not escaped — `seed_domain_separation`
  containing `0x1F` fails at startup, and the timestamp must match a strict ISO-8601
  grammar.
- **CSPRNG:** `block(i) = SHA256(seed ‖ uint32be(i))`, concatenated.
- **Uniform draws:** read 4 bytes big-endian, reject at or above `floor(2³²/n)·n`, then
  take the remainder — §7's "rejection sampling, not modulo".
- **Fisher-Yates:** descending, over the roster's local ids in ascending order.
- **Direction of π:** `permutation[k]` is the **local_id seated on abstract point k**.
  `results.json` says so in a `permutation_note` so no verifier has to guess.
- **Serialisation:** `JSON.stringify(x, null, 2)` plus one trailing newline.

`tools/verify_contribution.py` re-derives all of this **in another language, from the
prose above rather than from `generate.js`**. If the encoding were ambiguous the two
would disagree; they are checked against each other in the unit tests and again in the
e2e run. That is RUNBOOK A5's real content.

## 4. Ciphertexts are checked at submission time, not only at finalisation

§6 has the relay accept ciphertexts blindly, which is correct about what it *can* read
— it cannot decrypt them. But it can read the age recipient stanza, which is plaintext,
and confirm the ciphertext is addressed to the frozen chain and round.

This matters because §8 counts *submissions*, not *valid* submissions. A ciphertext
locked to another round would sit in the snapshot, occupy a quorum slot, and only fail
at finalisation — after the cutoff, when that player can no longer resubmit and the
round may already be short of eight. `server/ciphertext.js` rejects it at the door,
where the fix is a page reload.

## 5. What happens if a submission will not open (§8 is silent)

Item 4 closes the realistic path, but the job still needs a deterministic answer.

**Rule as implemented:** a submission that will not decrypt, or whose payload is
malformed, is not a contribution. It is excluded from `R`, and the quorum is then
re-checked against the number that actually opened. Still ≥ 8, the draw proceeds and
the exclusions are published in `results.json`; below 8, the round is void under §8
like any other quorum failure, and `events/void.json` records which failed and why.

Counting an unopenable blob towards the quorum would let one person force a draw with
garbage. This rule is deterministic and leaves the organiser no discretion, which is
the property §8 cares about.

## 6. A published `results.json` outranks the database, everywhere

`phaseOf` consults `results.json` before anything else. Without that, restoring the
server onto a fresh database after a completed draw reports the round as **void** — an
empty submissions table past the cutoff is indistinguishable from a quorum failure.
Telling players that a finished, published draw was void is the worst wrong answer
available, and RUNBOOK is explicit that `results.json` is authoritative while the SQLite
state is expendable.

Two ways that principle was stated but not actually implemented, both fixed:

- **`phaseOf` checked the persisted phase first.** So the `results.json` guard only
  applied when the database held *no* phase at all. Once anything had written `void`,
  the answer stayed void forever, with the published result sitting right there. The
  file is now checked before the persisted key, which is what the surrounding comment
  always claimed.
- **`run()` did not use `phaseOf` at all.** It read the persisted key directly, so on a
  fresh database the scheduled job walked straight past the guard, snapshotted an empty
  submissions table, found it below quorum and **published `events/void.json` over a
  completed draw** — mirroring it to the repository in the process. The job runs every
  minute, so this needed only one lost `var/` to happen on its own.
  `run()` now derives its state through `phaseOf` and reconciles the database with the
  file. `test/resume.test.js` pins it.

## 6a. The sync is the one step allowed to be outstanding after the draw

The sync runs after `results.json` is published and after the phase is already `done`,
so a crash or a restart in between left it undone with nothing to pick it up. Now that
the outcome has its own file (item 2), "did it run?" is a question with an answer on
disk, and the timer resumes it: writing the prescript and reading it back is idempotent
and cannot touch the draw.

It resumes **only when no outcome was ever recorded**. A recorded failure is a completed
attempt carrying a documented manual remedy (RUNBOOK step 15); re-running it every five
minutes forever would bury that remedy under mirror noise and fight an operator who has
already pasted the prescript in by hand.

## 6b. §8's remedy needed code that did not exist

§8 says a voided round is followed by a new `target_round` and a fresh set of
submissions. Nothing implemented that, and the gap was not cosmetic. Probing the state
after a void and a re-freeze:

```
phaseOf says: void
phaseOf on a FRESH database: void
old submissions still counted: 1,2,3,4,5,6,7
player 1 resubmitting -> {"stored":false,"reason":"already_submitted"}
```

Three independent dead ends: players saw "void" forever, ciphertexts bound to the lapsed
round still counted towards the new quorum, and nobody could submit again.

**Resolution.** A run is now a sequence of attempts. `server/rounds.js` archives an
attempt at the moment it is declared void, and `tools/new-round.js` opens the next one.

The archive is the point, not the reset. "Fewer than eight submitted" is a claim, and it
is exactly the claim an organiser would make who wanted another go after seeing who had
turned up. So the evidence is published rather than cleared: every ciphertext as
received, the roll taken at the cutoff, the notice, and **the `protocol.json` and
`roster.json` that attempt ran under**, with a `manifest.json` of SHA-256 digests, all
mirrored so a third party timestamps it.

Archiving `protocol.json` is the part that makes the rest usable. The next attempt
overwrites it with a new `target_round`; without the copy, the archived ciphertexts would
name a chain and round the repository no longer records anywhere, and the evidence would
be unopenable. The voided round's beacon lands three seconds later regardless, so
`tools/decrypt-submissions.js` pointed at the archive opens every ciphertext and counts
them — the void becomes checkable rather than trusted.

The reset is deliberately hard to misuse. It refuses unless the round was actually
declared void, its archive verifies byte for byte, `protocol.json` already names a later
round with a future cutoff, and no `results.json` exists. Re-freeze first, reset second,
so there is never an open round with no announced target. Restarting a round that is
merely *open*, because of who has submitted so far, is the manipulable step §8 exists to
remove, and the reset will not do it.

## 6c. The operational half: a dashboard and a freeze command

RUNBOOK sections B, C and D were prose, and three of their steps had nothing to perform
them on. Step 13 says to chase whoever has not sealed a number; step 15 says to confirm
the sync took; PANTHEON-INTEGRATION.md §4 says a failed sync should be "surfaced in the
admin view" — of which there was none. The freeze itself was a dozen manual actions
performed once, under time pressure, on the day.

**`server/admin.js`** is the dashboard, at `/admin`, gated by `ADMIN_TOKEN`. Two
decisions shape it:

- **Read-only.** §9 keeps the finalisation job off HTTP so that nothing an outsider can
  poke may trigger, retry or re-time the draw. A button here would give that away for a
  convenience nobody needs: the organiser is already on the box when they run
  `tools/new-round.js`. Non-GET methods answer 405, and there is a test that says so.
- **Not part of the frozen bundle.** `public/app.js` is hash-pinned because it handles a
  player's plaintext number. Nothing here does, and folding it in would change the frozen
  hash for a reason unrelated to the draw. So it is one server-rendered string with no
  build step and no dependency.

It shows *when* each player submitted and never *what* — the same rule as everywhere
else, and this is the easiest place in the codebase to break it by accident, being the
one screen whose job is to show the organiser more than a player sees. There is a test
that takes every ciphertext in the database and asserts none of them appears in the page
or in `/admin/data.json`.

The pre-flight panel uses three levels rather than two, because the two states that
matter most are neither green nor red on their own: running against the stub, or with
mirroring off, is correct on a laptop and catastrophic in production. A first draft
rendered "ok" next to a detail line reading "STUB — authorises anyone the stub knows",
which is worse than no row at all.

**`tools/freeze.js`** is RUNBOOK steps 8-11 as one command. It reads the roster back out
of Pantheon and refuses to freeze anything that would only surface later: a seated count
that is not `total_slots`, a player with no usable `local_id`, one account registered
twice. The `local_id` case is the sharpest — it blocks the seat-plan sync, and the sync
runs after the draw, when nothing can be changed.

It also runs the checks that were previously left to memory: the template's proved
invariants re-derived, the browser bundle **rebuilt from source and diffed** against the
committed one, and the unit tests. The rebuild has to happen at freeze time and nowhere
else: it needs esbuild, which the VPS does not have, so the VPS runs `--verify-hash`,
which compares the committed bundle to its committed hash and therefore cannot tell you
that hash was computed from different source.

Nothing touches git unless `--tag <name>` is passed. Without it the command prints the
`git add` and `git tag` lines and exits.

## 6d. The bytes in a checkout were not the bytes that were committed

Found while testing `tools/freeze.js` in a throwaway clone: `build-client.js --check`
failed there and passed in the working tree, on identical source.

| | bytes | CR | digest |
|---|---|---|---|
| the git blob | 347717 | 0 | `52c9ed…` (matches `app.js.sha256`) |
| a fresh clone's checkout | 347738 | 21 | `89fd10…` |

`core.autocrlf=true` — the Windows default — rewrites line endings on checkout. The
repository had no `.gitattributes`, so every byte-pinned artefact came out of a clone
with different bytes and therefore a different digest.

This is not cosmetic. `--verify-hash` is the command `deploy/README.md` has the VPS run,
and it is what a participant runs to confirm that the code which handled their number is
the code that was tagged. On a fresh Windows clone it failed, and a failure there reads
as tampering rather than as a line-ending setting. The digests the admin dashboard shows
for `protocol.json`, `roster.json` and `generate.js` had the same problem.

**Resolution.** `.gitattributes` sets `* text=auto eol=lf` and marks the byte-pinned
artefacts `-text`, which switches off translation entirely so no local `core.autocrlf`
can reintroduce it. Verified by re-cloning: 347717 bytes, no CR, digest matches.
`test/checkout.test.js` guards it — it asserts the rules exist, that the committed bundle
hashes to its committed digest, and that no byte-pinned artefact contains a CR.

The general lesson is worth keeping: a reproducibility claim that has never been checked
from a fresh clone has not been checked. Every verification in this project passed in the
tree where the files were written, which is the one place the bug could not appear. So
that check is now somebody's job rather than nobody's:
`.github/workflows/reproducibility.yml` runs `--verify-hash`, `--check`, the template
invariants and the unit tests on a fresh clone, on Linux and on Windows with
`core.autocrlf=true` restored on purpose. Removing `.gitattributes` on that branch
reproduces the failure exactly — 347738 bytes, 21 CRs, digest `89fd10…`, two red tests —
which is what makes the job worth the minute it costs.

## 6e. Rehearsing the half a person performs

Section A of the RUNBOOK had `test/e2e.js`. Sections B, C and D — snapshot the roster,
pick the round, freeze, tag, chase the stragglers, confirm the draw ran and the sync took
— had nothing, and they are the half performed by a person, once, under time pressure, on
the day. `tools/rehearse.js` performs them: a throwaway git repository built from the
working tree, the Pantheon stub pointed at a registration list the repository has not
seen, and a real drand round four minutes out. The commands are the real commands, the
server is its own process, the sealing is real tlock, the finalisation job runs separately
the way cron runs it, and the commit and the tag are real.

It found two things on its first two passes, both in the step that matters most:

- **`tools/freeze.js` could not perform step 10 at all.** Writing `data/roster.json` out
  of Pantheon is what that step is, and the command loaded the full configuration first —
  which requires a valid `data/roster.json`. On a first freeze it stopped at *copy the
  .example file, fill it in*: twelve rows of retyping, which is the thing the tool exists
  to remove, at the moment when a typo in a `person_id` locks somebody out of the draw.
  `load({ rosterOptional: true })` is now the one exception, and it is only for this
  command; everything else still treats an absent roster as a startup failure.
- **A refused freeze wrote the roster anyway.** `snapshotRoster` reports what is wrong
  with the registrations and still returns what it read, so the refusal printed in red
  while `data/roster.json` appeared on disk, built from the registration list that had
  just been refused. The next run would have found a file where there had been none and
  compared against that.

Both are the same shape as the CRLF bug in §6d: a step that had only ever been performed
by the person who wrote it, in the one arrangement where it works. The order of the steps
was wrong in the RUNBOOK too — the freeze refuses a `target_round` of 0, so picking the
round has to come first, and it was written second.

What the rehearsal does not cover is what §7 covers: Pantheon is the stub, no browser
drives the frozen bundle, and mirroring is off. It asserts that the dashboard says so.

## 6f. The Pantheon client, against a real Pantheon

§7 used to say the Twirp client had never met the thing it was written for. It has now:
Pantheon `cdda3fc` in Docker under WSL 2, driven through `server/pantheon.js` itself
rather than through curl.

Six of its assumptions were wrong. Not one of them announced itself:

| | Written | Actual |
|---|---|---|
| Path | `/twirp/{service}/{method}` | `/v2/{service}/{method}` |
| Service | `frey.Frey`, `mimir.Mimir` | `common.Frey`, `common.Mimir` |
| Ports | Frey 4001, Mimir 4002 | Mimir 4001, Frey 4004 |
| Responses | snake_case | lowerCamelCase |
| Bad password | `{auth_success: false}` | HTTP 400 `invalid_argument` |
| Admin scope | two headers | three — `X-Current-Event-Id` too |

The interesting ones are the last three.

**Every response field came back undefined.** Protobuf JSON emits lowerCamelCase, so
`p.local_id` was always `undefined` on a roster where every player had a local id. The
failure mode was survivable — `tools/freeze.js` would have refused to freeze a roster
where nobody had one — but only because that refusal exists. The same bug in
`getPrescript` would have read `next_session_index` as 0 and quietly rewritten session 1.

**The sign-in gate was answering the wrong question.** Frey does not report a bad
credential pair as `false`; it throws 400 `invalid_argument` "Password check failed".
`server/server.js` catches an exception from `verifyToken` and returns **503 "Cannot
reach Pantheon right now"**. So every mistyped password would have told twelve players
that the server was broken, on the one day they all sign in at once, and UI-SPEC §3's
requirement that the two refusals be distinguishable was silently unmet. Refusal statuses
now read as refusals; 5xx and 429 still throw.

**And `return true` was the default.** The old client, finding neither `authorized` nor
`success` in the response, returned true. Against this Frey that is unreachable — a bad
token never yields a 200 — but it is one deployment away from authorising everybody. The
rule that replaced it comes from the protobuf JSON mapping rather than from guesswork: a
bool that is true is always serialised and a false one is always omitted, so
`authSuccess === true` is the whole test and an unreadable body is a refusal.

Getting an instance up to find this out took about an hour, and five of the obstacles are
recorded in PANTHEON-INTEGRATION.md §6 because none of them are in Pantheon's
documentation. The sharpest: `CreateEvent` accepts `is_prescripted: true` on a club
event, reports success, stores the wind shuffle mode faithfully, and sets
`is_prescripted = 0` — only tournaments can be prescripted. The single visible symptom is
that the roster comes back with no local ids.

## 7. The Pantheon boundary, and what is *not* verified

Everything the app needs from Pantheon goes through one interface in
`server/pantheon.js`, with two implementations:

- **`TwirpPantheon`** — the real client, written from the method names and message
  shapes in `PANTHEON-INTEGRATION.md` §5.
- **`StubPantheon`** — an in-process fake with the same contract, which is what the
  tests and `PANTHEON_MODE=stub` use.

> **This section predates §6f, which supersedes its first paragraph.** `TwirpPantheon`
> has since been run against a real Pantheon (`cdda3fc`, Docker under WSL 2), and
> RUNBOOK steps A2, A3 and A6 pass against it — including reading the prescript back and
> comparing the seating wind by wind, which is the check
> `PANTHEON-INTEGRATION.md` calls most likely to be silently wrong. Six of the client's
> assumptions were wrong and none announced itself; §6f lists them.
>
> What remains outstanding is narrower and is **not** closed by that: **the instance you
> actually deploy against**. §5.1 of `PANTHEON-INTEGRATION.md` is a fact about one
> commit of one deployment, and Pantheon moves.

What this means in practice: the Twirp path template, service names and base URLs are
all configurable (`runtime.json` → `pantheon`, since where Pantheon lives cannot affect
the draw), so drift is a config change rather than a code change — which is exactly what
§6f's six corrections turned out to need. What the sync is allowed to *write* stays
frozen: `wind_shuffle_mode` is in `protocol.json`, because any other value silently
discards most of what the template guarantees.

`config.js` refuses to start if `wind_shuffle_mode` is anything but
`WIND_SHUFFLE_MODE_PRESCRIPTED`, since any other value silently discards the wind and
upstream/downstream balance the template was optimised for.

## 8. A development-only sign-in path

§2 has the browser authenticate against Frey directly, so this app never handles a
Pantheon password. That is the real path and it is unchanged.

With no Frey reachable, the sign-in stage could not be built or exercised at all, so
the stub exposes `POST /api/dev-authorize`, which resolves a `person_id` to the stub's
token. It exists **only** when the Pantheon adapter is the stub, and returns 404 under
`NODE_ENV=production` — a password-accepting endpoint on the real deployment is
precisely what §2 is written to prevent. There is a test asserting it is absent in
production.

## 9. Smaller decisions

- **The browser bundle is vendored, not from a CDN.** The submission stage is the one
  place a player's plaintext number exists, so the code running there is part of the
  freeze. `public/app.js` and `public/app.css` are committed with a combined SHA-256;
  `--check` rebuilds and diffs, `--verify-hash` only compares the committed hash and
  needs no dependencies, which is what the VPS runs (deployment uses
  `npm ci --omit=dev`, and esbuild is a devDependency).
- **Two things that will bite anyone regenerating the bundle:** tlock-js 0.9.0 is
  CommonJS, so `export *` from it yields an *empty* module — re-export by name; and
  the `Buffer` global must be installed from a module the entry point *imports*, not
  assigned in its body, because module bodies run after all imports evaluate.
- **Multiple drand mirrors.** `server/drand.js` queries every configured mirror and
  **refuses to draw** if two disagree about the signature for the target round. One
  mirror down is fine; two disagreeing is a stop-everything event. The list is
  operational (`runtime.json`), and the loader always folds `drand.api` into it — an
  agreement check across a different set of endpoints from the one the draw used would
  be checking the wrong thing.
- **The snapshot is persisted once**, on the job's first run past the cutoff, and never
  retaken — so re-running after a drand outage cannot pick up a late arrival.
- **`generate.js` enforces the quorum itself**, with no override flag, so the rule
  cannot be sidestepped by running the script by hand.
- **`node:sqlite`** rather than `better-sqlite3`: it ships with Node, so the runtime
  dependency tree is exactly one package (`tlock-js`) and there is no native build on
  the VPS.
- **Sessions are stored hashed**, so a database dump yields no usable cookies.
- **Statistics are computed server-side** (`server/stats.js`) and reproduce the
  template's proved invariants independently — 66 pairs, 55 perfect, three players on
  5-3-3. If they ever disagreed with `tools/verify_template.py`, the figures shown to
  players would contradict the verifier participants are invited to run, so there are
  tests pinning both to the same numbers.

## 6g. Three modules that had never been tested

A count of passing tests says nothing about where they point. Three modules had none of
their own, and the reason each was skipped turned out to be the reason each mattered.

**`server/ciphertext.js`** is the door to the archive: everything it admits is written to
`events/submissions/` and mirrored to a public repository. It has nine refusals and one
of them was tested. The untested ones are not exotic — a ciphertext locked to another
round is what a player produces after §8 voids one and they submit from a stale page.
That one is refused at the door because after the cutoff it has already been counted
towards the quorum and cannot be resubmitted. There are now fifteen tests, one per rule,
including that the chain is checked before the round: both can be wrong at once, and the
chain's remedy is not "reload and try again".

**`server/mirror.js`** carries more of the fairness argument than any other file — the
ciphertexts are public and third-party timestamped as they arrive, which is what stops
an organiser dropping an inconvenient one after seeing the outcome. It was skipped as
"needs a real PAT", which is true only of the GitHub round trip itself. Everything that
decides whether a ciphertext reaches GitHub is a queue, a retry and a give-up rule, and
`fetch` is a global that a test can replace. Fourteen tests now cover them, including
that a permanently failing file is abandoned after five attempts rather than stranding
every ciphertext queued behind it.

Writing them turned up a fault in the tests rather than the module, worth recording
because it is the kind that passes: `enqueue()` starts a flush and deliberately does not
return it, so a test that only awaited `drain()` left a flush running, and when the stub
was put back it went to the real api.github.com. The file took 103 seconds and made
outbound requests. It now ends every such test at a `settle()` helper and takes four.

**`server/events.js`** is the only thing that carries a finished result to an open page,
because the draw is performed by a different process (§4.3). Its content type was tested
and nothing else. Fifteen tests now cover the replay to a stream that arrives between
two broadcasts, the suppression of identical payloads, the heartbeat starting with the
first client and stopping with the last, and a write to a socket that has gone away
dropping the client instead of throwing inside a timer.

## 6h. The rate limiter was scoped to the proxy, not to the player

`RateLimiter` keys on `req.socket.remoteAddress`, which is correct for a server facing
the network and meaningless for this one: §10 puts a reverse proxy in front, so every
request arrives from 127.0.0.1 and thirty attempts a minute became one allowance shared
by all twelve. Nothing failed; the limit was simply thirty times smaller than intended,
in a way that would first show up as several players being told to wait a minute while
signing in together.

The fix is not to read `X-Forwarded-For` — any caller can send that, and a server with
nothing in front of it would then hand an allowance to every invented address. It is
`server.trust_proxy` in `runtime.json`, off by default, and the **rightmost** entry when
it is on. Both proxies in `deploy/` build the header as "what the client sent, then the
address we actually saw", so the truth is on the right and a forged prefix sits to the
left of it. Confirmed against nginx 1.28 rather than assumed: a client sending
`1.2.3.4` arrives as `1.2.3.4, <its real address>`, and one sending two entries arrives
with three. The first version of the test encoded the opposite belief — that the proxy
appends *itself* — and failed, which is the useful direction for a test to be wrong in.

## 6i. Timestamping the roll, without a dependency tree

PROTOCOL.md §9 needs the roll taken at the cutoff to be timestamped by somebody outside
the organiser's reach. OpenTimestamps is that: a hash anchored in a Bitcoin block, and
nobody can move a block.

The official JavaScript client would do it. Its dependencies are web3, bitcore-lib, a
keccak binding that needs a compiler, and the deprecated `request` — fourteen transitive
packages, on a server whose only production dependency is tlock-js. A project whose
argument is "read this and check it yourself" should not answer "can I read all of
this?" with that.

So `server/ots.js` writes the format directly, and only the part that is needed: stamp
one digest against the public calendars, write a `.ots`. No verification, no upgrading,
no Bitcoin. Those belong to the reader's own client, and doing them here would be this
program marking its own homework.

The format is a magic header, a version, a hash op, the digest, then the timestamp tree,
with `0xff` between sibling branches. The calendars return exactly the branch that
follows the submitted digest, so the file is a header and their answers. Each calendar
becomes its own branch: they are independent witnesses and one being unreachable should
not cost the others.

Writing a proof that does not verify would be worse than writing none — it looks like
evidence and is not — so the output was checked against the reference implementation
rather than against our own opinion of the spec. `python-opentimestamps` deserializes
it, reports the digest we intended, and finds four pending attestations:

```
file hash op : OpSHA256
digest       : e57f528b0de517c006a1a40e529dd7829c1e144ff1892505ff8005ddff06f7ec
calendars    : 4
   pending at https://alice.btc.calendar.opentimestamps.org
   pending at https://bob.btc.calendar.opentimestamps.org
   pending at https://finney.calendar.eternitywall.com
   pending at https://btc.calendar.catallaxy.com
```

The digest submitted is the bare digest of the file, not a nonced one as the reference
client sends. That client hides what it is stamping; this roll is published in full
moments later, and stamping it bare is what lets a reader verify the `.ots` against the
`snapshot.json` they downloaded, with no extra step.

### Three bugs the stopwatch found

Timing the rehearsal turned up three things no assertion was looking at.

**The unit suite had started using the network.** `publishRoll` defaulted to the real
stamper, so every test that finalised anything dialled four calendars: `rounds.test.js`
went from a second to nineteen, and each of its tests took suspiciously exactly 1000 ms.
Stamping is now opt-in — `server/finalise.js`'s command-line entry point passes the real
one, and a library caller that has not asked for it gets none. The suite went from 22
seconds back to 4.

**A deployment without mirroring waited two minutes at the end of every draw.** `enqueue`
pushed onto the queue whether or not mirroring was configured, and `flush` returns
immediately when it is not — without emptying it. So `drain()` at the end of the draw
spun until its two-minute timeout and then returned false, which reads as failure. It
had been there all along; nothing timed that path. A disabled mirror now queues nothing,
because the local copy under `events/` is already on disk.

**The job polled its way through an interval whose length it already knew.** `finalise`
starts at the cutoff, and the beacon it is waiting for does not exist until
`reveal_gap_seconds` later. The wait loop asked drand every fifteen seconds for the whole
of it, and then, once the round was actually due, could still miss it by most of another
fifteen: where the polls fell depended on how long the OpenTimestamps stamp had taken
just before. That is a random delay bolted onto the end of a draw, which is the one place
this program should not have one.

Nothing about the round's time is a guess. protocol.json fixes it, `config.js` derives
`target_round_ms`, drand emits on a fixed period. So the first miss now sleeps to exactly
that moment and polls only afterwards, once a second, because from then on the delay is
propagation rather than the interval. In the rehearsal the stretch between the beacon
landing and the draw being finished fell from 17 seconds to 8, and stopped varying from
run to run. A ten-minute production interval had been costing forty round trips to the
mirrors for nothing.

Two details are worth keeping. The sleep is clamped so it cannot run past `maxWaitMs`,
or a deployment whose give-up timeout is shorter than its own interval would be told so
late. And the log is throttled to one line when the round first runs late and one every
half minute after, because at a one-second poll a genuinely stalled drand would otherwise
bury its own diagnosis under a line per second.

The first two took the rehearsal from 253 seconds to 134, and `npm run e2e` to 90. The
third took it to 122. What is left in D14 is the interval itself, which is the whole
point of the step, plus the work that genuinely follows a beacon: twelve tlock
decryptions, the seat plan, the Pantheon sync, and a second process for `--verify`.

## 6j. Who runs the draw, and the bug that came out from under it

The server serves the page. `server/finalise.js` draws. Keeping them separate is §9's
doing — nothing an outsider can poke may trigger, retry or re-time the draw — and it is
right. What was wrong was the conclusion drawn from it: that scheduling the job is
somebody else's problem. The only documented scheduler was a systemd timer, which asks
for root on a machine the organiser may not own and does not exist at all on Windows,
where this is developed and rehearsed.

So the realistic deployment served the page perfectly and never drew. Players signed in,
sealed their numbers, watched the countdown reach zero, and nothing happened — and
nothing anywhere said why, because every other indicator was green.

`server/schedule.js` gives the server a timer of its own. It is not an endpoint: no
request reaches it, and the interval is a number in a file on the box, so §9 is
untouched. It **spawns** the job rather than calling `run()` in-process, which keeps
three properties that are worth more than the saved process: the page stays responsive
through a dozen tlock decryptions, a crash in the draw cannot take the server with it,
and what the rehearsal exercises is the same command a cron would run. `run_finalise` in
`runtime.json` turns it off for anyone who does have a scheduler; the two must not both
fire, not because a double draw would disagree — it could not — but because it would
stamp the roll twice and write to Pantheon twice.

The page, the dashboard and the boot log all now say when nothing has drawn. That was
the actual defect: not that the draw could fail to be scheduled, but that it could fail
silently.

### The clock it exposed

Waking exactly at the round instead of polling past it (item 6i) turned a rare failure
into a reliable one. The rehearsal drew 9 of 12, then 11 of 12, then 9 again, and named
the missing players as **excluded**, with `results.json` saying so and the exclusion
published:

```
local_id 1 — It's too early to decrypt the ciphertext - decryptable at round 32098187
```

The obvious reading is that the beacon had not propagated. It is not what happened.
tlock never asks the beacon whether it is time; the check is local arithmetic, in
`tlock-js/drand/timelock-decrypter.js`:

```js
if (roundTime(chainInfo, roundNumber) > Date.now()) {
  throw Error(`It's too early to decrypt the ciphertext - decryptable at round ${roundNumber}`);
}
```

`roundTime` is `genesis_time + (round - 1) * period`, and the comparison is against
**this machine's clock**. So the two questions the job asks are answered by two
different clocks: drand's servers decide whether the beacon exists, and the local clock
decides whether tlock will use it. A host running a second or two behind drand is handed
the key and then told it is too early to turn it.

That also explains the shape of the failure, which nothing about propagation does: the
first few players excluded and the rest fine. Each decryption takes a few hundred
milliseconds, so the clock catches up partway through the loop.

It had been latent the whole time. A fifteen-second poll meant the draw always ran
several seconds after the round, which was enough to hide any plausible skew. Nothing
was wrong with the old cadence except that it was slow enough to be lucky.

The fix is in two parts, and the first is the real one. Before decrypting, the job waits
out its own clock: `target_round_ms` comes from `target_round_utc`, which
`tools/pick-round.js` computes with the same formula from the same chain info, so it is
exactly the instant tlock will test against. Satisfy the test locally before asking.

The second part is a net. "Too early" now raises `BeaconNotReadyError` rather than
being filed alongside a malformed ciphertext: the pass is abandoned at the first one
instead of working through the rest, and the caller retries — `pollMs` later when
waiting, or on the next run of the scheduled job, which does nothing at all in the
meantime. A round is drawn complete or not yet.

Keeping both is deliberate. An exclusion is irreversible and published, so the bar for
producing one has to be a failure that cannot be a timing artefact — and that bar should
not rest on one arithmetic identity holding between two codebases.

## 6k. The waiting screen was honest and unverifiable

Eleven changes to the player-facing UI, and four of them turned on the same distinction.

### A count is our word for it; a fingerprint is not

The waiting screen said "9 of 12 sealed" and drew nine filled chips. Every part of that
is true and none of it is checkable: it is this server's count of this server's own rows,
rendered by this server's own bundle. A player watching it has been asked to trust
exactly the party the rest of the protocol is built to avoid trusting.

So each envelope now carries the SHA-256 of the ciphertext being held, short by default
and stretching to its full length on hover or tap.

The obvious objection is UI-SPEC §9: *what each player submitted is never exposed before
the reveal.* It does not apply, and the reason is worth writing down because the rule
reads as if it does. The ciphertext is **already public** the moment it arrives — §5 has
it mirrored to the repository with a commit time, precisely so the organiser cannot drop
an inconvenient one after seeing the outcome. A digest of a published value discloses
strictly less than the value. Nothing here opens anything early; only the beacon does
that, and it does not exist yet.

What was actually being protected by omitting the digests was nobody, and the cost was a
player with nothing to check. The rule's real content is *the plaintext number*, and that
is untouched: §9's line has been restated in those terms rather than widened or narrowed.

### An empty slot changes meaning at the cutoff

Before it, an unfilled envelope means "not yet". After it, the same envelope means
"never". They rendered identically — an outlined chip — and they are opposite facts, one
of which is still actionable. The cards now say which, and a player who is themselves
unsealed at that point gets the page desaturated and a card of its own: closed, you are
not in this draw, it changes nothing for anyone else, and why a late number cannot be
taken. That last sentence matters more than it looks: without it the page reads as a
punishment rather than as the thing that makes everybody else's submission safe.

Below quorum the tally bar is amber rather than green, for the same reason. At that count
the round would be void if the cutoff arrived now. A green bar saying so reads as "fine".

### A timeline that does not invent its own beginning

The two instants and the round used to be a line of small print: *sealed at 20:30 · draw
at 20:40 · drand round 8,234,500*. Every fact correct, the relationship between them
invisible. They are a sequence, ten minutes apart, one of them days away, and the round is
what ties both to something nobody here operates.

Drawing that as a track ran straight into a small honesty problem. The right-hand segment
has a real duration — `reveal_gap_seconds` — so it can be drawn to scale. The left-hand
one has no origin at all: submissions may have opened a fortnight ago, and the server does
not record when. Giving the bar a start date would have been the same lie as an invented
progress bar, one step subtler. So the lead-in is drawn as one reveal-gap, and while now
is earlier than that the marker pins to the edge and the label says *opened earlier*.

### The evidence was split into three paragraphs

The roll card asserted "timestamped into Bitcoin by four independent calendars" in one
paragraph, offered two downloads in another, and named `ots verify` in a third. The
reader had to work out that the second is how you check the first, and then that the third
requires installing a Python package. A verification step that needs a package manager is
a verification step that does not happen.

The three are now one block, and the check is a web page you drop two files onto
(opentimestamps.org, Verify). The card also appears on the result stage, where it had been
withdrawn at exactly the moment it became checkable — before the draw the digest is a
commitment, after it the same file is what a verifier recomputes from, and there is no
reading under which it should be available for only the first of those.

And it is no longer called "the roll" to players. That is this document's word.
`events/snapshot.json` is its name on disk; what a player reads is *the sealed
ciphertexts*, which is what it is.

### The explanation page is generated, not written twice

`docs/seating-design.md` explains the whole scheme from first principles and was
reachable only by finding this repository. It is now a page in the app, on a two-entry
menu in the header, from every screen including sign-in — a player deciding whether to
trust this before typing a number should not have to leave to find out.

Generated at build time rather than re-written in JSX, because the page a player reads
and the document an auditor reviews have to be the same text. A copy drifts, and the
paragraph that drifts is the one explaining why the draw cannot be steered.

That needed a markdown renderer, and pulling one in would have put a hundred transitive
dependencies inside the bundle that seals a number. `tools/md-to-page.js` handles what
this document uses and **throws on anything else** rather than dropping it — the failure
mode of a lenient renderer is a missing paragraph nobody notices. The two mermaid
diagrams are both simple chains, so they are parsed into their nodes and drawn as boxes
and arrows; a diagram that turns out not to be a chain is a build error.

The Chinese translation is a second document, not a fallback to English. The app has said
since it was written that a player who does not read Chinese gets English on every screen;
159 lines of English combinatorics is the same gap pointing the other way, on the one page
whose job is to earn trust. `test/md-to-page.test.js` fails if either version gains or
loses a section, a figure or a diagram.

### The rest

The event's name, read from Mimir at boot, now prefixes the app title and the browser tab
— a club runs several of these a year and two open tabs saying *座位抽签* tell a player
nothing about which one they are about to submit into. It is operational, not frozen: a
label whose every possible value leaves the seed, the roster and the round alone.

The submission screen shows both deadlines, as a live countdown and as exact instants in
the reader's own timezone with the offset named and UTC underneath. Until now the one
screen where a player still had something to do was the one screen that never said when
they had to do it by.

The password field has a reveal toggle, off by default.

## 6l. Ctrl+C did nothing

Not *slowly*. At all, on any number of presses, with nothing printed.

Three lines, each defensible on its own. The signal handler called `server.close()` and
exited from its callback. `close` calls back when the last connection has ended. The
streams the waiting stage holds never end on their own, and are released by `hub.close()`
— which was registered on the server's own `close` event, the event waiting for those
streams. Each step waits for the next, and installing a handler is also what removed
Node's default of exiting on the signal, so there was nothing underneath to catch it.

The cost was not a slow shutdown. On Windows the way out was Ctrl+Break or the task
manager. Under systemd, where the same cycle held for SIGTERM, every `systemctl restart`
would sit for the full ninety-second `TimeoutStopSec` and end in SIGKILL — which is to
say that every deploy killed the relay mid-request instead of stopping it, and the unit's
careful note about not interrupting a draw described something that was not happening.

The order is now streams, then sockets, then the wait. `hub.close()` ends the responses;
`closeIdleConnections()` drops the spare keep-alive socket a browser leaves lying around,
which holds the close open exactly as firmly as a live request does; only then is there
nothing left to wait for. Measured at 15 ms with a player attached, and confirmed against
the real program with a real console Ctrl+C: the stream ended, the client saw it end, and
the process was gone. Anything still attached after three seconds is dropped with a line
in the log, because somebody standing at a terminal has not asked to wait for it. A
second press exits immediately, on the assumption that the first one did not look like it
worked.

The draw child is still left alone on purpose. A half-published round is worse than an
orphaned process.

The test is worth noting for how it fails: with the bug back it does not fail, it hangs.
That is the bug, faithfully. The SSE test that existed all along never caught this
because it cancels its reader before closing, which is the one thing a player sitting on
the waiting page never does.

## 6m. What a stop during the draw was allowed to take with it

Fixing Ctrl+C (§6l) made the relay stop in milliseconds and turned the next question up:
what else was that stop signal reaching, and what did it cost. The draw job, it turned
out, and rather a lot.

### A file that exists is a claim, so it must never exist half-written

`results.json` was written with a plain `writeFileSync`. `phaseOf` decides the draw is
finished from that file's **existence** — not its contents, by design, because a
published result has to outrank a lost database (§6). Put those two together and a
process killed inside that one write leaves a file that settles the event as done,
is never retried, and makes `GET /api/result` throw on every request for every player,
with the seat plan surviving nowhere but the memory of the process that just died.
Recovery means deleting the file by hand, and no runbook said so.

The window is one small synchronous write, and the ways into it are ordinary: systemd
stopping the unit mid-draw, the unit's own `MemoryMax` firing on the one process that
holds a dozen ciphertexts and their plaintexts at once, a power cut. Everything published
now goes through a temporary name beside the destination and a rename, which is atomic on
POSIX and on Windows. There is either no file or the whole file, and "no file" is a state
this system already knows how to recover from: it draws again and gets the same answer,
because the beacon and the snapshot are both already fixed.

### The push that nobody noticed had not happened

More likely than the above, and quieter. The result is written to disk and queued for the
mirror in the same breath, but the queue lives in memory and the push happens at the end
of the run, with the Pantheon sync in between — seconds, or tens of seconds if Pantheon is
slow. A process that stops in that gap leaves the result on the organiser's disk and
absent from the public repository, which is the file the README tells a player to verify
against. The next tick sees `results.json`, reports *already done*, and resumes only the
sync.

Writing that fix turned up two worse instances of the same shape, and one of them was not
conditional on being interrupted at all.

`events/void.json` and `events/snapshot.json` were enqueued and then **returned past**.
`enqueue` starts a flush it does not await; `run()` returns; the command-line entry point
calls `process.exit` as soon as it resolves. So on every void round the notice raced the
exit and generally lost, and at every cutoff the roll did the same. The roll is the worse
of the two by a distance: it is written once and guarded against ever being written
again, so a push lost there was lost permanently — and a roll that is not public before
the beacon is the whole of §9, which is to say it proves nothing.

The shape of the fix is therefore not "re-push results.json". Every durable artefact goes
through one function that writes it locally, queues it, and records that the repository is
now behind; every path out of `run()` works the queue and records whether it emptied; and
a run that starts while that record is missing offers the files on disk again, roll first,
so a reader never finds a result published without the file needed to audit its roll-call.
The bytes come from disk rather than from the database, because what the database holds
has the derived statistics merged in and pushing those would publish a file that does not
reproduce (§4.3).

There is a third instance, and it is one that §6l created. Submissions are queued by the
server rather than by the draw job, and while stopping took forever the queue always
emptied on the way out by accident. Stopping in milliseconds removed that accident: a
ciphertext taken seconds before a restart would have been durable locally and absent from
the repository, which is precisely the claim §5 makes about it. The shutdown now waits for
the queue as well as for the sockets, under the same bounded grace, and names what did not
go out — the files are still under `events/submissions/`, so an operator who is told can
push them by hand.

A drain that reports failure records nothing, in all of these. Writing *published* on a
push that did not happen would take away the one later run that could still fix it.

### The knob that looked right was the wrong one

Under systemd's default `KillMode=control-group` the stop signal goes to every process in
the unit, the draw job included, and Node's default action is to die on the spot. The
obvious remedy is `KillMode=mixed`, which sends SIGTERM only to the main process.

Measured on systemd 255, with a child that logs what it receives:

| KillMode | the child receives | `systemctl stop` takes | the child |
|---|---|---|---|
| `control-group` (default) | SIGTERM | 0s | survives it, if it chooses to, and finishes |
| `mixed` | nothing | 0s | SIGKILL the instant the main process exits |

`mixed` is strictly worse: SIGKILL cannot be handled at all. The default is the better of
the two *provided the job survives SIGTERM*, and the unit counts as stopped once the main
process exits, so nothing comes back for the child afterwards. The job therefore ignores
the first stop signal and finishes the draw; a second exits anyway, because an operator
who asks twice means it. Both unit files say all of this where somebody would otherwise
reach for the knob, and both now set `TimeoutStopSec` deliberately rather than inheriting
ninety seconds.

### One draw at a time, across processes

That fix creates a situation that did not exist before: `systemctl restart` during a draw
leaves the old job running while a new server starts and schedules another. The
scheduler's guard against overlap is a variable in one process's memory, which decides
nothing once there are two.

`var/finalise.lock` settles it, and the failure it must **not** have shapes every line of
it. A lock nobody holds must never be able to stop an event drawing at all, so a lock is
taken over when its process is gone, when it is older than any real run could be (pids
get reused), and when it is unreadable. Trading a race nobody has hit for an event that
never draws would be a bad bargain.

## 6n. The deployment was documented for a machine you own

Two things a reader following `deploy/README.md` exactly would have got wrong.

### `.env` was read by exactly one launcher

That document has the operator write a `.env` holding everything that makes a deployment
real rather than a demo: the Pantheon base URLs and the admin account for the seat-plan
sync, the mirror repository and its token, `ADMIN_TOKEN`, `NODE_ENV=production`. Only the
systemd unit read it, through `EnvironmentFile=`. Every other launcher in the same
document — tmux, `nohup`, a crontab, a terminal — and the command the README's own
Production section gives, started a process that had never seen any of it.

Nothing about that looks wrong from outside. The server serves the right pages, signs
people in, accepts every ciphertext, and mirrors **none** of them, which quietly removes
the §5 property the fairness argument leans on hardest. `NODE_ENV` unset also leaves the
session cookie without `Secure`.

The process reads the file itself now, through Node's own loader, so this costs no
dependency — and it says which file it read in its first few log lines, because the whole
failure was one of silence. A variable already in the environment still wins over the
file, so `PORT=9000 node server/server.js` keeps meaning what it says. A `.env` that
cannot be read is fatal rather than partial: running with half the settings is the same
failure in a smaller size.

### The install still opened with `adduser`

`adduser --system --group` and a `chown` were the first two lines, which makes the whole
document read as something you need root for. Nothing in the relay needs one. It binds a
high port because something else terminates TLS in front of it, it writes only inside its
own checkout, it opens no device and joins no group, and the two credentials it holds are
a GitHub PAT and a Pantheon account — secrets belonging to the organiser rather than to
the machine, which is exactly why a dedicated system account buys less here than it
usually does. What protects them is the mode on `.env`, either way.

So the rootless path is the documented one, including the part people assume needs root:
surviving a reboot. systemd runs an instance per user, and registering a service with your
own needs nothing from an administrator — verified on systemd 255 as an ordinary user.
`loginctl enable-linger` is the one piece that depends on the machine, and it is governed
by a polkit action that ships allowed for any user on Ubuntu and Debian; the document says
how to check rather than asserting it will work. `deploy/mahjong-relay.user.service` is
the unit, with the hardening that genuinely needs root dropped and the part that matters
kept. The system unit stays for anyone who wants the isolation and has root to enforce it.

### The rest

Links had no colour. There was no rule for `a` anywhere in the stylesheet, so every
anchor the app renders fell back to the browser default: `#0000EE` on the parchment, the
same blue against `#131518` in dark mode, and `#551A8B` once visited. The visited colour
was the worse half — a player who has downloaded the sealed ciphertexts once saw a
different colour from the eleven who had not, on the one control the page asks all twelve
of them to use and compare. Two places had already patched around it locally; those
patches are one rule now.

## 6o. There was a start procedure and no finish procedure

It surfaced as a question about a page: a second event was frozen into a checkout that had
run a first, and the first screen a player saw was the previous event's seat plan. Behind
it were four separate faults, one of which had been quietly breaking §9 for every attempt
after the first.

### A reset that cleared four keys out of six

`clearRound` named the state it deleted: `snapshot`, `phase`, `result`, `pantheon_sync`.
It did not name `roll_published`, and `roll_published` is what guards `publishRoll`:

```js
if (!store.get(KEY_ROLL)) {
  await publishRoll(cfg, store, snapshot, { mirror, log, stampFn: opts.stamp });
}
```

So after §8's void-and-retry, the second attempt found the first attempt's record sitting
there and **never published its own roll**. No digest for the twelve of them to compare
during the interval, no OpenTimestamps anchor, and the waiting page showing the previous
attempt's fingerprint while it happened. §9 is the argument that the roll is fixed before
the beacon exists; for every attempt after the first, it was not happening at all.

One key added in one file and not added in another. So the list is now an exclusion —
everything is round-scoped unless named — and the test asserts that nothing outside the
kept set survives a reset, including a key nobody has invented yet.

### State that belongs to another round, served as if it were this one

`phaseOf` answers from the persisted phase when no `results.json` is on disk, and that is
deliberate: a published result outranks the database, and a database restored onto a
finished draw must not report it void. The case nobody had considered is a database that
is *intact* and about a **different round**.

Nothing detected it, and every layer then behaved correctly on the wrong premise: the
phase was `done`, the API served a seat plan, and the players it named were the previous
event's twelve. Worse, once mirroring is configured, the re-publish added in §6m would
have offered the old event's roll under the new event's name.

It is now refused rather than reported. The snapshot records the cutoff it was taken at
and the result records the round it was drawn at, so the disagreement is checkable
against the freeze, and both the server and the draw job stop before doing anything. A
deployment that does not start is visible before anybody is told a URL; one that starts
wrong is visible only to the players. The re-publish carries the same check independently,
because `var/` can be cleared on its own and leave `events/` behind.

### No way to finish

The documentation had a start procedure and no finish procedure, and that is what made all
of the above reachable. `tools/new-round.js` is §8's retry and is narrow on purpose: it
refuses unless a void notice exists, unless its archive verifies, unless the new round is
later, unless the new cutoff is in the future. Every one of those refusals is a rule about
not restarting a round after seeing who has submitted. None of them is about an event that
is simply over.

`tools/end-event.js` is that missing half. It archives the attempt, verifies every digest
in the archive, and only then clears `var/` and the live files under `events/` — so
nothing is deleted that the archive does not hold, and a failed verification clears
nothing. A round that reached neither a draw nor a void is *abandoned* rather than closed,
and saying so on the command line is the whole safeguard: abandoning a round after seeing
who turned up is the manipulable step §8 exists to remove, and it should not be something
that happens by running the tidy-up command.

One detail is worth recording because the first version got it wrong. The round an attempt
is about has to come from its evidence, not from `protocol.json` — closing an event after
the next one has been frozen is exactly when those differ, and archiving twelve ciphertexts
under a round they were never sealed against would make the archive worse than absent. In
that case the frozen parameters cannot be archived at all, the manifest says so rather than
copying the current file's values, and the tool tells the operator to close before freezing
next time.

### The warning that was silent for its own default

`freyPublicUrlIsLocal` exists, in its own words, so a deployment is told before a player
finds out that browsers have been handed a Frey address they cannot reach. It tested for
IP literals only, so it was silent for `frey.pantheon.local` — the shipped default, and
what a local Pantheon in Docker answers to. That name resolves through an `/etc/hosts`
entry on the machine running the containers and nowhere else; the browser is somewhere
else by definition, and what a player reports is a wrong password. Single-label and
`.local`-style names are now flagged too, and a real domain still is not, because a
warning that fires on correct configurations is one people learn to ignore.

## 6p. A finished draw, accused of falling short

An event was closed out with `tools/end-event.js`, a second one was frozen into the same
checkout, and the first thing the submission page told everybody was this:

> This is draw attempt 2. Last time only 9 numbers were sealed by the cutoff, short of
> the 8 required, so that round was voided under the rule set before it started.

Nine is not short of eight. That round had not fallen short of anything: it had drawn,
published a seat plan, and been closed. Every number in the sentence was read from a real
record, and the sentence was still false, which is the kind of wrongness that is worth
tracing rather than patching at the word.

### An index is a log, not a history of one run

`events/rounds/index.json` records every attempt this checkout has ever archived. That is
deliberate and it is the whole point of §8's archive: nothing is deleted, so anybody can
open the ciphertexts of a round that was declared void and count them. But `/api/status`
was reading it as though it were the history of the run now open:

```js
attempt: previous.length + 1,
previous_rounds: previous,     // previous = readIndex(cfg)
```

Two events had been archived, so the new one called itself attempt 3 — and the submission
stage, which takes the last entry to explain why a player is being asked for a number
again, took the finished event and described it in the only terms §8 has for a previous
attempt: it fell short.

A run ends when a draw completes. `attemptsInThisRun` slices the index after the last
entry that is not a void, so a closed event leaves nothing behind it and a new event
starts at attempt 1 with no notice at all. The round now open is excluded from the count
separately, because it joins the index the instant it is declared void — without that, the
screen announcing that attempt 2 had failed would have called itself attempt 3.

The client carries the same check a second time. `status.attempt > 1` is not enough to
print that sentence; the entry it is about has to say `status: "void"`. Defence in depth is
usually worth arguing about, but not here: the sentence accuses a draw of failing, and
there is nothing worse to say about one that didn't.

It is a §8 fault rather than a display fault, which is why it is in this file. §8's
evidence exists to stop an organiser claiming a round fell short in order to get a
do-over. An app that makes that claim by itself, about a round that succeeded, does the
damage §8 is built to prevent — and it does it in the one place where all twelve players
are looking.

### The submission screen, reordered

Three things came out of reading that screen again with a player's question in mind
("how long have I got?"):

- **The countdown leads.** It was a line of small print at the right-hand end of the
  deadline row. It is now large, centred and the first thing in the card, because it is
  the only figure on the screen a player can act on without doing arithmetic against
  their own clock. It is still set a size below the number field, so §1's single focal
  element is unchanged.
- **The UTC restatement is gone.** Both instants already print with their own offset —
  `18:38 UTC+8` — so repeating them as `10:38Z` underneath said the same thing twice,
  on the screen that should hold nothing spare.
- **The heading rejoined its field.** "Pick a number" had the deadline band wedged
  between it and the input it names. The band and the void notice now sit above the
  greeting, and nothing at all comes between the heading and the field.

The label moved with the layout: "sealed at" was the protocol's word for what happens to
the number, not the player's word for what happens to them. It now says entries close.

## 10. What was verified, and how

| Check | Status |
|---|---|
| `tools/verify_template.py` re-derives every template invariant | passes |
| Unit tests (`npm test`) — 351 across generate, encoding, config, roll-call, resume, attempts, admin, freeze, checkout, API, stats, Pantheon, sign-in, ciphertext admission, mirroring, SSE, timestamping, the roll, the draw schedule, the document renderer, the document set, the licence notices, shutdown, the draw lock, .env, closing an event, whose attempt a round belongs to | pass |
| The frozen/operational split, tested from both sides (`test/config.test.js`) | passes |
| A player dropped from both lists reproduces byte for byte, and the roll-call catches it | passes |
| A finished draw survives a lost database without being declared void | passes |
| A voided attempt is archived, verifies, and the next attempt opens | passes |
| Tampering with an archived ciphertext is detected, and blocks the reset | passes |
| No ciphertext reaches the admin page or its JSON | passes |
| Every one of the nine ciphertext refusals fires, and the chain is checked before the round | passes |
| Mirroring retries, then gives up after five attempts without stranding the queue | passes |
| The SSE hub replays to a late stream, suppresses repeats, and stops its heartbeat with the last client | passes |
| The Pantheon token is verified once and appears in no table, log line or response | passes |
| Behind a proxy the rate limit is per player, and a forged `X-Forwarded-For` buys nothing | passes |
| The `.ots` this writes is accepted by python-opentimestamps, with four calendar attestations | passes |
| The roll is published and anchored at the cutoff, not at the draw | passes |
| A clock short of the round delays the draw instead of excluding whoever was decrypted first | passes |
| The server draws on its own timer, with no systemd and no root (`npm run rehearse` step 14) | passes |
| A dead calendar records the failure and does not stop the draw | passes |
| The offline suite reaches no network, and a disabled mirror does not stall the draw | passes |
| `X-Forwarded-For` as nginx 1.28 actually builds it, against a live nginx | matches |
| The freeze refuses a roster that would break the sync after the draw | passes |
| A fresh clone checks out the bundle byte-identically and its digest matches | passes *(after `.gitattributes`)* |
| RUNBOOK B/C/D end to end (`npm run rehearse`): freeze, tag, 12 submissions, draw, sync, player verification | passes *(against the stub)* |
| A refused freeze leaves no `data/roster.json` behind | passes |
| A fresh clone **at the tag** recomputes the seat plan and matches the bundle hash | passes |
| **RUNBOOK B/C/D executed for a real event** | **outstanding — needs Pantheon, real registrations and a deployment** |
| Byte encoding cross-checked by an independent Python implementation | agrees |
| e2e A2: full journey, sign-in → submit → reveal → result → sync | passes |
| e2e A3: sign-in gate both ways, with distinguishable refusals | passes |
| e2e A4: 8 draws, 7 is declared void without crashing | passes |
| e2e A5/A7: recomputed offline in a fresh process, and again in Python | byte-identical |
| e2e A6: prescript read back, session 1 matches **including winds** | passes *(against the stub)* |
| UI: all six stages rendered and inspected, including the phone grid | passes |
| Every stage rendered to static HTML in both languages, and read | passes |
| The status carries a digest per sealed envelope, and no ciphertext | passes |
| The event name is read from Pantheon, and a configured one is not asked for | passes |
| The document renderer refuses a diagram it cannot draw, rather than dropping it | passes |
| The two language versions have the same sections, figures and diagrams | passes |
| The generated explanation page is deterministic: a fresh clone at the tag rebuilds the bundle byte-identically | passes |
| `THIRD-PARTY-NOTICES.md` covers every one of the seventeen libraries in the bundle, and `--check` fails if it has fallen behind | passes |
| Ctrl+C stops the relay while a player is attached to the stream, and a stream nothing releases is dropped rather than waited on | passes |
| A reset clears every key that describes the round, and the attempt after it publishes its own roll | passes |
| A closed event is not counted as a failed attempt of the next one, and a new event opens at attempt 1 | passes |
| The round now open is excluded from its own attempt count, so a void screen does not skip a number | passes |
| Every submission-stage layout rendered to static HTML in both languages, with and without a void notice | passes |
| A database from another round is refused at startup by both the server and the draw job | passes |
| A finished event is archived, verified and then cleared; an unfinished one is not closed without saying so | passes |
| A Frey address that resolves on one machine only is flagged, and a real domain is not | passes |
| A published file is renamed into place: a failed write leaves the previous one intact and no scratch file behind | passes |
| A draw whose push never completed is re-mirrored on the next tick, with the bytes that are on disk | passes |
| A void round and a roll taken at the cutoff both work the queue before the process exits, and are offered again if it did not empty | passes |
| The roll goes out before the result, so a reader never finds one without the other | passes |
| The shutdown waits for a queued submission, and an unreachable repository still cannot hold the process open | passes |
| A second draw job finds the lock taken; a lock whose holder is gone, or older than any real run, is taken over | passes |
| `.env` is read by the process itself, the environment still wins over it, and an unreadable one is fatal | passes |
| systemd 255, measured: the default KillMode lets a job that survives SIGTERM finish, and `mixed` SIGKILLs it | measured |
| A rootless install, including a systemd **user** unit, on systemd 255 as an ordinary user | passes |
| RUNBOOK A2/A3/A6 against a real Pantheon instance (`cdda3fc`, local Docker) | passes *(after six fixes — §6f)* |
| Roster snapshot from a live event, through `tools/freeze.js` | passes |
| Sign-in gate live: correct token, wrong token, unknown person | passes, three distinct answers |
| Prescript written, read back byte-identical, and applied with `MakePrescriptedSeating` | passes, seat order intact |
| The whole suite on Linux (WSL 2), including e2e A2-A7 | passes |
| **The Pantheon instance actually deployed against** | **outstanding — §5.1 is one commit's behaviour** |

`npm run e2e` needs network access to `api.drand.sh` and takes about ninety seconds,
`npm run rehearse` about two minutes. Most of both is spent waiting for a target round to
land, which is the one part of either that cannot be made faster without making it a
different test.
