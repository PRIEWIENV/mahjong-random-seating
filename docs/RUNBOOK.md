# Pre-flight checklist

Ordered — do not skip steps. Steps marked with a lock enter the frozen state; nothing after that point may be modified.

## A. Implementation (no real players involved yet)

1. Build the app per `PROTOCOL.md`, `PANTHEON-INTEGRATION.md` and `UI-SPEC.md`.
2. Point it at a **test event** on the Pantheon instance with twelve dummy accounts, and set a target round only minutes away. Run the whole journey: sign in → submit → wait → reveal → result → sync.
3. Verify the sign-in gate both ways: an account registered to the event gets in; a valid Pantheon account that is *not* registered is refused with the right message.
4. Run the quorum boundaries: **8 submissions** must draw normally; **7 must be declared void** rather than crashing or drawing anyway.
5. Recompute one finished draw from `results.json` alone on a second machine — contributions, R, seed, permutation — and confirm it matches byte for byte. This is the test that catches a loose byte encoding in the contribution hash.
6. Check the sync actually took: read the prescript back with `GetPrescriptedEventConfig`, run `MakePrescriptedSeating` with `WIND_SHUFFLE_MODE_PRESCRIPTED`, and confirm Pantheon's seating for session 1 matches the app's own first round **including winds**. This is the step most likely to be silently wrong.
7. Confirm `results.json` carries R, the permutation, the drand signature and the participating local ids, and that those fields alone let a different machine recompute the same seat plan offline.

## B. Freeze

8. In Pantheon: make sure the event is marked prescripted, exactly the right twelve players are registered, and every one of them has a `local_id` (`UpdatePlayersLocalIds`).
9. Snapshot that roster into `data/roster.json` — `pantheon_event_id`, and the twelve `{local_id, person_id, title}`.
10. Choose the drand quicknet target round, convert it to a UTC timestamp, and fill `data/protocol.json`. Allow a generous window — **72 hours** is a good default — with `quorum: 8` and `user_input_max: 255`.
11. 🔒 Commit `roster.json`, `protocol.json`, `schedule_template.json` and `generate.js`, git-tag the commit (e.g. `frozen-v1`), and tell the players the tag.

## C. Submission window

12. Send the players one link — no personal links, no tokens: they sign in with the Pantheon accounts they already have. Tell them three things: one number between 0 and 255, once; you can close the page immediately; here is when the draw happens.
13. Chase anyone still missing as the cutoff approaches. The waiting view already shows who has not sealed a number, and reveals nothing about anyone's number.

## D. Draw and publication

14. After the cutoff, confirm the job ran, `results.json` was written and pushed, and the result stage renders.
15. Confirm the Pantheon sync succeeded (`pantheon_sync.status` in `results.json`, and the prescript visible in Pantheon's admin UI). If it failed, paste the prescript in by hand — do not re-run the draw.
16. Point the players at the result. Anyone inclined to check should be able to reproduce the same plan from public information alone.

## When things go wrong

- **Fewer than 8 submissions.** Per `PROTOCOL.md` §8: void the round, set a new target round, and have **everyone** — including those who already submitted — submit again. Old ciphertexts are bound to the lapsed round and cannot be reused.
- **drand unreachable at the target time.** A delay, not a security problem. The ciphertexts and the round are fixed, so the outcome is already determined; re-run the finalisation job when the beacon is reachable.
- **Pantheon sync fails.** The draw is still final; `results.json` is authoritative. Retry, then fall back to pasting the prescript manually.
- **A player cannot sign in.** Check they are registered to the event in Pantheon and that their `local_id` is set. If they were genuinely left off the roster, that is a freeze error: the honest fix is to void and re-freeze with the correct twelve, not to patch the roster mid-window.
