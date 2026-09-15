# Checklist for an event

> English · [简体中文](RUNBOOK.zh.md)

One line per step, in order. The full instructions for every line are in
[`../deploy/README.md`](../deploy/README.md) — the guide's section is given at the end of
each line. Read the guide end to end the first time; use this page the second. Steps
marked 🔒 enter the frozen state: after them nothing frozen may change.

## A. Before the first event ever

- [ ] `npm run rehearse` passes on your computer — the whole of B, C and D, in a sandbox, against the Pantheon stub
- [ ] `npm run e2e` passes against a test event on your Pantheon — A2 the player's journey, A3 the sign-in gate both ways, A4 quorum: 8 draws and 7 is void, A5 recompute a draw from `results.json` alone, A6 the sync read back with winds, A7 the file alone is enough offline
- [ ] `node tools/pantheon-fixture.js --accounts` built that test event, twelve accounts with known passwords included

## B. Freeze — on your computer

8. [ ] In Pantheon: the event is prescripted, exactly twelve are registered, every one has a `local_id`, anyone attending without playing is `ignore_seating` — [guide §1](../deploy/README.md#1-the-event-in-pantheon)
9. [ ] `node tools/pick-round.js --in 72h --write` — [guide §3](../deploy/README.md#3-choose-the-target-round)
10. [ ] `node tools/freeze.js --event <id> --write` — writes `data/roster.json` out of Pantheon, or refuses and writes nothing — [guide §4](../deploy/README.md#4-freeze-and-tag)
11. 🔒 [ ] `node tools/freeze.js --write --tag <name> --push` — then `git ls-remote --tags <repo> <name>` from another machine, and keep `events/freeze/<name>.commit.ots` — [guide §4](../deploy/README.md#4-freeze-and-tag)

## Deploy — on the server

- [ ] Node 24+, clone, `git checkout <tag>`, `npm ci --omit=dev`, `node tools/build-client.js --verify-hash` — [guide §5](../deploy/README.md#5-install-at-the-tag)
- [ ] `.env` written and `chmod 600`; `data/runtime.json` with the Pantheon URLs and `trust_proxy: true`; a hosts entry if Pantheon shares the box — [guide §6](../deploy/README.md#6-configure)
- [ ] `node tools/setup-mirror.js` — the GitHub token, proved to write, into `.env`; without it nothing is published as it arrives — [guide §6](../deploy/README.md#6-configure)
- [ ] certificate, nginx with the Frey origin in `connect-src` — [guide §7](../deploy/README.md#7-tls-and-the-reverse-proxy)
- [ ] started, and started again after a reboot — [guide §8](../deploy/README.md#8-start-it)
- [ ] the four `curl` checks, `/admin` all green, `tools/setup-mirror.js --check`, `tools/check-signin.js --email <yours>` and `--admin` — [guide §9](../deploy/README.md#9-check-before-you-announce)

## C. Submission window

12. [ ] Send the announcement the freeze printed: one link, the tag, the commit id, the cutoff — [guide §10](../deploy/README.md#10-announce)
13. [ ] Chase the missing from `/admin`; watch its pre-flight panel — [guide §11](../deploy/README.md#11-during-the-window)

## D. Draw and publication

14. [ ] After the cutoff and the beacon: `/admin` shows `round_used`, R, the permutation; `results.json` is in the repository — [guide §12](../deploy/README.md#12-the-draw)
15. [ ] `events/sync.json` says ok and the seating is visible in Pantheon; if not, paste `pantheon_prescript` in by hand with `WIND_SHUFFLE_MODE_PRESCRIPTED` — never re-run the draw — [guide §12](../deploy/README.md#12-the-draw)
16. [ ] Point players at the result page; its verification block is the one in [guide §13](../deploy/README.md#13-what-a-player-can-check)

## E. After the event

- [ ] `node tools/end-event.js --dry-run`, then `node tools/end-event.js` — **before** the next freeze — [guide §14](../deploy/README.md#14-close-the-event)

## F. The final round

Only for an event whose `protocol.json` has a `final_round` block (PROTOCOL.md §11). Weeks after section E would otherwise have run — so **do not close the event first**; `end-event.js` refuses once a lock exists anyway.

The whole of this section is one rule: the standings and the beacon are published together, before that beacon exists. Everything else follows.

**If somebody drops out part-way through**, before step 17 and at the time it happens, not at the lock:

- The substitute plays on that seat's **existing Pantheon registration** — do not register them as a thirteenth person. The seat is a `local_id`; keeping it intact is what makes the standings come out as twelve rows of eleven games, and the draw is then exactly what it would have been.
- Write `data/substitutes.json` (copy `data/substitutes.example.json`): the seat, the round the substitute came in, who left, who took over, and **the league rule that allows it**. It will not load without the reason.
- Nothing else to do. `lock-final.js` shows it, checks it against the frozen roster, and copies it into the lock so it falls under the same fingerprint and timestamp as the standings. PROTOCOL.md §11.6 says why this record can be written late without becoming a lever.

17. [ ] All eleven rounds played and entered in Pantheon. `node tools/lock-final.js` — a dry run, it writes nothing — and read what it prints: twelve players, eleven games each, and the order it recomputed matching the one Mimir gave
17a. [ ] If the dry run says the standings are **empty**, the event is hiding its results while it is played. Re-run with `--as-admin` — and read the warning it then prints: that mode also counts games that are *started but unfinished*, so nothing may still be at a table

18. [ ] `node tools/lock-final.js --in 45m --confirm`. It writes `events/final/lock.json`, mirrors it, and timestamps it. **Announce the sha256 it prints to all twelve now**, along with the drand round and the time it is due — after that round lands, the digest proves nothing
19. [ ] Once the round has landed: `node tools/draw-final.js --dry-run`, then `node tools/draw-final.js`. It waits for the beacon, publishes `final.json`, and writes all twelve prescript blocks to Pantheon
20. [ ] `events/final/sync.json` says ok. If not, paste **all twelve** blocks of `pantheon_prescript` in by hand with `next_session_index = 12` and `WIND_SHUFFLE_MODE_PRESCRIPTED` — never re-run the draw

Two things worth knowing before you are asked:

- The tables come from the standings after **eleven** rounds. If all twelve games weigh the same, the final standings may differ — the four at table one are not necessarily the final top four. That is the format, not a fault.
- Some players finish 4-3-3-2 rather than 3-3-3-3, and the result page tells each of them the odds they actually had (1 in *m*, where *m* is how many at their table needed the same wind). Roughly nine of the twelve complete on average; all twelve only about 3.7% of the time. [seating-design.md](seating-design.md) has the argument in full.
## When things go wrong

| Symptom | Do | Guide |
|---|---|---|
| Fewer than 8 submissions | Nothing is lost: the attempt is archived and `void` is published. `node tools/new-round.js --dry-run`, pick a new round, re-freeze and re-tag, `node tools/new-round.js`, tell **all twelve** to submit again | [§15](../deploy/README.md#15-when-something-goes-wrong) |
| drand unreachable at draw time | Wait. The job retries every minute; the outcome was fixed at the cutoff | [§15](../deploy/README.md#15-when-something-goes-wrong) |
| A drand mirror is down | Edit `data/runtime.json`, restart. Nothing frozen changes, no re-tag | [§15](../deploy/README.md#15-when-something-goes-wrong) |
| Pantheon moved | Same: `runtime.json`, restart | [§15](../deploy/README.md#15-when-something-goes-wrong) |
| The sync failed | Paste the prescript by hand. Do not re-run the draw | [§12](../deploy/README.md#12-the-draw) |
| The server died mid-draw, or `var/` is gone | Start it again. It finishes what was left and never re-draws | [§15](../deploy/README.md#15-when-something-goes-wrong) |
| The standings tool refuses: "not the order rating desc produces" | Mimir did not apply `order_by`. Set `pantheon.rating_order_by` in `runtime.json` to a column it does accept; nothing is written until the two orders agree | [PROTOCOL §11.5](PROTOCOL.md) |
| Two players are tied across the 4\|5 or 8\|9 boundary | Settle it by the league's own rule, fix the standings in Pantheon, then record the rule: `--tiebreak 4 --tiebreak-reason "…"`. The tool never breaks a tie itself | [PROTOCOL §11.5](PROTOCOL.md) |
| A player cannot sign in | `node tools/check-signin.js --email <theirs>` says which step failed | [§9](../deploy/README.md#9-check-before-you-announce) |
| Nothing is drawing | The `/admin` row **The draw job has run** says whether the timer is alive | [§15](../deploy/README.md#15-when-something-goes-wrong) |
