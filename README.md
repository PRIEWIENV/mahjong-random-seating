# Randomised Mahjong Seating — handoff starter

Starting point for implementation. The combinatorial work is **finished and proved**; what remains is the web app, the Pantheon integration and the operational process.

## What this is

Twelve players are seated across eleven rounds at three tables. The seating *template* — who sits with whom, in which wind, at which table — is fixed and provably optimal. Which player gets which position in that template is decided by a draw that all twelve contribute to and that nobody, including whoever runs the server, can predict or steer.

Start with [`docs/seating-design.md`](docs/seating-design.md): it explains the whole thing from first principles, with figures, and is also the page meant to be published for the players themselves.

## Status

**Done, verified, ready to freeze**

- `data/schedule_template.json` — the reference template (12 abstract positions × 11 rounds × 3 tables × E/S/W/N). Every pair shares a table exactly 3 times; every position's wind split is exactly {3,3,3,2}; every pair sits opposite exactly once; table splits are {4,4,3} for nine positions and {5,3,3} for three; 55 of 66 pairs are "perfect".
- Those figures are **globally optimal and proved**, not heuristic. Both optima come from integer programmes that terminated with objective == bound, and the search covered all five non-isomorphic resolvable 2-(12,4,3) designs known to exist (Morales & Velarde, 2001) — of which exactly one admits the "opposite exactly once" condition, so the design is forced.

**Built and tested**

- The player app — one continuous flow, no tabs: sign-in → submit → wait → reveal → seat plan explorer, per [`docs/UI-SPEC.md`](docs/UI-SPEC.md). All six stages render; the explorer's three lenses work, including on a phone.
- The backend — session, me, submit, status, result, SSE and the scheduled finalisation job, per [`docs/PROTOCOL.md`](docs/PROTOCOL.md) §6.
- `generate.js` — contributions → R → seed → shuffle → seat plan → prescript, per §7, with the byte encoding pinned and cross-checked by an independent Python implementation.
- Pantheon integration — behind one interface (`server/pantheon.js`), with a real Twirp client and an in-process stub.

**Outstanding**

- **The Twirp client has not been run against a real Pantheon instance.** None was available. `PANTHEON-INTEGRATION.md` says to confirm the field names against the instance you actually run; that is still to do, and RUNBOOK steps A2, A3 and A6 are not satisfied against real Pantheon until it happens. Everything passes against the stub. See [`docs/IMPLEMENTATION_NOTES.md`](docs/IMPLEMENTATION_NOTES.md) §7.
- The operational half of the RUNBOOK: snapshot the real roster, choose the target round, freeze and tag (steps 8–11).

**Read [`docs/IMPLEMENTATION_NOTES.md`](docs/IMPLEMENTATION_NOTES.md) before freezing.** One item there is about what "verified" actually means:

- `results.json` contains only what `generate.js` computes, so `--verify` compares every byte with no field set aside. The Pantheon sync outcome lives in `events/sync.json` instead, because it records something that happened after the file was written. Separately, the byte comparison recomputes *from* the payloads the file lists, so it cannot prove that list is complete; `events/snapshot.json` is what closes that, and `--verify` runs the roll-call whenever it is available.

`protocol.json` holds the frozen parameters and nothing else. Operational settings — the drand endpoint, the Pantheon base URLs, poll intervals — live in `data/runtime.json`, are not tagged, and may be changed mid-window. [`docs/PROTOCOL.md`](docs/PROTOCOL.md) §4.1 gives the test that decides which side a parameter falls on; the loader refuses to start if an operational key turns up in the frozen file.

Read `docs/PROTOCOL.md` end to end before changing code, particularly §7 (algorithm) and §8 (quorum and failure handling). The rules there are where the fairness comes from; they should not be rewritten to whatever seems more reasonable in the moment.

## Running it

```sh
npm ci
npm test                  # 115 unit tests, offline, ~4s
npm run verify-template   # re-derives every invariant of the frozen template
npm run e2e               # RUNBOOK A2-A7 against live drand, ~3 min
```

To actually run the app you need `data/roster.json` and `data/protocol.json`; the
server refuses to start without them, and copying the `.example` files is not enough
(`target_round: 0` is rejected on purpose).

