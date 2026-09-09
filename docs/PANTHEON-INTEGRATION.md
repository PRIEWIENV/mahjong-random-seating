# Pantheon integration

The draw app sits alongside a self-hosted [Pantheon](https://github.com/MahjongPantheon/pantheon) instance on the same server. Pantheon supplies identity and the event roster, and receives the finished seat plan.

Everything below was read off the Pantheon protocol definitions in `Common/proto/` on `master`. **Confirm the field names against the instance you are actually running before writing code** — Pantheon is under active development and these are the details most likely to drift.

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

Calls that modify event configuration require an administrator account, so the backend needs its own Pantheon admin credentials for the sync step — kept in the server's environment, never in the repository, and never mixed with the player sign-in path above.

## 4. Sync failure handling

The sync happens after the draw is already final and published, so a failure there is an operational nuisance, not a fairness problem — the seat plan in `results.json` is authoritative and reproducible from public data whatever Pantheon says.

Record the sync outcome in `results.json` (`pantheon_sync`), retry a few times with backoff, and if it still fails, surface it in the admin view and fall back to pasting the prescript into Pantheon's own admin UI by hand. Do **not** regenerate or re-draw anything in response to a sync failure.

## 5. Method reference

Methods named here, all verified against `Common/proto/frey.proto`, `Common/proto/mimir.proto` and `Common/proto/atoms.proto`:

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
