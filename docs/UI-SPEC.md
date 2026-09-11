# Player-facing UI specification

One page, one continuous flow. The player signs in, is carried through the draw, and ends on the seat plan. **No tab bar over the draw** — the six situations below are stages of one journey, not sections to browse. The app knows which stage the draw is in and shows that stage; earlier stages are behind them, not beside them.

There is exactly one destination that is not a stage: **how it works**, the explanation of the draw, reachable from a two-entry menu in the header on every screen (§10). It sits *beside* the journey rather than in it — opening it leaves the stage machine untouched and returning lands on whatever the draw has become meanwhile. A player who wants to know why they should trust this before typing a number must not have to leave the app to find out.

## 1. Design principles

- **One thing at a time.** Every stage has exactly one focal element. Supporting information is secondary in size, weight and colour, never competing.
- **The app moves, the player doesn't.** After submitting, the player never has to come back, refresh, or click anything to progress. Stage changes arrive over SSE and animate themselves in.
- **Motion carries meaning.** Every animation should encode something true about the protocol — sealing, waiting, opening — rather than decorate. If an animation could be removed without losing information, it is too long.
- **Honest waiting.** The waiting stage shows real state: the actual drand round, the real count, a countdown driven by server time. No fake progress bars.
- **Respect `prefers-reduced-motion`.** Every transition has a cross-fade fallback; nothing important is conveyed by motion alone.

