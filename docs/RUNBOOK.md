# Pre-flight checklist

> English · [简体中文](RUNBOOK.zh.md)

Ordered — do not skip steps. Steps marked with a lock enter the frozen state; nothing after that point may be modified.

Deployment is a step in this list, between **B** and **C**; [`../deploy/README.md`](../deploy/README.md) covers it. It cannot happen earlier: its first command checks out the tag step 11 creates, and that tag is what carries `data/protocol.json` and `data/roster.json` into a checkout.

## A. Implementation (no real players involved yet)

1. Build the app per `PROTOCOL.md`, `PANTHEON-INTEGRATION.md` and `UI-SPEC.md`.
2. Point it at a **test event** on the Pantheon instance with twelve dummy accounts, and set a target round only minutes away. Run the whole journey: sign in → submit → wait → reveal → result → sync.
3. Verify the sign-in gate both ways: an account registered to the event gets in; a valid Pantheon account that is *not* registered is refused with the right message.
4. Run the quorum boundaries: **8 submissions** must draw normally; **7 must be declared void** rather than crashing or drawing anyway.
5. Recompute one finished draw from `results.json` alone on a second machine — contributions, R, seed, permutation — and confirm it matches byte for byte, **whole file, no fields set aside**. This is the test that catches a loose byte encoding in the contribution hash.
    - Then run it again with `--snapshot events/snapshot.json`. That is a different check: the byte comparison recomputes from the payloads the file lists, so it cannot tell you the list is complete. The roll-call can, and `--verify` says loudly when it had no snapshot to use.
6. Check the sync actually took: read the prescript back with `GetPrescriptedEventConfig`, run `MakePrescriptedSeating` with `WIND_SHUFFLE_MODE_PRESCRIPTED`, and confirm Pantheon's seating for session 1 matches the app's own first round **including winds**. This is the step most likely to be silently wrong.
7. Confirm `results.json` carries R, the permutation, the drand signature, the participating local ids and `excluded_local_ids`, and that those fields alone let a different machine recompute the same seat plan offline. Confirm too that it carries *nothing else* — anything `generate.js` did not compute would have to be carved out of the byte-for-byte claim.

## B. Freeze

**Rehearse it first.** `npm run rehearse` performs the whole of B, C and D — roster
snapshot, freeze, tag, twelve sealed submissions, the chase list, the draw, the sync, and
the check a player does afterwards — in a throwaway git repository, against the Pantheon
stub and a real drand round three minutes away. It takes about three minutes and it is
the only way to find out that a step does not work at a time when that is still cheap. It
keeps earning it: `freeze.js` could not create the roster it exists to create, a refused
freeze wrote one anyway, the server announced itself at boot and then died, and the draw
excluded players whose ciphertexts were perfectly good.

`node tools/freeze.js` performs steps 10 and 11 and refuses on anything that would only
surface after the draw. Run it with `--write` to snapshot the roster, and `--tag <name>`
to commit and tag. Without `--tag` it changes nothing in git and prints the two commands.

8. In Pantheon: mark the event prescripted, register exactly the right twelve players, and give every one of them a `local_id` (`UpdatePlayersLocalIds`). Anyone attending but not playing should be `ignore_seating`.
9. Choose the target round: `node tools/pick-round.js --in 72h --write` sets `target_round`, `submission_cutoff_utc`, `chain_hash` and `chain_public_key` together so they cannot disagree. Allow a generous window — **72 hours** is a good default — with `quorum: 8` and `user_input_max: 255`.
    - `protocol.json` must contain **only** frozen parameters (`PROTOCOL.md` §4.1). The server refuses to start if an operational key is in there, and names it. Anything operational belongs in `data/runtime.json`, which is not tagged.
    - `chain_public_key` must be present and must be what `<drand api>/<chain_hash>/info` reports right now. Without it the client cannot tell which chain it is talking to.
    - This comes before the roster snapshot because the freeze refuses to run against a `target_round` of 0: freezing without a round is not freezing.
10. `node tools/freeze.js --event <id> --write` reads that roster back out of Pantheon and writes `data/roster.json` from it. It refuses if the seated count is not `total_slots`, if anybody lacks a usable `local_id`, if one account is registered twice, or if a player has no title — and on any of those it writes nothing at all, because a roster built from a registration list that was just refused is worse than no roster. Each of those otherwise lands after the draw: a missing `local_id` blocks the seat-plan sync, which runs once the seat plan already exists.
    - `--event <id>` is only needed for the first freeze of an event. After that the id is in `roster.json`, and it wins: a flag cannot re-point an existing freeze at a different event.
    - Without `--write` the command reports what it would do and changes nothing.
