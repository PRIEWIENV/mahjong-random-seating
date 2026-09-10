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

- The Twirp client **has** now been run against a real Pantheon (`cdda3fc`, in Docker under WSL 2), twice: once against a borrowed event, and once end to end against a fresh one where all twelve players signed in with an email and a password (`tools/pantheon-fixture.js --accounts`), sealed real ciphertexts, and had the resulting seat plan read back out of Pantheon seat by seat. Nine things were wrong across the two rounds and not one of them failed loudly — see [`docs/PANTHEON-INTEGRATION.md`](docs/PANTHEON-INTEGRATION.md) §2, §3, §5.1 and §6. Three are worth knowing before you deploy: Frey needs **two** addresses, because the browser calls it as well as the backend; a sign-in that fails for any reason used to be reported to the player as a wrong password; and `MakePrescriptedSeating` randomises the winds unless the caller states the mode, which Forseti does and a script might not. What is still outstanding is narrower: **the instance you actually deploy against**. Pantheon moves, §5.1 is a fact about one commit, and the fixture plus §6 make re-checking it a half-hour job rather than a research project.
- **The operational half of the RUNBOOK has been rehearsed, not performed.** `npm run rehearse` runs sections B, C and D end to end in a throwaway repository — roster snapshot, freeze, tag, twelve sealed submissions, the chase list, the draw, the sync, and the check a player does afterwards — against the Pantheon stub and a real drand round. Every step passes. What is left is doing it for an actual event, with real registrations and a deployment, and with the stub replaced by the instance in the first bullet.
- **Nothing here has run a draw for people who did not know it was a test.** Everything above is reproducible and checked; none of it has yet been the thing twelve players were waiting on. That is the only item on this list that cannot be closed by writing more code.

**Read [`docs/IMPLEMENTATION_NOTES.md`](docs/IMPLEMENTATION_NOTES.md) before freezing.** One item there is about what "verified" actually means:

- `results.json` contains only what `generate.js` computes, so `--verify` compares every byte with no field set aside. The Pantheon sync outcome lives in `events/sync.json` instead, because it records something that happened after the file was written. Separately, the byte comparison recomputes *from* the payloads the file lists, so it cannot prove that list is complete; `events/snapshot.json` is what closes that, and `--verify` runs the roll-call whenever it is available.

`protocol.json` holds the frozen parameters and nothing else. Operational settings — the drand endpoint, the Pantheon base URLs, poll intervals — live in `data/runtime.json`, are not tagged, and may be changed mid-window. [`docs/PROTOCOL.md`](docs/PROTOCOL.md) §4.1 gives the test that decides which side a parameter falls on; the loader refuses to start if an operational key turns up in the frozen file.

Read `docs/PROTOCOL.md` end to end before changing code, particularly §7 (algorithm) and §8 (quorum and failure handling). The rules there are where the fairness comes from; they should not be rewritten to whatever seems more reasonable in the moment.

## Running it

```sh
npm ci
npm test                  # 243 unit tests, offline, ~6s
npm run verify-template   # re-derives every invariant of the frozen template
npm run e2e               # RUNBOOK A2-A7 against live drand, ~3 min
npm run rehearse          # RUNBOOK B/C/D end to end in a sandbox, ~5 min
```

`.github/workflows/reproducibility.yml` runs the first three on every push, on Linux and
on Windows with `core.autocrlf=true`, plus `build-client.js --check` — the rebuild from
source that `--verify-hash` cannot stand in for, because it needs esbuild. It runs them on
a clone nobody has touched, which is the point: the checkout bug in
[`docs/IMPLEMENTATION_NOTES.md`](docs/IMPLEMENTATION_NOTES.md) §6d could not appear in the
tree where the files were written. `e2e` is not in it — live drand, three minutes.

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

Set `ADMIN_TOKEN` to put the organiser's dashboard on `/admin?token=…`: submission
progress and who is still missing, the pre-flight checks, the frozen artefacts'
fingerprints, the result, the Pantheon sync, and every past attempt. It is read-only, and
without `ADMIN_TOKEN` the route does not exist at all.

```sh
ADMIN_TOKEN=$(openssl rand -hex 16) PANTHEON_MODE=stub npm run serve
node tools/freeze.js                            # RUNBOOK 8-11, checks only
node tools/freeze.js --write --tag frozen-v1    # ...and commit and tag
```

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
  rounds.js                  # voided attempts: archive, verify, and open the next one
  admin.js                   # the organiser's read-only dashboard (RUNBOOK C/D)
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
  new-round.js               # after a void: verify the archive, then open the next attempt
  freeze.js                  # RUNBOOK 8-11 as one command: snapshot, check, commit, tag
  rehearse.js                # RUNBOOK B/C/D end to end in a sandbox, before the day
  pantheon-fixture.js        # builds the test event on a local Pantheon (dev only)
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
5. **A voided attempt is archived, never deleted.** Its ciphertexts, the roll at the cutoff and the `protocol.json` it ran under are published under `events/rounds/<target_round>/` so anyone can confirm the round really was short of quorum. Opening the next attempt requires re-freezing first, and `tools/new-round.js` refuses while the archive does not verify.
6. **What a player submitted is never exposed before the reveal.** Only whether they submitted.
7. **Sync to Pantheon with `WIND_SHUFFLE_MODE_PRESCRIPTED`.** Any other mode re-randomises the winds and throws away most of what the template was optimised for.

## Verification tool

```
python3 tools/verify_template.py data/schedule_template.json
```

It re-derives every invariant from the round data rather than trusting the file's own `verified_properties` block, and exits non-zero if anything fails to match. Safe to hand to participants who want to check the template themselves.
