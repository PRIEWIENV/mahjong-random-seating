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

`tools/pantheon-fixture.js --accounts` additionally creates the twelve players through Frey's `CreateAccount`, with an email and a password it prints, so the real sign-in path can be walked instead of assumed. Without it the players are borrowed from the instance's seed data and nobody knows their passwords — enough for the draw, which only handles person ids, but not for the one request a player makes first. Re-running is safe: Frey answers `409 already_exists` for an email it has seen and the fixture recovers the person id by signing in as that account.

`tools/pantheon-fixture.js` does the rest of RUNBOOK step 8 over the API: copies a
ruleset from the instance (`CreateEvent` refuses without a full one), creates the
tournament, registers twelve players and assigns their local ids, then reads them back
the way `tools/freeze.js` will.
