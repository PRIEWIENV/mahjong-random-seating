# Pre-flight checklist

Ordered — do not skip steps. Steps marked with a lock enter the frozen state; nothing after that point may be modified.

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

8. In Pantheon: make sure the event is marked prescripted, exactly the right twelve players are registered, and every one of them has a `local_id` (`UpdatePlayersLocalIds`).
9. Snapshot that roster into `data/roster.json` — `pantheon_event_id`, and the twelve `{local_id, person_id, title}`.
10. Choose the drand quicknet target round, convert it to a UTC timestamp, and fill `data/protocol.json` (`tools/pick-round.js --in 72h --write` sets `target_round`, `submission_cutoff_utc`, `chain_hash` and `chain_public_key` together, so they cannot disagree). Allow a generous window — **72 hours** is a good default — with `quorum: 8` and `user_input_max: 255`.
    - Check that `protocol.json` contains **only** frozen parameters (`PROTOCOL.md` §4.1). The server refuses to start if an operational key is in there, and names it. Anything operational belongs in `data/runtime.json`, which is not tagged.
    - Confirm `chain_public_key` is present and is the key `<drand api>/<chain_hash>/info` reports right now. Without it the client cannot tell which chain it is talking to.
11. 🔒 Commit `roster.json`, `protocol.json`, `schedule_template.json` and `generate.js` — those four and no others — git-tag the commit (e.g. `frozen-v1`), and tell the players the tag. `runtime.json` is gitignored and is deliberately not in the tag.

## C. Submission window

12. Send the players one link — no personal links, no tokens: they sign in with the Pantheon accounts they already have. Tell them three things: one number between 0 and 255, once; you can close the page immediately; here is when the draw happens.
13. Chase anyone still missing as the cutoff approaches. The waiting view already shows who has not sealed a number, and reveals nothing about anyone's number.

## D. Draw and publication

14. After the cutoff, confirm the job ran, `results.json` was written and pushed, and the result stage renders.
15. Confirm the Pantheon sync succeeded (`status` in `events/sync.json`, also surfaced by `GET /api/result`, and the prescript visible in Pantheon's admin UI). If it failed, paste `pantheon_prescript` from `results.json` in by hand — do not re-run the draw. A sync failure never touches `results.json`, which is written once and stays authoritative.
16. Point the players at the result. Anyone inclined to check should be able to reproduce the same plan from public information alone.

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
- **The server or the finalisation job died mid-sync.** Nothing to do. If no outcome was ever recorded, the next timer tick finishes the sync by itself; `results.json` is untouched either way, since it is written once.
- **`var/` was lost after the draw.** Nothing to do, and nothing is at risk. `results.json` outranks the database everywhere that matters, so the job will not re-draw and will not declare the round void, and the API serves the published result from disk.
- **A player cannot sign in.** Check they are registered to the event in Pantheon and that their `local_id` is set. If they were genuinely left off the roster, that is a freeze error: the honest fix is to void and re-freeze with the correct twelve, not to patch the roster mid-window.
