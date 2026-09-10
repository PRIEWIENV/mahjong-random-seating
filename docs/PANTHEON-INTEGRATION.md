# Pantheon integration

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

Calls that modify event configuration require an administrator account, so the backend needs its own Pantheon admin credentials for the sync step — kept in the server's environment, never in the repository, and never mixed with the player sign-in path above. The non-secret half of the Pantheon configuration (base URLs, the Twirp path template, service names) lives in `runtime.json` and is deliberately outside the freeze: where Pantheon sits on the host cannot affect the draw. What the sync is allowed to write does affect it, so `wind_shuffle_mode` stays in the frozen `protocol.json` (`PROTOCOL.md` §4.1).

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

`tools/pantheon-fixture.js` does the rest of RUNBOOK step 8 over the API: copies a
ruleset from the instance (`CreateEvent` refuses without a full one), creates the
tournament, registers twelve players and assigns their local ids, then reads them back
the way `tools/freeze.js` will.
