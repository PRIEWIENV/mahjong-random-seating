#!/usr/bin/env node
'use strict';

/**
 * Builds the event this app needs, on a local Pantheon, over the real Twirp API.
 *
 * RUNBOOK step 8 is the one step performed inside Pantheon rather than here: mark the
 * event prescripted, register exactly the right twelve, give each of them a local_id.
 * Doing that by hand in Forseti takes twenty minutes and is not repeatable, which makes
 * it a poor foundation for testing the steps that come after it.
 *
 * This is for a development instance and nothing else. It authenticates as the admin
 * account `make bootstrap_admin` creates, and it creates and mutates events.
 *
 *   node tools/pantheon-fixture.js                       create the event, print its id
 *   node tools/pantheon-fixture.js --players 12          how many to register
 *   node tools/pantheon-fixture.js --event 3 --inspect   just show what an event holds
 *
 * Every call here goes through the same field-name conventions server/pantheon.js uses,
 * so if this works, that works: requests in snake_case, responses in lowerCamelCase.
 *
 * See docs/PANTHEON-INTEGRATION.md §6 for how to get an instance running.
 */

const ADMIN_EMAIL = process.env.PANTHEON_ADMIN_EMAIL || 'admin@localhost.localdomain';
const ADMIN_PASSWORD = process.env.PANTHEON_ADMIN_PASSWORD || '123456';
const FREY = (process.env.PANTHEON_FREY_URL || 'http://frey.pantheon.local:4004').replace(/\/+$/, '');
const MIMIR = (process.env.PANTHEON_MIMIR_URL || 'http://mimir.pantheon.local:4001').replace(/\/+$/, '');

const ok = (s) => console.log(`  \x1b[32mOK\x1b[0m    ${s}`);
const note = (s) => console.log(`        ${s}`);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i].replace(/^--/, '');
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) out[k] = true;
    else { out[k] = v; i++; }
  }
  return out;
}

/** Responses come back in lowerCamelCase; ask for either spelling. */
const field = (o, snake) =>
  o == null ? undefined
    : o[snake] !== undefined ? o[snake]
      : o[snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase())];