11. 🔒 `node tools/freeze.js --write --tag <name>`. Choose a name that says which draw this is; it is used once, and a second event or a §8 retry needs its own. The command writes it into `protocol.json`'s two reference fields, refuses a name git already has, and prints it in the announcement. Before it writes anything to git it re-derives every proved invariant of the template, rebuilds the browser bundle from source and diffs it against the committed one, and runs the unit tests. It commits `roster.json`, `protocol.json`, `schedule_template.json` and `generate.js` — those four and no others — plus the built bundle and its hash, then tags. `runtime.json` is gitignored and is deliberately not in the tag.
    - The bundle rebuild is the check that has to happen **here**. It needs esbuild, which the VPS does not have (`npm ci --omit=dev`); the VPS runs `--verify-hash`, which only compares the committed bundle to its committed hash and cannot tell you the hash was computed from different source.

    Add `--push` once a remote is configured. A tag that exists only on this machine is
    not a commitment: nobody can fetch it, and the organiser could still choose which
    commit it names after seeing the outcome (PROTOCOL.md §9). The command also anchors
    the commit id with OpenTimestamps and leaves the proof in
    `events/freeze/<tag>.commit.ots` — keep that file.

    Then check it from somewhere that is not this machine:

    ```sh
    git ls-remote --tags <repo url> <tag>
    ```

## C. Submission window

`ADMIN_TOKEN=... npm run serve` puts the dashboard on `/admin?token=…`. It is read-only:
the draw, the reset and the sync are commands run on the box, because §9 keeps anything
that could trigger or re-time the draw off HTTP entirely.
12. Send the players one link — no personal links, no tokens: they sign in with the Pantheon accounts they already have. `tools/freeze.js --tag` prints the announcement to copy, which says the three things that matter: one number between 0 and 255, once; you can close the page immediately; here is when the draw happens, and here is the tag.

    The announcement `freeze.js` prints now carries the commit id as well as the tag.
    Send both. If someone later hands you a tag pointing at a different commit, the
    message in the group chat is what contradicts it.
13. Chase anyone still missing as the cutoff approaches. The dashboard's first panel is that list by name, and the player-facing waiting view shows the same counts. Neither reveals anything about anyone's number — only *whether* they submitted, and when. `npm run rehearse` asserts both halves of that: the list is exactly the players with no submission, and no ciphertext reaches the page or its JSON.
    - Watch the pre-flight panel too. `Mirroring to the repository: DISABLED` means nobody but this server is timestamping the ciphertexts, and that third party is what the fairness argument leans on. `Pantheon adapter is the STUB` in production means sign-in is a fake.

## D. Draw and publication

14. After the cutoff, confirm the job ran and `results.json` was written and pushed. The dashboard's result panel shows `round_used`, R, the seed, the permutation and the digest of `results.json`; the result stage renders for players on its own.
15. Confirm the Pantheon sync succeeded — `status` in `events/sync.json`, shown in the dashboard's sync panel, and the prescript visible in Pantheon's admin UI. If it failed, paste `pantheon_prescript` from `results.json` in by hand and apply it with `WIND_SHUFFLE_MODE_PRESCRIPTED`. **Do not re-run the draw.** A sync failure never touches `results.json`, which is written once and stays authoritative.
    If `--verify` fails for someone on a fresh clone, have them check the checkout before
    the draw: `git check-attr text eol -- public/app.js` should report `-text`. Git
    rewriting line endings changes the bytes of a frozen artefact and therefore its
    digest, which looks exactly like tampering and is not.

16. Point the players at the result. Anyone inclined to check should be able to reproduce the same plan from public information alone:

    ```sh
    git clone <your repository> draw && cd draw
    git checkout <tag>                         # the one you announced in step 11
    git checkout origin/HEAD -- results.json events/    # written after the freeze
    node generate.js --verify results.json     # whole file, plus the roll-call
    python3 tools/verify_template.py data/schedule_template.json
    ```

    The third line is not optional and is easy to leave out. `results.json` and
    `events/snapshot.json` are written by the draw, which happens after the freeze, so
    they are on the default branch and not inside the tag. Checking the tag out on its
    own removes them, and the verification then fails on a missing file rather than on
    anything about the draw. The result page prints this same sequence, filled in.

    The first compares every byte of `results.json` against a fresh recomputation from
    the payloads it reveals, and then checks that `events/snapshot.json` accounts for
    every submission taken at the cutoff. The second re-derives the template's proved
    properties from the round data rather than trusting the file's own claims.

## E. After the event