```sh
cp data/protocol.example.json data/protocol.json
node tools/pick-round.js --in 2h --write        # sets target_round + cutoff together
# write data/roster.json: pantheon_event_id and twelve {local_id, person_id, title}

npm run build                                   # rebuild public/app.js + app.css
PANTHEON_MODE=stub npm run serve                # http://127.0.0.1:8080
```

`data/runtime.json` is optional. Copy `runtime.example.json` to it only to change
something — a different drand mirror, real Pantheon base URLs — and note that it is
gitignored, because it is deliberately outside the freeze (`PROTOCOL.md` §4.2).

`PANTHEON_MODE=stub` runs against the in-process fake, which is what makes the whole
flow exercisable without a Pantheon deployment. It also enables a development-only
sign-in stand-in that is refused under `NODE_ENV=production`.

## Layout

```
generate.js                  # PROTOCOL.md §7 — frozen; node:crypto only, no dependencies
data/
  schedule_template.json     # frozen and verified — do not hand-edit
  roster.example.json        # Pantheon event roster snapshot; fill in, rename to roster.json
  protocol.example.json      # FROZEN parameters: chain, target round, quorum, input range
  runtime.example.json       # operational settings — not frozen, not tagged, optional
server/
  server.js                  # the six endpoints of §6, plus the SSE stream
  finalise.js                # the scheduled draw job and the Pantheon sync (§5, §8)
                             # idempotent: never re-draws, never un-publishes a result
  pantheon.js                # the Pantheon boundary: Twirp client + in-process stub
  config.js                  # loads and validates the frozen artefacts; refuses to start otherwise
  runtime.js                 # the other half: operational settings and their defaults (§4.2)
  ciphertext.js              # admission checks — is this addressed to our chain and round?
  stats.js                   # per-player figures for the explorer (§7 of UI-SPEC)
  drand.js                   # multi-mirror beacon client; refuses to draw if mirrors disagree
  tlock.js  db.js  events.js  mirror.js
client/
  App.jsx                    # the stage machine (UI-SPEC §2)
  stages/                    # signin, submit, submitted, waiting, revealing, void, result
  explorer/                  # the seat plan: grid, player lens, round lens
  seal.js                    # builds and seals {user_input, client_nonce, client_timestamp}
public/
  app.js  app.css            # the built bundle — committed, part of the freeze
docs/
  seating-design.md          # the explainer page (publishable to players)
  PROTOCOL.md  PANTHEON-INTEGRATION.md  UI-SPEC.md  RUNBOOK.md
  IMPLEMENTATION_NOTES.md    # decisions, deviations, and what is not yet verified
tools/
  verify_template.py         # re-derives every invariant of the template
  verify_contribution.py     # second implementation of the byte encoding, in another language
  build-client.js            # builds and hash-pins the browser bundle
  pick-round.js              # target_round and cutoff, kept consistent
  decrypt-submissions.js     # participant-side verification
test/
  *.test.js                  # unit tests, incl. the roll-call against the snapshot
  e2e.js                     # RUNBOOK A2-A7 against live drand
deploy/
  Caddyfile, *.service, *.timer, README.md
```


## Hard rules

1. **Do not hand-edit `data/schedule_template.json`.** Any change breaks the proved properties. If it must change, re-run `tools/verify_template.py` and repeat the freeze from scratch.
2. **`roster.json`, `protocol.json`, `schedule_template.json` and `generate.js` are frozen and git-tagged together before submissions open.** After that a single changed byte voids the guarantee and the run restarts.
3. **Those four, and nothing else.** A parameter is frozen if changing it mid-window could change or steer the outcome, and operational otherwise (`PROTOCOL.md` §4.1). Freezing more than that is not extra caution: it means the organiser will eventually have a good reason to edit a tagged file, which is the habit the freeze exists to prevent.
4. **The quorum rule is frozen too** (see `PROTOCOL.md` §8). It must not be renegotiated when a 7-of-12 situation actually arises — deciding after the fact is itself a manipulable step.
5. **What a player submitted is never exposed before the reveal.** Only whether they submitted.
6. **Sync to Pantheon with `WIND_SHUFFLE_MODE_PRESCRIPTED`.** Any other mode re-randomises the winds and throws away most of what the template was optimised for.

## Verification tool

```
python3 tools/verify_template.py data/schedule_template.json
```

It re-derives every invariant from the round data rather than trusting the file's own `verified_properties` block, and exits non-zero if anything fails to match. Safe to hand to participants who want to check the template themselves.
