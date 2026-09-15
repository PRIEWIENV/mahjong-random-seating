#!/usr/bin/env node
'use strict';

/**
 * Asks a LIVE Pantheon the questions the stub cannot answer (PANTHEON-INTEGRATION.md §5.2).
 *
 * Everything the final round needs from Mimir was written against a stub, because there
 * was no instance to write it against. A stub agrees with whatever it was taught, so the
 * parts of §5.2 marked unverified were unverified in the strong sense: nobody had ever
 * seen Mimir do them. The highest-risk one is the twelfth prescript block — the event was
 * created for eleven sessions, and if Mimir caps or truncates the script, the remedy has
 * to happen BEFORE the standings are locked, because after the lock the tables are public
 * and cannot be re-cut.
 *
 * This tool answers them by doing them, and prints one verdict line each. It is a probe,
 * not a test: it WRITES to the event it is pointed at, so point it at a development
 * instance, or at a real event before it opens. It restores the prescript it found on the
 * way in, but a crash between write and restore leaves the probe's script in place.
 *
 *   node tools/verify-pantheon-final.js --event 5
 *   node tools/verify-pantheon-final.js --event 5 --keep     leave the 12-block script
 *
 * Credentials come from the same env the fixture uses; see §6 for getting an instance up.
 */

const ADMIN_EMAIL = process.env.PANTHEON_ADMIN_EMAIL || 'admin@localhost.localdomain';
const ADMIN_PASSWORD = process.env.PANTHEON_ADMIN_PASSWORD || '123456';
const FREY = (process.env.PANTHEON_FREY_URL || 'http://frey.pantheon.local:4004').replace(/\/+$/, '');
const MIMIR = (process.env.PANTHEON_MIMIR_URL || 'http://mimir.pantheon.local:4001').replace(/\/+$/, '');

const ok = (s) => console.log(`  \x1b[32mYES\x1b[0m   ${s}`);
const no = (s) => console.log(`  \x1b[31mNO\x1b[0m    ${s}`);
const huh = (s) => console.log(`  \x1b[33m?\x1b[0m     ${s}`);
const note = (s) => console.log(`        ${s}`);
const head = (s) => console.log(`\n\x1b[1m${s}\x1b[0m`);

const field = (o, snake) =>
  o == null ? undefined
    : o[snake] !== undefined ? o[snake]
      : o[snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase())];

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

async function call(base, service, method, body, auth) {
  const headers = { 'content-type': 'application/json' };
  if (auth) {
    headers['x-auth-token'] = auth.token;
    headers['x-current-person-id'] = String(auth.personId);
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
    const err = new Error(`${method} -> ${res.status} ${why}`);
    err.status = res.status;
    throw err;
  }
  return json ?? {};
}

const frey = (m, b, a) => call(FREY, 'common.Frey', m, b, a);
const mimir = (m, b, a) => call(MIMIR, 'common.Mimir', m, b, a);

/** A prescript of `sessions` blocks over `n` local ids, each block a permutation. */
function script(sessions, n) {
  const blocks = [];
  for (let s = 0; s < sessions; s++) {
    const ids = [];
    for (let i = 0; i < n; i++) ids.push(((i + s) % n) + 1);
    const tables = [];
    for (let t = 0; t < n; t += 4) tables.push(ids.slice(t, t + 4).join('-'));
    blocks.push(tables.join('\n'));
  }
  return blocks.join('\n\n');
}

const blocksOf = (s) => String(s || '').trim().split(/\n\s*\n/).filter(Boolean);

