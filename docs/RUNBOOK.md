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

## When things go wrong

| Symptom | Do | Guide |
|---|---|---|
| Fewer than 8 submissions | Nothing is lost: the attempt is archived and `void` is published. `node tools/new-round.js --dry-run`, pick a new round, re-freeze and re-tag, `node tools/new-round.js`, tell **all twelve** to submit again | [§15](../deploy/README.md#15-when-something-goes-wrong) |
| drand unreachable at draw time | Wait. The job retries every minute; the outcome was fixed at the cutoff | [§15](../deploy/README.md#15-when-something-goes-wrong) |
| A drand mirror is down | Edit `data/runtime.json`, restart. Nothing frozen changes, no re-tag | [§15](../deploy/README.md#15-when-something-goes-wrong) |
| Pantheon moved | Same: `runtime.json`, restart | [§15](../deploy/README.md#15-when-something-goes-wrong) |
| The sync failed | Paste the prescript by hand. Do not re-run the draw | [§12](../deploy/README.md#12-the-draw) |
| The server died mid-draw, or `var/` is gone | Start it again. It finishes what was left and never re-draws | [§15](../deploy/README.md#15-when-something-goes-wrong) |
| A player cannot sign in | `node tools/check-signin.js --email <theirs>` says which step failed | [§9](../deploy/README.md#9-check-before-you-announce) |
| Nothing is drawing | The `/admin` row **The draw job has run** says whether the timer is alive | [§15](../deploy/README.md#15-when-something-goes-wrong) |
