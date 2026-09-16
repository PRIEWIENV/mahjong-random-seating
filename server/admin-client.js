/**
 * The dashboard's only script (RUNBOOK section F, UI-SPEC §7).
 *
 * Three jobs, and one rule that shapes all three.
 *
 *   1. Refresh each card on its own cadence, from /admin/cards.json.
 *   2. Stream the server's log into the log card, from /admin/log.json.
 *   3. Let the operator arrange the page: reorder, widen, remove, put back.
 *
 * The rule is that this file is the ONLY script the dashboard loads, from this origin,
 * with no inline handlers and nothing evaluated. The page's CSP is
 * `default-src 'none'; script-src 'self'` with no 'unsafe-inline' and no 'unsafe-eval',
 * and the deployed page is held to that AND to the proxy's own header, so anything
 * clever here does not merely fail review, it fails to run. Card HTML arrives from our
 * own server, already escaped by server/admin.js, and is assigned with innerHTML on
 * purpose; the only other source of markup on this page is the operator, and they do not
 * type any.
 *
 * Layout lives in localStorage, which is the right store for it: it is a preference of
 * one person at one screen, it must survive a refresh, and it must never be something a
 * second operator inherits or the server has an opinion about. Anything it cannot hold —
 * the cards that exist, whether a form is live — comes from the server every time.
 */