async function main(argv) {
  const args = parseArgs(argv);
  const eventId = Number(args.event);
  if (!Number.isInteger(eventId)) {
    console.error('need --event <id>; create one with tools/pantheon-fixture.js');
    return 2;
  }

  const auth = await frey('Authorize', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  const admin = { token: field(auth, 'auth_token'), personId: field(auth, 'person_id'), eventId };
  note(`signed in as ${ADMIN_EMAIL} (person ${admin.personId}), event ${eventId}`);

  const regged = field(await mimir('GetAllRegisteredPlayers', { event_ids: [eventId] }), 'players') || [];
  const locals = regged.map((p) => field(p, 'local_id')).filter((x) => Number.isInteger(x)).sort((a, b) => a - b);
  note(`${regged.length} registered, local ids ${locals[0]}..${locals[locals.length - 1]}`);
  const n = locals.length;

  const before = await mimir('GetPrescriptedEventConfig', { event_id: eventId }, admin);
  const hadScript = field(before, 'prescript') || '';
  const hadIndex = field(before, 'next_session_index');
  note(`on the way in: ${blocksOf(hadScript).length} blocks, next_session_index ${hadIndex}`);

  const verdicts = {};

  // --- 6. GetRatingTable: which order_by does it take, and does it need admin? ------
  head('5.2/6  GetRatingTable - accepted order_by values, and the admin header');
  const candidates = ['rating', 'chips', 'avg_place', 'avg_score', 'games_played',
    'name', 'games_and_rating', 'nonsense_key'];
  const accepted = [];
  const refusedHow = [];
  for (const key of candidates) {
    try {
      await mimir('GetRatingTable', { event_id_list: [eventId], order_by: key, order: 'desc' });
      accepted.push(key);
    } catch (err) {
      // An order_by Mimir does not know comes back as a 500, not a 4xx: the PHP throws
      // InvalidParametersException and the Twirp layer reports it as an internal error.
      // So "refused" here means "this key does not work", and a caller cannot tell a bad
      // key from a broken server by the status code alone.
      refusedHow.push(`${key} (${err.status})`);
    }
  }
  verdicts.order_by_accepted = accepted;
  verdicts.order_by_refused = refusedHow;
  ok(`order_by accepted: ${accepted.join(', ')}`);
  note(`order_by refused:  ${refusedHow.join(', ')}`);
  note('a refused order_by is a 500, not a 4xx - it cannot be told from a server fault');

  let noAdmin = null;
  try {
    noAdmin = await mimir('GetRatingTable', { event_id_list: [eventId], order_by: 'rating', order: 'desc' });
    ok('GetRatingTable answers WITHOUT the admin header');
  } catch (err) {
    no(`GetRatingTable needs the admin header: ${err.message}`);
  }
  // Mimir folds PREFINISHED (started but unfinished) games into the table for an event
  // admin and leaves them out for everyone else - controllers/Events.php sets $isAdmin
  // from the auth headers. lock-final.js therefore calls it WITHOUT them by default:
  // standings that include an unfinished game are standings that can still move.
  note('the admin header makes Mimir include PREFINISHED games (Events.php getRatingTable)');
  // Whether the event hides its standings is not on GetEventsById's response, so read it
  // where it actually shows: an event with hide_results on returns NOTHING to a non-admin
  // (EventRatingTable.php: `if (!$event->getHideResults() || $isAdmin)`), while the admin
  // call still answers. Observing the split beats trusting a field that is not sent.
  const withAdmin = await mimir('GetRatingTable',
    { event_id_list: [eventId], order_by: 'rating', order: 'desc' }, admin);
  const rows = field(withAdmin, 'list') || [];
  const rowsNo = field(noAdmin, 'list') || [];
  note(`rows: ${rowsNo.length} without admin, ${rows.length} with admin`);
  const hidden = rows.length > 0 && rowsNo.length === 0;
  verdicts.hide_results_observed = hidden;
  if (hidden) {
    no('this event HIDES RESULTS: a non-admin GetRatingTable returns nothing at all');
    note('A tournament that hides standings while it is being played therefore forces');
    note('lock-final.js to --as-admin - which is also the mode that folds in PREFINISHED');
    note('games. Both halves of that have to be said, and the unfinished ones ruled out.');
  } else if (rows.length !== rowsNo.length) {
    no(`admin sees ${rows.length} rows, everyone else sees ${rowsNo.length}: some game is unfinished`);
  } else if (rows.length) {
    ok('admin and non-admin agree, so nothing is hidden and nothing is unfinished');
  }
  if (!rows.length) {
    huh('the rating table is EMPTY: nobody on this event has a finished game yet');
    note('order_by acceptance above is still meaningful; row shape and ordering are not.');
    note('Play at least one session on this event to check those.');
  }
  if (rows.length) {
    const keys = Object.keys(rows[0]);
    verdicts.row_keys = keys;
    note(`row fields: ${keys.join(', ')}`);
    if (keys.includes('place') || keys.includes('rank')) {
      no('a row carries its own rank - PROTOCOL 11 assumes the ORDER is the ranking');
    } else {
      ok('no place/rank field on a row: the ORDER is the ranking, as 11 assumes');
    }
  }

  // --- 1 & 3. twelve blocks on an eleven-session event, and the index ---------------
  head('5.2/1,3  a TWELFTH prescript block, and next_session_index');
  const eleven = script(11, n);
  await mimir('UpdatePrescriptedEventConfig',
    { event_id: eventId, next_session_index: 1, prescript: eleven }, admin);
  const back11 = await mimir('GetPrescriptedEventConfig', { event_id: eventId }, admin);
  const got11 = blocksOf(field(back11, 'prescript'));
  ok(`eleven blocks written and read back: ${got11.length} blocks`);

  const twelve = script(12, n);
  await mimir('UpdatePrescriptedEventConfig',
    { event_id: eventId, next_session_index: 12, prescript: twelve }, admin);
  const back12 = await mimir('GetPrescriptedEventConfig', { event_id: eventId }, admin);
  const got12 = blocksOf(field(back12, 'prescript'));
  const idx12 = field(back12, 'next_session_index');
  const errors12 = field(back12, 'check_errors') || field(back12, 'errors') || [];
  verdicts.twelve_blocks_read_back = got12.length;
  verdicts.index_written = 12;
  verdicts.index_read = idx12;

  if (got12.length === 12) ok('an event created for ELEVEN sessions accepts a TWELVE-block prescript');
  else no(`twelve blocks written, ${got12.length} came back - Mimir caps or truncates the script`);

  if (field(back12, 'prescript') === twelve) ok('the twelve blocks come back byte-identical');
  else no('the script came back changed');

  if (got12.slice(0, 11).join('\n\n') === eleven) {
    ok('blocks 1-11 are byte-identical to what was there before the twelfth was added');
  } else {
    no('rewriting the script disturbed blocks 1-11');
  }

  if (errors12.length) huh(`check_errors on a twelve-block script: ${errors12.join('; ')}`);
  else ok('Mimir reports no check_errors for the twelve-block script');

  if (idx12 === 12) {
    ok('next_session_index round-trips: wrote 12, read 12');
  } else {
    no(`next_session_index does NOT round-trip: wrote 12, read ${idx12}`);
    note('Mimir stores what you send and returns stored+1 (models/Event.php).');
    note('So any assertion on the value read must use a different number from the write,');
    note('or the final round is written to, or read from, the wrong slot.');
  }

  // --- 5. does the twelfth block's seating come out with its seat order intact? -----
  head('5.2/5  GetNextPrescriptedSeating - is block 12 reachable, in order?');
  const wantTwelfth = idx12 === 12 ? 12 : 11;
  await mimir('UpdatePrescriptedEventConfig',
    { event_id: eventId, next_session_index: wantTwelfth, prescript: twelve }, admin);
  try {
    const seating = await mimir('GetNextPrescriptedSeating', { event_id: eventId }, admin);
    const tables = field(seating, 'tables') || [];
    const flat = tables.map((t) => (field(t, 'players') || []).map((p) => field(p, 'local_id')).join('-'));
    const expected = blocksOf(twelve)[11].split('\n');
    verdicts.seating_tables = flat;
    note(`asked for block 12: ${expected.join(' | ')}`);
    note(`Mimir returned:     ${flat.join(' | ')}`);
    if (flat.length && flat.join('\n') === expected.join('\n')) {
      ok('the twelfth block is reachable and its seat ORDER is preserved exactly');
      note('seat order is the wind order E-S-W-N, so this is the wind check');
    } else if (!flat.length) {
      huh('no seating came back - the pointer is past the end of the script');
    } else {
      no('the seating Mimir returns is not the twelfth block in order');
    }
  } catch (err) {
    huh(`GetNextPrescriptedSeating: ${err.message}`);
  }

  // --- 4. does rewriting the prescript disturb RECORDED results? -------------------
  head('5.2/4  rewriting blocks 1-11 verbatim - are recorded results disturbed?');
  {
    const tableBefore = field(await mimir('GetRatingTable',
      { event_id_list: [eventId], order_by: 'rating', order: 'desc' }, admin), 'list') || [];
    if (!tableBefore.length) {
      huh('no finished games on this event, so there is nothing that COULD be disturbed');
      note('Play at least one session to make this check mean anything.');
    } else {
      const fingerprint = (t) => t.map((r) =>
        `${field(r, 'id')}:${field(r, 'rating')}:${field(r, 'games_played') ?? 0}`).sort().join('|');
      const was = fingerprint(tableBefore);
      await mimir('UpdatePrescriptedEventConfig',
        { event_id: eventId, next_session_index: 12, prescript: twelve }, admin);
      const tableAfter = field(await mimir('GetRatingTable',
        { event_id_list: [eventId], order_by: 'rating', order: 'desc' }, admin), 'list') || [];
      verdicts.rating_rows_before_rewrite = tableBefore.length;
      verdicts.rating_rows_after_rewrite = tableAfter.length;
      if (fingerprint(tableAfter) === was) {
        ok(`rewriting the whole script left all ${tableAfter.length} recorded results untouched`);
        note('the prescript and the played sessions are separate state, as PROTOCOL 11 assumes');
      } else {
        no('rewriting the script CHANGED recorded results');
        note(`before: ${was}`);
        note(`after:  ${fingerprint(tableAfter)}`);
      }
    }
  }

  // --- substitutes: can a seat change hands mid-event? ------------------------------
  head('substitutes - can a local_id be reassigned to a different person mid-event?');
  const first = regged[0];
  const firstId = field(first, 'id') ?? field(first, 'person_id');
  const firstLocal = field(first, 'local_id');
  note(`seat local_id ${firstLocal} currently held by person ${firstId} (${field(first, 'title')})`);
  const pool = field(await mimir('GetAllRegisteredPlayers', { event_ids: [1] }), 'players') || [];
  const inEvent = new Set(regged.map((p) => field(p, 'id') ?? field(p, 'person_id')));
  const sub = pool.find((p) => !inEvent.has(field(p, 'id') ?? field(p, 'person_id')));
  if (!sub) {
    huh('no spare registered person on this instance to stand in as a substitute');
  } else {
    const subId = field(sub, 'id') ?? field(sub, 'person_id');
    try {
      await mimir('RegisterPlayer', { player_id: subId, event_id: eventId }, admin);
      ok(`a 13th person (${subId}) can be registered to the event mid-event`);
      await mimir('UpdatePlayersLocalIds', {
        event_id: eventId,
        ids_to_local_ids: [{ player_id: subId, local_id: firstLocal }],
      }, admin);
      const after = field(await mimir('GetAllRegisteredPlayers', { event_ids: [eventId] }), 'players') || [];
      const holders = after.filter((p) => field(p, 'local_id') === firstLocal)
        .map((p) => field(p, 'id') ?? field(p, 'person_id'));
      verdicts.seat_holders_after_swap = holders;
      note(`after the swap, local_id ${firstLocal} is held by: ${holders.join(', ') || '(nobody)'}`);
      if (holders.length === 1 && holders[0] === subId) {
        ok('a seat CAN change hands: the substitute holds the local_id, the prescript is untouched');
      } else if (holders.length > 1) {
        no('TWO people now hold the same local_id - the prescript would be ambiguous');
      } else {
        huh('the swap did not take');
      }
      const tbl = field(await mimir('GetRatingTable',
        { event_id_list: [eventId], order_by: 'rating', order: 'desc' }), 'list') || [];
      verdicts.rating_rows_after_sub = tbl.length;
      note(`GetRatingTable now returns ${tbl.length} rows (was ${rowsNo.length})`);
      if (tbl.length > rowsNo.length) {
        no(`the standings grew to ${tbl.length} rows - lock-final.js refuses anything but ${n}`);
        note('so a substitute registered as a 13th person must be handled explicitly');
      } else {
        ok(`the standings still hold ${tbl.length} rows after the swap`);
      }
      await mimir('UpdatePlayersLocalIds', {
        event_id: eventId,
        ids_to_local_ids: [{ player_id: firstId, local_id: firstLocal }],
      }, admin);
      await mimir('UnregisterPlayer', { player_id: subId, event_id: eventId }, admin);
      note('substitute unregistered, seat returned to its original holder');
    } catch (err) {
      huh(`substitute probe: ${err.message}`);
    }
  }

  // --- restore ----------------------------------------------------------------------
  if (!args.keep) {
    await mimir('UpdatePrescriptedEventConfig',
      { event_id: eventId, next_session_index: hadIndex, prescript: hadScript }, admin);
    note('\nthe prescript this event had on the way in has been put back');
  }

  console.log(`\n\x1b[1mverdicts\x1b[0m ${JSON.stringify(verdicts, null, 2)}`);
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((c) => process.exit(c))
    .catch((err) => { console.error(`\x1b[31mERROR\x1b[0m ${err.message}`); process.exit(1); });
}

module.exports = { main, script, blocksOf };