Suggested stack: any modern SPA framework, a single route, a state machine (`xstate` or a plain reducer) driving a `<main>` that cross-fades between stages. Layout transitions read best with a shared-element library (Framer Motion's `layoutId` or the View Transitions API). None of this is prescriptive.

## 2. The stage machine

```
signin ──▶ submit ──▶ submitted ──▶ waiting ──┬─▶ revealing ──▶ result
                                              └─▶ void
```

Stage is derived, never stored client-side: `GET /api/status` gives the draw's phase, `GET /api/me` says whether this player has submitted. A player who signs in after the cutoff lands directly on `waiting`, `result` or `void` — the flow is the same for everyone, only the entry point differs.

| Stage | Shown when |
|---|---|
| `signin` | no session |
| `submit` | phase `open`, this player has not submitted |
| `submitted` | the moment their own submission is accepted (transient, ~2.5 s, then `waiting`) |
| `waiting` | phase `open` and already submitted, or phase `awaiting_round` |
| `revealing` | phase `revealing` (transient, driven by the reveal animation) |
| `void` | phase `void` |
| `result` | phase `done` |

## 3. Sign-in

A centred card: event name, one line of explanation ("Sign in with your Pantheon account to take part in the seating draw"), email, password, submit.

The heading carries the event's own name when Pantheon has given one — "2026 Spring Open seating draw", not "Seating draw". A club runs several of these a year and a player may have two open; a page that cannot be told apart from last month's is a page people submit into by mistake. The name is read from Mimir at boot and is not frozen: it is a label, and no value it can take changes who sits where (PROTOCOL.md §4.2).

The password field carries a reveal toggle, off by default. Typing a password blind on a phone in a noisy clubhouse is how three failed attempts become "Pantheon has forgotten me".

The browser authenticates against Pantheon directly and posts only the returned token pair to our backend (see `PANTHEON-INTEGRATION.md` §2). Two failure messages, distinct and non-confusable:

- wrong credentials → "Pantheon did not recognise that email and password."
- valid account, not in the event → "That account isn't registered for this event, so it can't take part in the draw."

The second is a normal outcome, not an error state — style it as information, not alarm.

## 4. Submitting a number

The focal element of the whole app. A single large numeric field, the number typeset big enough to feel consequential (48–64 px), with:

- **Range** `0 … 255`, validated live. Inline hint: "any whole number from 0 to 255 — a lucky number, a birthday, anything".
- **A "Roll for me" button** using `crypto.getRandomValues`, which animates digits settling into place. It is a convenience for players who would rather not choose; the field starts empty and typing a number is the expected path.
- **One line of why**, no more: "Your number is sealed in your browser and cannot be read by anyone — including us — until the draw opens."
- **Submit** is the only primary action on screen.

On submit the client builds `{user_input, client_nonce, client_timestamp}` — the nonce being 16 bytes from `crypto.getRandomValues` — seals the payload with tlock against the chain and round from the frozen `protocol.json` (the endpoint that chain is reached through comes from `/api/status`, since it is not frozen — `PROTOCOL.md` §4.2), and posts only the ciphertext. The nonce is generated silently; it is what guarantees the contribution is uniformly random whatever the player typed, and it is revealed with everything else at the draw so the player can still verify their own number went in. Show a brief inline working state — sealing is a real computation and should not look instant if it isn't.

Do not offer an edit or withdraw affordance. A submission is final by design; say so before the button, not after.

**Both deadlines, on this screen.** A quiet band under the heading carries the cutoff — as a live countdown *and* as an exact instant — and the draw time beneath it, each in the reader's own timezone with the offset named, and both in UTC underneath. They are different instants, `reveal_gap_seconds` apart (PROTOCOL.md §9), and until now neither appeared anywhere on the one screen where a player still has something to do. Inside the last half hour the band takes the warning colour and says so.

## 5. Submitted, and waiting

**Submitted** is a short confirmation, not a page: the number card folds/locks shut — an envelope-seal gesture — and a checkmark resolves under it with "Sealed. Nothing more is needed from you." After ~2.5 s it gives way to `waiting` on its own.

**Waiting** is the stage most players will actually sit on, possibly for days, and it should be genuinely informative:

- **Countdown** to the target round, as the visual anchor — a ring or a large clock, driven by `server_time_utc` from `/api/status` (with the client-server offset measured once at load) so it never drifts.
- **A timeline**, not a line of small print. The two fixed instants are a *sequence* — submissions close, and `reveal_gap_seconds` later the beacon that opens them exists — and the drand round is what ties both to something nobody here operates. So: a track with the cutoff and the draw marked on it, a marker for now, each instant labelled in local time with its offset, and beneath it the current round and the target round typeset as figures with the distance between them. The left-hand segment has no honest origin (submissions may have opened a fortnight ago), so it is drawn as one reveal-gap of lead-in and the marker pins to its edge, labelled, while now is earlier than that. Inventing a start date is the same lie as an invented progress bar.
- **Twelve envelopes** — one card per player, carrying the SHA-256 of the ciphertext being held, short by default and stretching to its full length on hover or tap. Who has sealed is public; *what* they sealed is not, and a digest of a ciphertext is neither: the ciphertext itself is published as it arrives (PROTOCOL.md §5) and only the beacon opens it. A count of twelve rows is our word for it; a fingerprint a player can keep and check afterwards is not. The player's own card is marked.
- **Quorum marker** on the tally: the threshold of 8 drawn on the track, so a player can see at a glance whether the draw is already safe. Below that threshold the fill is amber rather than green — at this count the round would be void if the cutoff arrived now, and a green bar saying so reads as "fine".
- **After the cutoff, an empty slot stops meaning "not yet" and starts meaning "never".** They look identical in a chip list and are opposite facts, so the cards say which. A player who is themselves unsealed at that point gets the page desaturated and a card of its own: submissions are closed, they are not in this draw, it changes nothing for anybody else, and why a late number cannot be accepted.
- **drand status** — whether the beacon is advancing and when it was last seen. The round numbers themselves live in the timeline; if the beacon goes stale, say so plainly rather than hiding it.
- **After the countdown reaches zero**, three states and not one. The server never draws — a separate job does, on a timer — so the page must distinguish "the result is a minute away" from "nobody is computing it". While `status.draw.overdue` is false it says *Drawing*; once it is true it says the draw has not run, how late it is, that the outcome was fixed at the cutoff and cannot be affected, and to contact the organiser. An animation that runs forever is the same lie as an invented progress bar.

Everything here updates over SSE. If the stream drops, fall back to polling `/api/status` and show a subdued "reconnecting" note. The interval is whatever the status payload's `status_poll_interval_ms` says, defaulting to 15 s.

## 6. The reveal

At the cutoff, with quorum met, the draw runs itself and the waiting view transitions into it. The sequence should read as one continuous idea — sealed things opening, combining, and settling into an order:

1. **The beacon lands.** The drand element resolves from "waiting for round N" to the actual round value.
2. **Envelopes open**, in a quick stagger, each revealing its player's number.
3. **The numbers fold together** into the single seed — a visual XOR, values collapsing into one.
4. **The seed shuffles the names.** Twelve name chips scatter and settle into the template's twelve positions.
5. **The seat plan resolves** underneath and the explorer becomes interactive.

Budget the whole thing at about 6–8 seconds, skippable with a click, and short-circuited entirely for a player arriving after it has already happened — they get the finished result, not a replay. Under `prefers-reduced-motion`, steps 2–4 become a single cross-fade with the same information stated in text.

**If quorum is not met** the app goes to `void` instead: a calm, non-blaming page stating that fewer than eight of twelve sealed a number, that the round is void by the rule fixed before it started, and that a new date will be announced and *everyone* will submit again. Show the count that was reached and the threshold. No countdown, no retry button — there is nothing for the player to do here.

## 7. Result: instructions, then the seat plan

The result stage opens with what the player needs *next*, before the data they will browse:

- their own first-round table and seat, stated in one sentence;
- when and where play starts, if configured;
- a line confirming the plan has been synced to Pantheon, so they know the mobile assistant will agree with what they see here;
- a quiet link to how the draw can be re-verified independently;
- the sealed ciphertexts, their fingerprint and its timestamp proof, downloadable — the same card as during the wait. Offering them only before the draw withdrew the evidence at the exact moment it became checkable.

Below that sits the seat plan explorer.

### The explorer

One canvas, three lenses, no tabs — the lens follows the selection:

- **Nothing selected — everyone.** The full grid: twelve rows (players) × eleven columns (rounds), each cell coloured by table and carrying the wind letter. This is the same picture as the template figure in `seating-design.md`, with real names.
- **A player selected** (click their row, or their name anywhere in the app). Their row lifts; everything else recedes. A detail panel opens beside the grid with that player's tournament: round by round, which table, which wind, and who the other three are — each of those three annotated as *your upper hand*, *your lower hand* or *opposite*.
- **A round selected** (click a column header). The grid dims to that column and the three tables for that round render as actual tables — four seats in E/S/W/N positions with names in place, drawn the way the players will find them in the room.

Selections are exclusive and always escapable (click the background, or press Escape). The URL should carry the selection (`?player=…`, `?round=…`) so a player can send someone a link to their own schedule.

### Per-player statistics

The detail panel also carries the numbers that make the fairness visible:

- **Winds** — E/S/W/N counts. Always `{3,3,3,2}`; say so, so the player knows it is by construction rather than luck.
- **Tables** — counts at each of the three tables. `{4,4,3}` for nine players, `{5,3,3}` for three; if this player is one of the three, name it as the one unavoidable imbalance and link to the explanation.
- **Opponents** — a row per other player: times at the same table (always 3), and the split of those three meetings into *opposite* (always 1), *they were upstream of you*, and *you were upstream of them*.
- **Perfect pairs** — how many of this player's eleven rivalries are balanced, i.e. one meeting each way. Mark the unbalanced ones in the opponents list, since those are the only asymmetries left in the whole schedule.

All of this is derived from the seat plan; `GET /api/result` should return it precomputed so the client does no combinatorics.

### The evidence card

Shown twice: during the wait, where the fingerprint is a commitment twelve people are asked to compare while nobody can open anything; and on the result, where the same file is what a verifier recomputes from. One block, not three: the claim that it is timestamped into Bitcoin, the files that back the claim, and the way to check them belong together — split apart, the page asserts something in one paragraph and offers a download in another, leaving the reader to work out that the second is how you check the first.

The check is a web page you drag two files onto ([opentimestamps.org](https://opentimestamps.org), Verify), not a command line. A player who has to install a Python package in order to verify the draw does not verify the draw.

Call the file what it is — the ciphertexts people submitted — not "the roll". `snapshot.json` is its name on disk and in the archive; that name does not have to be the words a player reads.

## 8. Data the client needs

```
GET /api/status   → phase, submitted_count, quorum, total_slots, submitted_local_ids,
                    submissions[{local_id, digest, received_at}],   // sha256 of the
                    //   ciphertext, which is itself already public; never its contents
                    cutoff_utc, target_round_utc, reveal_gap_seconds, target_round,
                    roll{digest, submitted_count, anchored, calendars},
                    event_title,      // from Mimir; null where it cannot be reached
                    draw{round_due_utc, seconds_late, grace_seconds, overdue},
                    drand{latest_round, healthy, last_seen_utc},
                    server_time_utc
GET /api/me       → local_id, title, submitted
GET /api/result   → seating (11 rounds × 3 tables × 4 seats, with names),
                    contributions, r, permutation, drand_signature,
                    excluded_local_ids,
                    stats: per player {winds, tables, opponents[], perfect_pairs},
                    pantheon_sync
                    // a composed view: results.json + computed stats +
                    // events/sync.json. The files, not this, are what a
                    // verifier uses (PROTOCOL.md §4.3).
GET /api/events   → SSE: status changes
```

## 9. Non-negotiables

- No stage the player has to navigate to by hand, and nothing in the header that turns the draw's own stages into sections. The one menu entry that is not a stage leads out of the draw and back into it unchanged.
- The waiting view never invents progress it cannot observe.
- What each player submitted is never exposed before the reveal — not in an endpoint, not in a payload, not in a debug header. Only *whether* they submitted, and the fingerprint of the sealed envelope, which is a digest of an already-public ciphertext and opens nothing.
- The reveal is skippable and never blocks access to the result.
- Everything readable on a phone: the twelve-by-eleven grid needs a considered small-screen treatment (horizontal scroll with a pinned name column is fine; a cramped illegible grid is not).

## 10. How it works

One page, generated at build time from `docs/seating-design.md` and its Chinese counterpart — not written again in the client. The page a player reads and the document an auditor reviews have to be the same text; a copy drifts, and the paragraph that drifts is the one explaining why the draw cannot be steered.

Reachable from the header on every screen, in both directions, and escapable with Escape. It carries a contents list that says which section the reader is in, the document's figures, and its diagrams. Returning leaves the draw exactly where it was.

Both languages are full translations of the same document, and `test/md-to-page.test.js` fails if one gains or loses a section, a figure or a diagram.
