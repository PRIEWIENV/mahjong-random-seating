# Pantheon integration

> English · [简体中文](PANTHEON-INTEGRATION.zh.md)

The draw app sits alongside a self-hosted [Pantheon](https://github.com/MahjongPantheon/pantheon) instance on the same server. Pantheon supplies identity and the event roster, and receives the finished seat plan.

Everything below was read off the Pantheon protocol definitions in `Common/proto/` on `master` and then **checked against a running instance** (Pantheon `cdda3fc`, September 2026). That check was worth doing: the proto files and the running service disagreed in four places, every disagreement was silent, and §6 records what it took to find them. Re-run it against the instance you are actually going to use — the values in §5 are facts about one deployment, not about Pantheon in general.

## 1. Services and transport

Pantheon is a set of services that talk [Twirp](https://twitchtv.github.io/twirp/) (protobuf over HTTP). The two that matter here:

- **Frey** — accounts and authentication.
- **Mimir** — events, registered players, sessions, seating.

Because both run on the same host as this app, backend-to-Pantheon calls should go over localhost rather than the public hostname.

## 2. Sign-in, and restricting it to one event

The requirement is that only players registered to a specific event can sign in.

**Do not let this app handle Pantheon passwords.** The browser authenticates against Frey directly and hands our backend only the resulting pair:

1. Browser → Frey `Authorize({email, password})` → `{person_id, auth_token}`.
2. Browser → our `POST /api/session` with `{person_id, auth_token}`.
3. Backend → Frey `QuickAuthorize({person_id, auth_token})` to verify the pair is genuine.
4. Backend → Mimir `GetAllRegisteredPlayers({event_ids: [EVENT_ID]})` → `RegisteredPlayer[]`, each carrying `id` (the person id), `title` and `local_id`.
5. The sign-in succeeds only if `person_id` appears in that list **and** in the frozen `roster.json`. Otherwise: reject with "this account is not registered for the event".
6. On success the backend issues its own httpOnly session cookie carrying `local_id`.

Checking against both the live Pantheon roster and the frozen snapshot is deliberate. The live check is the authorisation; the frozen check makes sure a roster edit made after the freeze cannot quietly enlarge or alter the field of twelve.

### What the credential actually is

"This app never handles a Pantheon password" is true and worth keeping true, but it is not the whole statement, because the thing the app *does* handle is stronger than the phrase suggests.

Frey's `Authorize` takes the raw password and does the hashing itself (`Frey/app/models/auth.ts`):

```ts
const authToken = makeClientHash(payload.password, personData[0].auth_salt);
await verifyHash(authToken, personData[0].auth_hash);
return { personId: personData[0].id, authToken };
```

`makeClientHash` is `sha384(password + auth_salt)`, and `verifyHash` bcrypt-compares it against the stored hash. Two things follow.

**The password crosses the network in the request body.** Only TLS protects it. Frey exposes no way to hash first — that would need the account's salt, and an endpoint handing out a salt for any email is an account-enumeration oracle. So this is the only path Pantheon offers, and the security of it is exactly the security of the transport. It is also the strongest single reason the deployment must not run on plain HTTP: the password crossing in the clear is not this event's to risk, it is the player's Pantheon account.

**The returned `auth_token` is password-equivalent.** It is a deterministic function of the password and a per-account salt: it does not expire, does not rotate, and is accepted by `QuickAuthorize` and by Frey's own access checks (`models/access.ts`) for as long as the password stands. Anyone holding it can act as that person. So the backend does not receive a password, but it does receive something that opens the same door.

What the backend does with it, and what any reimplementation must keep doing:

- **Use it once, then drop it.** It goes to `QuickAuthorize` and falls out of scope. It is never written to the database. `Store.createSession` takes `local_id` and `person_id` and nothing else.
- **Never log it.** The success line records `local_id` and the player's title. Not the token, not the email.
- **Issue an unrelated cookie.** The session cookie is 32 fresh random bytes, stored as a hash, with its own expiry. Compromising the app's session store yields no Pantheon credential.
- **Never send it back.** No endpoint echoes it. The one endpoint that returns a token pair is `/api/dev-authorize`, which exists only under the stub and 404s in production.

The operational counterpart is in `deploy/README.md`: TLS, and a reverse proxy that does not log request bodies. One `log_format` with `$request_body` in it puts every player's Pantheon password in a file on disk.

Step 1 is the reason Frey has **two** addresses in `runtime.json`. `frey_base_url` is the backend's, reached from the server where localhost is correct and normal; `frey_public_url` is the browser's, and on a phone localhost is the phone. They were one field until a deployment set the localhost form and every player was told their password was wrong — the browser had received a connection refused, and the page called it a credential failure. The server now warns at boot when the browser-facing URL is loopback or private, `/admin` carries a row for it, and the sign-in page names the difference between "Frey said no" and "Frey never answered".

Those are the only two outcomes a player can act on. The wire-level ones are distinguishable and worth knowing:

| Frey answers | Means |
|---|---|
| `400 invalid_argument` `Password check failed` | the password |
| `404 not_found` `Person not found in database` | the email |
| `404 bad_route` | wrong service name or path template |
| a 404 that is not JSON | the request missed Twirp entirely; nginx answered |
| nothing at all | CSP, mixed content, DNS, firewall |

Relevant Frey methods: `Authorize`, `QuickAuthorize`, `Me`, `GetPersonalInfo`.
Relevant Mimir method: `GetAllRegisteredPlayers`.

`RegisteredPlayer` as defined in `Common/proto/atoms.proto`:
```
message RegisteredPlayer {
  int32 id = 1;
  string title = 2;
  optional int32 local_id = 3;
  optional string team_name = 4;
  string tenhou_id = 5;
  bool ignore_seating = 6;
  optional ReplacementPlayer replaced_by = 7;
  bool has_avatar = 8;
  string last_update = 9;
}
```

Before the freeze, make sure every one of the twelve has a `local_id` assigned (Mimir `UpdatePlayersLocalIds`); the seat plan is written back in terms of local ids, so a missing one blocks the sync.

## 3. Pushing the seat plan back: the prescript

Pantheon supports *prescripted* events, where the seating for every session is written out in advance. That is exactly our case.

**The winds only survive if the caller says so.** Writing the prescript is not the whole story: the winds it specifies are applied when a session is *started*, by `MakePrescriptedSeating`, and that request carries its own `wind_shuffle_mode`. The field is optional in the proto, and Mimir does **not** fall back to the event's stored setting — `helpers/Seating.php` sends every unrecognised value, UNSPECIFIED included, to `_randomWindShuffle`:

```php
default:
    // fallback to random
    // this includes empty and UNSPECIFIED values
    return self::_randomWindShuffle($seating);
```

Forseti reads `eventConfig.windShuffleMode` and passes it, so the organiser pressing the button in the UI is safe as long as the event itself was created with `WIND_SHUFFLE_MODE_PRESCRIPTED` — which is also what hard rule 5 requires and what `tools/pantheon-fixture.js` sets. Any *other* caller, a script or a curl, must send the mode explicitly. Omitting it keeps the tables and scrambles the seats, reports success, and looks exactly like a bug in this project's draw. Verified against a live instance: same request with the mode stated seats all twelve as drawn; without it, three of twelve.

**Format.** Mimir stores the prescript as a single string and unpacks it like this (`EventPrescript::unpackScript`):

- sessions are separated by a **blank line** (`\n\n`)
- tables within a session are separated by a **newline**
- the four players at a table are separated by **hyphens**
- the numbers are **local ids**, and their order is the seat order

So an eleven-round, three-table event reads:

```
1-2-3-4
10-9-11-12
6-7-8-5

6-11-5-12
1-3-9-2
4-8-7-10

... nine more blocks
```

Each line is one table, written East-South-West-North.

**Writing it.** Mimir `UpdatePrescriptedEventConfig({event_id, next_session_index, prescript})`. Read the current value first with `GetPrescriptedEventConfig({event_id})`, which returns `{event_id, next_session_index, prescript}`. Set `next_session_index` to `1` when publishing a fresh plan.

**Applying it.** Pantheon creates each session's seating from the prescript with `MakePrescriptedSeating({event_id, wind_shuffle_mode})`, and `GetNextPrescriptedSeating` previews the next one.

> **Critical.** Pass `wind_shuffle_mode = WIND_SHUFFLE_MODE_PRESCRIPTED` (value `3`). The other modes re-randomise winds at the table, which would destroy conditions 3 and 6 — the wind balance and the upstream/downstream balance are precisely what the template spent its optimisation budget on. Writing a correct prescript and then letting Pantheon shuffle the winds silently throws away most of the work.

The event itself must be marked prescripted (`is_prescripted` on the event; set at creation or via `UpdateEvent`) so that manual and automatic seating are disabled for it.

Calls that modify event configuration require an administrator account, so the sync step needs Pantheon admin credentials — kept out of the repository, never logged, never echoed by any endpoint. There are two ways to give it one, and the environment always wins:

1. **A fixed service account** in `PANTHEON_ADMIN_PERSON_ID` / `PANTHEON_ADMIN_TOKEN`. This is the original path and the one to use if no event admin will ever sign in through the page.
2. **Captured at sign-in.** An event admin who signs in through the ordinary page has already handed Frey their password and received the same password-equivalent `auth_token` the sync needs, and `Frey.GetOwnedEventIds({person_id})` says whether they administer this event. So the sign-in path checks it, and for an admin captures the token to `var/admin-credential.json` (`0600`, gitignored) for the finalise job to read — obtaining an admin token by hand was a step the first deployments got wrong, and this removes it. Frey's tokens do not expire, so closing the event deletes it (`tools/end-event.js`); it is never archived or mirrored on the way out, unlike everything else that close clears. See `server/admin-credential.js`.

This is a deliberate, narrow crossing of the wall that once read "never mixed with the player sign-in path". The wall was there so the fairness-critical sign-in could not depend on the admin write, and it still does not: the capture is a side-effect-free lookup wrapped so any failure reads as "not an admin" and never blocks a player, the token captured is the admin's own, and the write itself still happens only in the finalise job, after the draw is final and published. `GetOwnedEventIds` is also what decides whether the page offers the organiser dashboard (`/admin`) — an event admin reaches it with their own session, so `ADMIN_TOKEN` is now optional. The non-secret half of the Pantheon configuration (base URLs, the Twirp path template, service names) lives in `runtime.json` and is deliberately outside the freeze: where Pantheon sits on the host cannot affect the draw. What the sync is allowed to write does affect it, so `wind_shuffle_mode` stays in the frozen `protocol.json` (`PROTOCOL.md` §4.1).


### 3.1 Adding the final round, mid-event

An event with a twelfth round (PROTOCOL.md §11) writes the prescript **twice**: eleven blocks at the first draw, then all twelve once the final round is drawn — weeks later, with eleven sessions already played and scored.

All twelve, not just the new one. Writing the twelfth block alone with `next_session_index = 1` would tell Pantheon to re-seat session **one** from the final round's tables. Writing all twelve also means the read-back proves the eleven played sessions were handed back unchanged, which is the part nothing else checks.

The sequence `tools/draw-final.js` uses:

1. `GetPrescriptedEventConfig` — and refuse unless the stored prescript is **byte-for-byte** what `results.json` published, it is exactly eleven blocks, and `next_session_index` is already `12`. That last one is doing real work: it is Mimir's own statement that all eleven sessions have been played, and it is the only check here that does not depend on somebody's word.
2. `UpdatePrescriptedEventConfig({event_id, next_session_index: 12, prescript: <twelve blocks>})`.
3. `GetPrescriptedEventConfig` again — and compare byte for byte, including the index.

Re-running the tool after the final session has been **played** is an ordinary thing to do, and it must not rewind anything: by then Mimir has moved `next_session_index` past 12. So when the stored prescript already equals what would be written, the tool returns without writing at all rather than pointing Pantheon back at a session that is already in the books.
## 4. Sync failure handling

The sync happens after the draw is already final and published, so a failure there is an operational nuisance, not a fairness problem — the seat plan in `results.json` is authoritative and reproducible from public data whatever Pantheon says.

Record the sync outcome in `events/sync.json` (**not** in `results.json`, which is written once and must stay byte-for-byte reproducible — `PROTOCOL.md` §4.3), retry a few times with backoff, and if it still fails, surface it in the admin view (`/admin`, gated by `ADMIN_TOKEN`) and fall back to pasting the prescript into Pantheon's own admin UI by hand. Do **not** regenerate or re-draw anything in response to a sync failure.

## 5. Method reference

Methods named here, verified against `Common/proto/*.proto` **and called against a live instance**:

| Purpose | Service | Method |
|---|---|---|
| Password sign-in (browser → Pantheon) | Frey | `Authorize` |
| Verify a token pair (backend) | Frey | `QuickAuthorize` |
| Event roster, with local ids | Mimir | `GetAllRegisteredPlayers` |
| Assign local ids before the freeze | Mimir | `UpdatePlayersLocalIds` |
| Read current prescript | Mimir | `GetPrescriptedEventConfig` |
| Write the seat plan | Mimir | `UpdatePrescriptedEventConfig` |
| Apply a session's seating | Mimir | `MakePrescriptedSeating` |
| Preview next session's seating | Mimir | `GetNextPrescriptedSeating` |
| The event's name, for the page title | Mimir | `GetEventsById` |
| Standings, for the final round (§11) | Mimir | `GetRatingTable` |

### 5.1 What the wire actually looks like

Confirmed by calling a running instance. All six of these were wrong in the first
implementation, and none of them failed loudly.

| | Guessed from the protos | What the instance does |
|---|---|---|
| URL path | `/twirp/{service}/{method}` | `/v2/{service}/{method}` |
| Service segment | `frey.Frey`, `mimir.Mimir` | `common.Frey`, `common.Mimir` |
| Dev ports | Frey 4001, Mimir 4002 | **Mimir 4001, Frey 4004** |
| Request fields | snake_case | snake_case — accepted by both services |
| **Response fields** | snake_case | **lowerCamelCase**: `personId`, `authToken`, `authSuccess`, `tenhouId`, `localId` |
| Bad credentials | `{auth_success: false}` | HTTP 400 `invalid_argument` "Password check failed" |

Two of those deserve spelling out, because they are the ones that bite rather than break.

**A field holding its default is absent, not null.** That is the protobuf JSON mapping,
and it means an unassigned `local_id` does not appear in the response at all, nor does
`ignore_seating: false`, nor `auth_success: false`. Code that reads `p.local_id ?? null`
is right by accident; code that treats an absent field as "the server did not say" is
wrong. A bool that is `true` is always present, which is what makes
`authSuccess === true` a complete test for a successful sign-in.

**`GetRatingTable` has no rank field.** `EventsGetRatingTablePayload{event_id_list, order_by, order}` returns `EventsGetRatingTableResponse{list}` of `PlayerInRating{id, title, tenhou_id, rating, chips, winner_zone, avg_place, avg_score, games_played}` — and nothing that says "3rd". **The rank is the position in the list.** So the order is the payload, and a client that re-sorted it, however sensibly, would be inventing the one number the final round's tables are read from.

**A bad credential pair is an error, not a false.** Frey's `quickAuthorize` either
returns `{authSuccess: true}` or throws: 400 `invalid_argument` for a wrong token, 404
`not_found` for an unknown person. A client that lets those propagate reports a mistyped
password as "Pantheon is unreachable" — a 503 where UI-SPEC §3 requires a
distinguishable 401. `server/pantheon.js` treats 400, 401, 403 and 404 as refusals and
keeps throwing on 5xx and 429, so an outage still reads as an outage.

**Admin calls need the event scope.** Mimir reads `X-Auth-Token`, `X-Current-Person-Id`
and `X-Current-Event-Id` (`Mimir/src/Meta.php`), and event admin and referee rights are
scoped by the third. Without it the prescript write is refused — after the draw, when
nothing can be changed.


### 5.2 Verified against a live instance, and not

Worth separating, because this document reads with equal confidence throughout and the two halves do not deserve it.

`tools/verify-pantheon-final.js --event <id>` is what closes the gap. It asks a running Mimir every question below by doing it, prints one verdict a line, and puts the prescript it found back on the way out. Run it against a development instance while building, and against the real instance **before an event is frozen** — the remedy for the first row has to happen before anybody plays.

**Verified by calling a running instance:** everything in 5.1, the sign-in path end to end, the roster read, writing an eleven-block prescript to a fresh event, and `MakePrescriptedSeating` with `wind_shuffle_mode = 3` seating all twelve as drawn. And, as of the run recorded below:

| Question | Answer |
|---|---|
| Does an event created for **eleven** sessions accept a **twelve**-block prescript? | **Yes.** Twelve blocks written, twelve read back byte-identical, `check_errors` empty. `EventPrescript::unpackScript` splits on blank lines and caps nothing, and `getCheckErrors` validates only duplicate and unknown local ids |
| Is a mid-event update accepted, and does it disturb recorded results? | **Accepted, and no.** Blocks 1-11 came back byte-identical after the rewrite, and every recorded rating row was unchanged across it. The prescript and the played sessions are separate state |
| Can `next_session_index` be set to 12 explicitly rather than clamped? | **Yes, and it round-trips.** The controller stores `nextSessionIndex - 1` and the reader returns stored `+ 1`, so what you write is what you read. Do not be misled by the model layer alone, where only one half of that is visible |
| Is the twelfth block reachable, with its seat order intact? | **Yes.** With the pointer at 12, `GetNextPrescriptedSeating` returned the twelfth block's three tables in exactly the written order — and seat order *is* wind order, E-S-W-N |
| Which values does `GetRatingTable`'s `order_by` accept? | `name`, `rating`, `games_and_rating`, `avg_place`, `avg_score`, `chips`. **Not `games_played`** |
| Does `GetRatingTable` need the admin headers? | **No** — but see the two rows below, because the answer it gives with them is a different table |

**What the live run changed in this repository**, rather than merely confirmed:

| Finding | Consequence |
|---|---|
| `games_played` is **not** a valid `order_by` | It was in `lock-final.js`'s `SORTABLE` list. An operator who configured it would have got a 500 from Mimir at the moment they were locking the standings. Removed; `name` and `games_and_rating` are now refused *by name*, with the reason, rather than as "unknown" |
| A refused `order_by` returns **500**, not a 4xx | Indistinguishable from an outage, so "try again later" would have been exactly the wrong advice. The failure path now prints the accepted set |
| Mimir compares float keys with `abs(a - b) < 0.0001` and orders any pair inside that epsilon by a **second** key | Exact equality had both halves wrong at once: such a pair was not reported as a tie, *and* the local recomputation disagreed with Mimir's order and refused a good table. The order check is now monotonicity in the requested direction — immune to a secondary key it was never told about — and ties use Mimir's epsilon. A near-tie across the 4\|5 boundary is now caught, where before it would have seated somebody at the wrong table |
| An event with **hide results** on returns *nothing* to a non-admin caller | `EventRatingTable.php`: `if (!$event->getHideResults() || $isAdmin)`. A tournament that hides its standings while it is being played — which is normal — made the default call return zero rows, and the failure read as "Pantheon returned 0 players", which sends an operator to check the event id. Now named, with `--as-admin` as the remedy |
| The admin header makes Mimir include **prefinished** (started but unfinished) games | So `--as-admin` is not free: standings counting an unfinished game can still change, and a lock is a promise that they cannot. The flag now warns every time, and the per-player games check is what actually catches it |
| The rating table is built from **played history**, not from registrations | A registered player with no finished game is absent entirely. This is what rules out every substitute policy except `same_registration` (PROTOCOL.md §11.6): a substitute registered separately appears as a *second, partial* row for one seat |
| `chips` and `avg_place` are **absent** from a row when they are zero | Protobuf omits a field holding its default. The `?? 0` defaults in `getRatingTable` are load-bearing, not defensive |
| A `local_id` **can** be reassigned to another registered person mid-event | Which is what makes a substitute possible at all, and confirms the prescript needs no change: it names local ids, not people |

**Still not verified:**

| Unverified | Why it matters | How it is handled |
|---|---|---|
| Whether a *fully played* eleven-session event behaves the same as one with games added through `AddPenaltyGame` | The rewrite-disturbs-nothing check above used penalty games, because finishing a real hanchan over the API needs a full round of scored hands | The read-back in step 3 compares the bytes of blocks 1-11 either way, so a disturbance is a loud failure |
| Whether a live instance's `GetRatingTable` orders identically once real ratings differ by less than the epsilon | Two players inside 0.0001 decide a table if they straddle a band boundary | `lock-final.js` refuses a band-crossing tie outright, using Mimir's own epsilon |

The rule the list follows: anything unverified that could change **who sits where** is caught by a check that recomputes rather than trusts, and anything unverified that could only fail loudly is left to fail loudly.

## 6. A local Pantheon to test against

The whole integration was written without one, which is why §5.1 exists. Getting one up
takes about half an hour.

Pantheon's own README says Windows is not supported; use WSL 2 or Linux. Inside it:

```sh
git clone https://github.com/MahjongPantheon/pantheon.git && cd pantheon
docker compose -f docker-compose-amd64.yml up -d mimir.pantheon.internal frey.pantheon.internal redis.pantheon.internal
(cd Mimir && make container_deps && make container_migrate)
(cd Frey  && make container_deps && make container_migrate)
make bootstrap_admin        # admin@localhost.localdomain / 123456
(cd Mimir && make container_seed)
(cd Frey  && make container_dev &)   # Frey's dev server; nginx proxies to it on :4004
node tools/pantheon-fixture.js       # our event: prescripted, 12 players, local ids 1..12
```

Five things cost an hour between them and are invisible from the documentation:

- **The Host header decides everything.** Each container's nginx matches on
  `server_name mimir.pantheon.local` and has a catch-all that answers 404. A request to
  `http://127.0.0.1:4001` therefore 404s even though the service is healthy. Use the
  hostnames, with `/etc/hosts` entries pointing at 127.0.0.1. This is why
  `runtime.json`'s Pantheon base URLs are hostnames and not addresses.
- **WSL rewrites `/etc/hosts` on every start.** Put `generateHosts = false` under a
  `[network]` section in `/etc/wsl.conf` first, or the entries vanish and the symptom is
  a sudden 404 from a service that was working a minute ago.
- **Two machines need those entries, not one.** WSL's `/etc/hosts` covers whatever runs
  inside WSL. Two things routinely do not. The relay is wherever you started it, and
  running it from Windows against containers in WSL gives you
  `GetEventsById: fetch failed` at boot and no event name in the page title. The browser
  is always outside, and it calls **Frey** itself rather than through the relay — §2, the
  server never sees a Pantheon password — so `frey.pantheon.local` has to resolve in
  Windows whichever side the relay is on. Add both names to
  `C:\Windows\System32\drivers\etc\hosts` pointing at `127.0.0.1`, or develop against
  `PANTHEON_MODE=stub`, which needs neither. Pointing the URLs at `127.0.0.1` instead does
  not work: the Host header is then `127.0.0.1` and nginx answers 404, which is the first
  item on this list.
- **Frey calls Hugin on every single request.** Its metrics middleware `await`s a POST to
  `hugin/addMetric` and wraps failures, so with Hugin not running *every* Frey call
  returns 500 `fetch failed`. Start `hugin.pantheon.internal` too.
- **Redis caches negative lookups.** Probing `QuickAuthorize` for a person before that
  person exists caches "not known", and the correct call afterwards still fails.
  `redis-cli FLUSHALL` after seeding.
- **Only tournaments can be prescripted.** `CreateEvent` hard-sets `is_prescripted = 0`
  for club and online events. It reports success, it stores `wind_shuffle_mode`
  faithfully, and the only symptom is that `GetAllRegisteredPlayers` returns no local
  ids — because Mimir only fills them in for prescripted events. RUNBOOK step 8's event
  must be `EVENT_TYPE_TOURNAMENT`.

`tools/pantheon-fixture.js --accounts` additionally creates the twelve players through Frey's `CreateAccount`, with an email and a password it prints, so the real sign-in path can be walked instead of assumed. Without it the players are borrowed from the instance's seed data and nobody knows their passwords — enough for the draw, which only handles person ids, but not for the one request a player makes first. Re-running is safe: Frey answers `409 already_exists` for an email it has seen and the fixture recovers the person id by signing in as that account.

`tools/pantheon-fixture.js` does the rest of RUNBOOK step 8 over the API: copies a
ruleset from the instance (`CreateEvent` refuses without a full one), creates the
tournament, registers twelve players and assigns their local ids, then reads them back
the way `tools/freeze.js` will.

Two more that cost time and are invisible from the documentation:

- **Frey's dev server dies with the shell that started it.** `make container_dev` runs in
  the foreground, so starting it from a one-shot `wsl.exe -e bash -lc '...'` leaves nginx
  up and nothing behind it — every call becomes `502`, which looks like Frey is broken
  rather than absent. Start it detached *inside* the container:
  `docker exec -d pantheon-frey.pantheon.internal-1 sh -c 'cd /var/www/html/Frey && HOME=/home/user su-exec user make dev'`.
- **On WSL, the containers stop when the last client detaches.** The VM shuts down a few
  seconds after `wsl.exe` returns, taking Docker with it, and the next call fails with
  `fetch failed` against services that were healthy a moment ago. Hold one session open
  for as long as you need them (`wsl.exe -e sleep 2400` in another terminal). Starting a
  container with `docker start` rather than `docker compose up` is the other half of this:
  it comes up without its compose network aliases, and Frey then cannot resolve
  `hugin.pantheon.internal` — which presents as the 500 `fetch failed` two items above.

`tools/verify-pantheon-final.js --event <id>` is the reason to bother with any of this. It
asks a live Mimir the whole of §5.2 by doing it: writes an eleven-block prescript and then
a twelve-block one, reads both back, checks blocks 1-11 survived byte-identical, walks
`next_session_index` to the twelfth block and asks `GetNextPrescriptedSeating` for it,
probes every candidate `order_by`, compares the admin and non-admin rating tables, and
reassigns a `local_id` to a different person to confirm a seat can change hands. It puts
the prescript it found back on the way out. It **writes** to the event it is given, so
point it at a development instance — or at a real event before it opens.