There is a start procedure, so there is a finish procedure. Skipping it is not untidy, it
is wrong: everything one event leaves behind outlives it, and the next event inherits it.

**Stopping the relay.** Ctrl+C, or `systemctl stop`. It ends the streams the waiting page
holds, waits for anything still queued for the repository, and is gone in milliseconds. A
draw already in flight is left to finish. Press twice if you mean it anyway.

**Closing the event.** Once the seat plan is synced and you are done with the round:

```sh
node tools/end-event.js --dry-run     # what it would archive and clear
node tools/end-event.js
```

It archives the whole attempt into `events/rounds/<target_round>/` — the ciphertexts as
received, the roll taken at the cutoff, the result, the sync outcome, and the frozen
`protocol.json` and `roster.json` they ran under — verifies every digest in that archive,
and only then clears `var/` and the live files under `events/`. If the archive does not
verify, nothing is cleared.

**Do it before freezing the next event, not after.** Two reasons, one of which cannot be
repaired afterwards:

- `protocol.json` is overwritten by the next freeze. Closing first is what puts the round
  and chain these ciphertexts were sealed against into the archive beside them. Close
  afterwards and the archive still holds the evidence, but not what it was evidence
  *under*, and `tools/end-event.js` will say so.
- Until you close it, the previous event is still what the server answers with. `phaseOf`
  reads the persisted phase when no `results.json` is on disk, so the new event's players
  would be shown the old event's seat plan. The server now refuses to start in that state
  rather than serving it, which is how you find out if you get the order wrong.

A round that fell short of quorum is a different thing and is not closed this way. That is
§8's retry: same event, same twelve players, a new target round, and `tools/new-round.js`.

`events/` is gitignored, so with mirroring configured the archive goes to the repository
and with mirroring off it exists only on that machine. The tool says which.

## When things go wrong

- **Fewer than 8 submissions.** Per `PROTOCOL.md` §8: void the round, set a new target round, and have **everyone** — including those who already submitted — submit again. Old ciphertexts are bound to the lapsed round and cannot be reused. In that order:

  1. The job has already published `events/void.json` and archived the attempt under `events/rounds/<target_round>/`. Confirm the archive is there and complete; `tools/new-round.js --dry-run` checks it and changes nothing.
  2. Pick the new round and re-freeze: `node tools/pick-round.js --in 72h --write`, then commit `roster.json`, `protocol.json`, `schedule_template.json` and `generate.js` and git-tag again. Announce the new tag.
  3. `node tools/new-round.js`. It re-verifies the archive, then clears the live submissions and phase so the new round can open. It refuses if step 2 has not happened, and it never touches the archive.
  4. Tell the players three things: the new tag, that **all twelve** must submit again, and that the previous attempt is published at `events/rounds/<target_round>/` for anyone who wants to confirm it really was short of quorum. Once that round's beacon has landed, `tools/decrypt-submissions.js --dir events/rounds/<r>/submissions --protocol events/rounds/<r>/protocol.json` opens every archived ciphertext.

  Nothing from the voided attempt is deleted at any point. The reset clears live tables only, and refuses to run while the archive does not verify.
- **drand unreachable at the target time.** A delay, not a security problem. The ciphertexts and the round are fixed, so the outcome is already determined; re-run the finalisation job when the beacon is reachable.
- **One drand mirror is down.** Point `data/runtime.json` at another and restart. This touches nothing frozen and needs no announcement: the chain is pinned by `chain_hash` and `chain_public_key`, so an endpoint cannot substitute a different one (`PROTOCOL.md` §4.2).
- **Pantheon moved to a different port or host.** Same answer — `runtime.json`, restart, no re-tag.
- **Pantheon sync fails.** The draw is still final; `results.json` is authoritative. The job retries three times with backoff and records the outcome in `events/sync.json`; once a failure is recorded it stops retrying on its own, because the remedy is manual. Paste `pantheon_prescript` in by hand and apply it with `WIND_SHUFFLE_MODE_PRESCRIPTED`. Do not re-run the draw.
- **The server or the finalisation job died mid-sync.** Nothing to do. If no outcome was ever recorded, the next run of the draw job finishes the sync by itself; `results.json` is untouched either way, since it is written once.
- **`var/` was lost after the draw.** Nothing to do, and nothing is at risk. `results.json` outranks the database everywhere that matters, so the job will not re-draw and will not declare the round void, and the API serves the published result from disk.
- **A player cannot sign in.** Check they are registered to the event in Pantheon and that their `local_id` is set. If they were genuinely left off the roster, that is a freeze error: the honest fix is to void and re-freeze with the correct twelve, not to patch the roster mid-window.
