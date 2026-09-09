# Implementation notes

Everything the implementation had to decide that the specification does not settle,
plus the places where following one rule literally would have broken another.

**Read this before the freeze.** Items 1 and 2 change what goes into `protocol.json`
and what is verified, so they have to be settled before RUNBOOK step 11, not after.

---

## 1. `protocol.json` needs a `chain_public_key` field — a real addition to §4

`PROTOCOL.md` §4 lists `chain_hash` but no public key. That turns out not to be enough
to verify anything. `drand-client` checks the two together:

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
without it, and both `server/tlock.js` and `client/seal.js` pin both values. For
quicknet, verified against `https://api.drand.sh/<chain_hash>/info` on 2026-09-09:

```
chain_hash       52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971
chain_public_key 83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a
scheme           bls-unchained-g1-rfc9380      period 3s
```

`tools/pick-round.js --in 72h --write` fills all of it in, and sets `target_round` and
`submission_cutoff_utc` together so they cannot disagree.

## 2. `results.json` cannot be fully reproducible, and pretending otherwise hides a real gap

§4 puts `pantheon_sync` inside `results.json`. RUNBOOK step A5 asks that a finished
draw be recomputed from `results.json` alone and match. Both cannot hold: the sync
outcome is a network result carrying a wall-clock timestamp, so a file containing it
can never be reproduced by recomputation.

The e2e test caught this the first time it ran, which is exactly what it is for.

**Resolution.** The file keeps the field — §4 asks for it and an operator needs it —
and `generate.js --verify` checks the *reproducible core*, then states plainly which
fields it set aside:

```
OK    results.json reproduces byte for byte from its own revealed payloads
      (not covered, and not reproducible by design: pantheon_sync — written after
       the draw by the finalisation job)
```

The excluded set is `pantheon_sync` and `excluded_local_ids`, both written after the
draw by the finalisation job. Naming them is the point: a verifier who is told "this
reproduces" should know precisely what was and was not covered.

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

## 6. A published `results.json` outranks the database

`phaseOf` consults `results.json` before it consults the submissions table. Without
that, restoring the server onto a fresh database after a completed draw reports the
round as **void** — an empty submissions table past the cutoff is indistinguishable
from a quorum failure. Telling players that a finished, published draw was void is the
worst wrong answer available, and RUNBOOK is explicit that `results.json` is
authoritative while the SQLite state is expendable.

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
all configurable (`protocol.json` → `pantheon`), so drift should be a config change
rather than a code change. But **RUNBOOK steps A2, A3 and A6 are not yet satisfied
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
  mirror down is fine; two disagreeing is a stop-everything event.
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
| Unit tests (`npm test`) — 72 across generate, encoding, API, stats, Pantheon | pass |
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
