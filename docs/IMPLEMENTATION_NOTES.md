# Implementation notes

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
  completed draw** — mirroring it to the repository in the process. The systemd timer
  fires every five minutes, so this needed only one lost `var/` to happen on its own.
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

## 7. The Pantheon boundary, and what is *not* verified

Everything the app needs from Pantheon goes through one interface in
`server/pantheon.js`, with two implementations:

- **`TwirpPantheon`** — the real client, written from the method names and message
  shapes in `PANTHEON-INTEGRATION.md` §5.
- **`StubPantheon`** — an in-process fake with the same contract, which is what the
  tests and `PANTHEON_MODE=stub` use.

> **`TwirpPantheon` has NOT been verified against a running Pantheon instance.**
> No instance was available. `PANTHEON-INTEGRATION.md` opens by saying to confirm the
> field names against the instance you actually run, because they are the details most
> likely to drift — that instruction is outstanding.

What this means in practice: the Twirp path template, service names and base URLs are
all configurable (`runtime.json` → `pantheon`, since where Pantheon lives cannot affect
the draw), so drift should be a config change rather than a code change. What the sync
is allowed to *write* stays frozen: `wind_shuffle_mode` is in `protocol.json`, because
any other value silently discards most of what the template guarantees. But **RUNBOOK steps A2, A3 and A6 are not yet satisfied
against real Pantheon**, and A6 — reading the prescript back and confirming the winds
survive — is the one that document calls most likely to be silently wrong. The
equivalent checks all pass against the stub, including the read-back and the
wind-by-wind comparison, so the logic is exercised; only the wire format is unconfirmed.

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

## 10. What was verified, and how

| Check | Status |
|---|---|
| `tools/verify_template.py` re-derives every template invariant | passes |
| Unit tests (`npm test`) — 161 across generate, encoding, config, roll-call, resume, attempts, admin, freeze, checkout, API, stats, Pantheon | pass |
| The frozen/operational split, tested from both sides (`test/config.test.js`) | passes |
| A player dropped from both lists reproduces byte for byte, and the roll-call catches it | passes |
| A finished draw survives a lost database without being declared void | passes |
| A voided attempt is archived, verifies, and the next attempt opens | passes |
| Tampering with an archived ciphertext is detected, and blocks the reset | passes |
| No ciphertext reaches the admin page or its JSON | passes |
| The freeze refuses a roster that would break the sync after the draw | passes |
| A fresh clone checks out the bundle byte-identically and its digest matches | passes *(after `.gitattributes`)* |
| **RUNBOOK B/C/D executed against a real event** | **outstanding — needs Pantheon, a roster and a deployment** |
| Byte encoding cross-checked by an independent Python implementation | agrees |
| e2e A2: full journey, sign-in → submit → reveal → result → sync | passes |
| e2e A3: sign-in gate both ways, with distinguishable refusals | passes |
| e2e A4: 8 draws, 7 is declared void without crashing | passes |
| e2e A5/A7: recomputed offline in a fresh process, and again in Python | byte-identical |
| e2e A6: prescript read back, session 1 matches **including winds** | passes *(against the stub)* |
| UI: all six stages rendered and inspected, including the phone grid | passes |
| **RUNBOOK A2/A3/A6 against a real Pantheon instance** | **outstanding — see §7** |

`npm run e2e` needs network access to `api.drand.sh` and takes about three minutes,
most of it waiting for the target round to land.