(function () {
  'use strict';

  var KEY = 'mjs-admin-layout-v1';
  var grid = document.querySelector('[data-grid]');
  if (!grid) return;

  // The token, if the operator arrived by link rather than by cookie, has to ride along
  // on every fetch or they are 404s.
  var token = new URLSearchParams(location.search).get('token');
  var qs = function (path, extra) {
    var u = path + '?' + (extra || '');
    return token ? u + '&token=' + encodeURIComponent(token) : u;
  };

  // ---- layout ------------------------------------------------------------
  // { order: [id...], hidden: [id...], wide: [id...] }. Unknown ids are ignored and
  // cards missing from `order` fall in at the end, so a release that adds or removes a
  // card does not strand an operator with a stale arrangement.
  function load() {
    try {
      var raw = JSON.parse(localStorage.getItem(KEY) || '{}');
      return {
        order: Array.isArray(raw.order) ? raw.order : [],
        hidden: Array.isArray(raw.hidden) ? raw.hidden : [],
        wide: Array.isArray(raw.wide) ? raw.wide : null,
      };
    } catch (e) {
      return { order: [], hidden: [], wide: null };
    }
  }
  function save(l) {
    try { localStorage.setItem(KEY, JSON.stringify(l)); } catch (e) { /* private mode */ }
  }

  var layout = load();
  var cards = function () { return Array.prototype.slice.call(grid.querySelectorAll('[data-card]')); };
  var byId = {};
  cards().forEach(function (el) { byId[el.dataset.card] = el; });
  var ids = Object.keys(byId);
  // What the server rendered is the default width, remembered before any override.
  var defaultWide = {};
  ids.forEach(function (id) { defaultWide[id] = byId[id].classList.contains('wide'); });

  var bar = document.querySelector('[data-bar]');
  var palette = document.querySelector('[data-palette]');

  function apply() {
    var seen = {};
    var ordered = [];
    layout.order.forEach(function (id) {
      if (byId[id] && !seen[id]) { seen[id] = 1; ordered.push(id); }
    });
    ids.forEach(function (id) { if (!seen[id]) ordered.push(id); });

    ordered.forEach(function (id) {
      var el = byId[id];
      grid.appendChild(el);
      el.hidden = layout.hidden.indexOf(id) !== -1;
      var wide = layout.wide ? layout.wide.indexOf(id) !== -1 : defaultWide[id];
      el.classList.toggle('wide', wide);
    });

    palette.textContent = '';
    var removed = ordered.filter(function (id) { return layout.hidden.indexOf(id) !== -1; });
    removed.forEach(function (id) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'card-btn';
      b.dataset.show = id;
      b.textContent = '+ ' + title(id);
      palette.appendChild(b);
    });
    bar.hidden = removed.length === 0;
  }

  function title(id) {
    var h = byId[id] && byId[id].querySelector('h2');
    return h ? h.textContent : id;
  }

  function move(id, delta) {
    var ordered = cards().map(function (el) { return el.dataset.card; });
    var i = ordered.indexOf(id);
    var j = i + delta;
    // Step over hidden neighbours, or the button appears to do nothing.
    while (j >= 0 && j < ordered.length && layout.hidden.indexOf(ordered[j]) !== -1) j += delta;
    if (i < 0 || j < 0 || j >= ordered.length) return;
    ordered.splice(j, 0, ordered.splice(i, 1)[0]);
    layout.order = ordered;
    save(layout); apply();
  }

  document.addEventListener('click', function (ev) {
    var btn = ev.target.closest ? ev.target.closest('button') : null;
    if (!btn) return;
    var card = btn.closest('[data-card]');
    if (btn.dataset.move && card) return move(card.dataset.card, btn.dataset.move === 'up' ? -1 : 1);
    if (btn.dataset.hide !== undefined && card) {
      layout.hidden = layout.hidden.concat([card.dataset.card]);
      save(layout); return apply();
    }
    if (btn.dataset.wide !== undefined && card) {
      var id = card.dataset.card;
      if (!layout.wide) {
        layout.wide = ids.filter(function (x) { return defaultWide[x]; });
      }
      var at = layout.wide.indexOf(id);
      if (at === -1) layout.wide.push(id); else layout.wide.splice(at, 1);
      save(layout); return apply();
    }
    if (btn.dataset.show) {
      layout.hidden = layout.hidden.filter(function (x) { return x !== btn.dataset.show; });
      save(layout); return apply();
    }
    if (btn.dataset.reset !== undefined) {
      layout = { order: [], hidden: [], wide: null };
      save(layout); return apply();
    }
  });

  // Drag to reorder, for the same operation the arrows do — the arrows are what make it
  // work on a phone and with a keyboard, so neither is the only way.
  var dragging = null;
  grid.addEventListener('dragstart', function (ev) {
    var head = ev.target.closest ? ev.target.closest('.card-head') : null;
    if (!head) { ev.preventDefault(); return; }
    dragging = head.closest('[data-card]');
    dragging.classList.add('dragging');
    ev.dataTransfer.effectAllowed = 'move';
    try { ev.dataTransfer.setData('text/plain', dragging.dataset.card); } catch (e) { /* IE-ism */ }
  });
  grid.addEventListener('dragover', function (ev) {
    if (!dragging) return;
    ev.preventDefault();
    var over = ev.target.closest ? ev.target.closest('[data-card]') : null;
    if (!over || over === dragging) return;
    var box = over.getBoundingClientRect();
    var after = (ev.clientY - box.top) / box.height > 0.5;
    grid.insertBefore(dragging, after ? over.nextSibling : over);
  });
  grid.addEventListener('dragend', function () {
    if (!dragging) return;
    dragging.classList.remove('dragging');
    dragging = null;
    layout.order = cards().map(function (el) { return el.dataset.card; });
    save(layout); apply();
  });

  apply();
  cards().forEach(function (el) {
    var head = el.querySelector('.card-head');
    if (head) head.draggable = true;
  });

  // ---- per-card refresh --------------------------------------------------
  // A card is due when its own interval has elapsed. Nothing refreshes a card the
  // operator is working in: `contains(activeElement)` covers the focused field, and a
  // card holding any non-empty input is left alone even unfocused, because replacing its
  // markup would silently discard what is typed there.
  var due = {};
  function busy(el) {
    if (el.contains(document.activeElement) && document.activeElement !== document.body) return true;
    var fields = el.querySelectorAll('input:not([type=hidden]), textarea, select');
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      if (f.type === 'checkbox' || f.type === 'radio') { if (f.checked !== f.defaultChecked) return true; }
      else if (f.value && f.value !== f.defaultValue) return true;
    }
    return false;
  }

  function tick() {
    var now = Date.now();
    var want = [];
    cards().forEach(function (el) {
      var every = Number(el.dataset.every);
      if (!every || el.hidden || busy(el)) return;
      if (!due[el.dataset.card]) due[el.dataset.card] = now + every * 1000;
      if (due[el.dataset.card] <= now) { want.push(el.dataset.card); due[el.dataset.card] = now + every * 1000; }
    });
    if (!want.length) return;
    fetch(qs('/admin/cards.json', 'only=' + want.join(',')), { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data || !data.cards) return;
        Object.keys(data.cards).forEach(function (id) {
          var el = byId[id];
          if (!el || busy(el)) return;
          var body = el.querySelector('.card-body');
          if (body) body.innerHTML = data.cards[id];
        });
        // A card can appear (the first result) or stop applying; either needs the whole
        // page, and asking for it is cheaper than rebuilding a card shell here.
        if (data.cards_present && data.cards_present.join(',') !== ids.join(',')) location.reload();
      })
      .catch(function () { /* one failed poll is not an error worth showing */ });
  }
  setInterval(tick, 1000);

  // ---- the log -----------------------------------------------------------
  var view = document.querySelector('[data-logview]');
  var lastSeq = 0;
  var buffered = [];

  function paint() {
    if (!view) return;
    var filterEl = document.querySelector('[data-log-filter]');
    var q = filterEl && filterEl.value ? filterEl.value.toLowerCase() : '';
    var followEl = document.querySelector('[data-log-follow]');
    var follow = !followEl || followEl.checked;
    view.textContent = '';
    buffered.forEach(function (l) {
      if (q && l.text.toLowerCase().indexOf(q) === -1) return;
      var line = document.createElement('div');
      line.className = 'logline ' + (l.stream === 'err' ? 'err' : 'out');
      var t = document.createElement('span');
      t.className = 'logtime';
      t.textContent = l.at.slice(11, 19);
      line.appendChild(t);
      line.appendChild(document.createTextNode(l.text));
      view.appendChild(line);
    });
    if (follow) view.scrollTop = view.scrollHeight;
  }

  function pollLog() {
    var card = byId.log;
    if (!view || !card || card.hidden) return;
    fetch(qs('/admin/log.json', 'since=' + lastSeq), { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        var state = document.querySelector('[data-log-state]');
        if (!data) { if (state) state.textContent = '读取失败'; return; }
        lastSeq = data.last_seq;
        if (data.dropped) {
          buffered.push({ at: new Date().toISOString(), stream: 'out',
            text: '… 中间有 ' + data.dropped + ' 行已被缓冲区丢弃（只保留最近 ' + data.capacity + ' 行）' });
        }
        buffered = buffered.concat(data.lines).slice(-data.capacity);
        if (state) state.textContent = buffered.length + ' 行 · 每秒更新';
        paint();
      })
      .catch(function () { /* transient */ });
  }
  // The log card is re-created only by a full page load, so these listeners are bound
  // once here rather than after each refresh: it is the one card with `every: null`.
  document.addEventListener('input', function (ev) {
    if (ev.target.matches && ev.target.matches('[data-log-filter]')) paint();
  });
  document.addEventListener('change', function (ev) {
    if (ev.target.matches && ev.target.matches('[data-log-follow]')) paint();
  });
  pollLog();
  setInterval(pollLog, 1000);
}());