async function call(base, service, method, body, auth) {
  const headers = { 'content-type': 'application/json' };
  if (auth) {
    headers['x-auth-token'] = auth.token;
    headers['x-current-person-id'] = String(auth.personId);
    // Mimir scopes event admin rights by this header, so an event-level write needs it.
    if (auth.eventId != null) headers['x-current-event-id'] = String(auth.eventId);
  }
  const res = await fetch(`${base}/v2/${service}/${method}`, {
    method: 'POST', headers, body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* leave it null */ }
  if (!res.ok) {
    const why = json?.msg || text.slice(0, 200);
    throw new Error(`${method} -> ${res.status} ${why}${json?.meta?.cause ? ` (${json.meta.cause})` : ''}`);
  }
  return json ?? {};
}

const frey = (m, b, a) => call(FREY, 'common.Frey', m, b, a);
const mimir = (m, b, a) => call(MIMIR, 'common.Mimir', m, b, a);

async function main(argv) {
  const args = parseArgs(argv);
  const wanted = Number(args.players || 12);

  const auth = await frey('Authorize', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  const admin = { personId: field(auth, 'person_id'), token: field(auth, 'auth_token') };
  if (!admin.personId || !admin.token) throw new Error('Authorize returned no usable pair');
  ok(`signed in as ${ADMIN_EMAIL} (person ${admin.personId})`);

  if (args.inspect) {
    const eventId = Number(args.event);
    const players = field(await mimir('GetAllRegisteredPlayers', { event_ids: [eventId] }), 'players') || [];
    ok(`event ${eventId}: ${players.length} registered`);
    for (const p of players) {
      note(`id ${p.id}  local_id ${field(p, 'local_id') ?? '—'}  ${field(p, 'ignore_seating') === true ? '(not seated) ' : ''}${p.title}`);
    }
    const cfg = await mimir('GetPrescriptedEventConfig', { event_id: eventId }, { ...admin, eventId });
    note(`next_session_index ${field(cfg, 'next_session_index')}, prescript ${JSON.stringify(String(cfg.prescript || '').slice(0, 60))}`);
    return 0;
  }

  // A ruleset has to be supplied in full — CreateEvent refuses without one — and the
  // instance's own is the only one guaranteed to be valid for its version.
  const rulesets = field(await mimir('GetRulesets', {}), 'rulesets') || [];
  if (!rulesets.length) throw new Error('the instance offers no rulesets to copy');
  ok(`copied the ruleset config from the instance (${rulesets.length} available)`);

  // EVENT_TYPE_TOURNAMENT, and not by preference: Mimir's CreateEvent hard-sets
  // is_prescripted = 0 for club and online events (Events.php), so a local event can
  // never carry a prescript. It fails silently — the call succeeds, wind_shuffle_mode is
  // stored, and only the missing local ids much later give it away.
  const created = await mimir('CreateEvent', {
    type: 'EVENT_TYPE_TOURNAMENT',
    title: args.title || `Seating draw fixture ${new Date().toISOString().slice(0, 16)}`,
    description: 'Created by tools/pantheon-fixture.js for the timelock seating draw.',
    duration: 75,
    timezone: 'Asia/Shanghai',
    lobby_id: 0,
    series_length: 0,
    min_games: 0,
    is_team: false,
    // The two that matter: the seat plan is written in advance, and the winds it
    // specifies must be the winds that are used (hard rule 5).
    is_prescripted: true,
    wind_shuffle_mode: 'WIND_SHUFFLE_MODE_PRESCRIPTED',
    autostart: 0,
    is_listed: false,
    is_rating_shown: false,
    achievements_shown: false,
    allow_view_other_tables: true,
    platform_id: 'PLATFORM_TYPE_OFFLINE',
    allow_manual_add_replay: false,
    ruleset_config: rulesets[0],
  }, admin);
  const eventId = field(created, 'event_id');
  if (!eventId) throw new Error(`CreateEvent returned no event id: ${JSON.stringify(created)}`);
  ok(`event ${eventId} created, prescripted, winds prescripted`);

  // Anyone the instance already knows about will do; the draw never sees their names
  // until the roster snapshot, and the seeder has plenty.
  const known = field(await mimir('GetAllRegisteredPlayers', { event_ids: [1] }), 'players') || [];
  const pool = known.filter((p) => p.id !== admin.personId).slice(0, wanted);
  if (pool.length < wanted) {
    throw new Error(`only ${pool.length} players available in event 1 — run \`make seed\` in the Pantheon checkout`);
  }

  for (const p of pool) {
    await mimir('RegisterPlayer', { player_id: p.id, event_id: eventId }, { ...admin, eventId });
  }
  ok(`registered ${pool.length} players`);

  await mimir('UpdatePlayersLocalIds', {
    event_id: eventId,
    ids_to_local_ids: pool.map((p, i) => ({ player_id: p.id, local_id: i + 1 })),
  }, { ...admin, eventId });

  // Read it back the way tools/freeze.js will: a local_id that did not stick blocks the
  // seat-plan sync, and the sync runs after the draw.
  const back = field(await mimir('GetAllRegisteredPlayers', { event_ids: [eventId] }), 'players') || [];
  const missing = back.filter((p) => !Number.isInteger(field(p, 'local_id')));
  if (missing.length) {
    throw new Error(`${missing.length} of ${back.length} players still have no local_id after the update`);
  }
  ok(`local_id 1..${back.length} assigned and read back`);

  console.log(`
  The event is ready. Point the draw at it:

    PANTHEON_MODE=twirp PANTHEON_ADMIN_PERSON_ID=${admin.personId} \\
    PANTHEON_ADMIN_TOKEN=${admin.token} \\
    node tools/freeze.js --event ${eventId} --write
`);
  return 0;
}

main(process.argv.slice(2))
  .then((c) => process.exit(c || 0))
  .catch((err) => {
    console.error(`  \x1b[31mERROR\x1b[0m ${err.message}`);
    process.exit(1);
  });
