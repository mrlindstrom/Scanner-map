// CAD dashboard: live incident board built by the bot's tracker (src/cad/tracker.js).
(function () {
  'use strict';

  const PRI = ['P1', 'P2', 'P3', 'P4'];
  const CLOSED_KEEP_SEC = 30 * 60;
  const state = {
    incidents: new Map(),
    board: load('cad.board', 'fire'),
    showMinor: load('cad.minor', 'false') === 'true',
    p1Sound: load('cad.p1sound', 'false') === 'true',
    selected: null,
    token: null,
    skew: 0, // server clock - browser clock (s)
    seenP1: new Set(),
    firstLoad: true,
  };
  let audio = null; let playingId = null; let miniMap = null;

  // ---------- helpers ----------
  function load(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch { return d; } }
  function store(k, v) { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } }
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const now = () => Math.floor(Date.now() / 1000) + state.skew;
  const clockTime = (ts) => new Date(ts * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  function elapsed(sec) {
    sec = Math.max(0, sec);
    const h = Math.floor(sec / 3600); const m = Math.floor((sec % 3600) / 60); const s = sec % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  }
  const statusClass = (s) => `s-${String(s || 'pending').replace(/\s+/g, '-')}`;
  const onBoard = (inc) => state.board === 'all' || inc.board === state.board;
  const visible = (inc) => !inc.dropped && (state.showMinor || !inc.minor || inc.priority === 'P1');
  const sortOpen = (a, b) => PRI.indexOf(a.priority) - PRI.indexOf(b.priority) || b.opened - a.opened;

  // ---------- data ----------
  function upsert(list, serverNow) {
    if (serverNow) state.skew = serverNow - Math.floor(Date.now() / 1000);
    const changed = [];
    for (const inc of list) {
      if (inc.dropped) { state.incidents.delete(inc.id); if (state.selected === inc.id) state.selected = inc.mergedInto || null; continue; }
      const prev = state.incidents.get(inc.id);
      inc._flash = !!prev && (prev.updated !== inc.updated || prev.priority !== inc.priority || prev.status !== inc.status);
      state.incidents.set(inc.id, inc);
      changed.push(inc);
      if (inc.priority === 'P1' && !inc.closed && !state.seenP1.has(inc.id)) {
        state.seenP1.add(inc.id);
        inc._newP1 = true;
        if (!state.firstLoad && state.p1Sound) beep();
      }
    }
    prune();
    render();
    return changed;
  }
  function prune() {
    const cutoff = now() - CLOSED_KEEP_SEC;
    for (const [id, inc] of state.incidents) if (inc.closed && inc.closed < cutoff) state.incidents.delete(id);
  }

  async function initialLoad() {
    try {
      const r = await fetch('/api/cad/incidents', { credentials: 'same-origin' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      state.incidents.clear();
      upsert(j.incidents || [], j.now);
    } catch (e) {
      $('empty').hidden = false;
      $('empty').textContent = `Could not load incidents (${e.message}).`;
    }
    state.firstLoad = false;
  }

  // ---------- rendering ----------
  function render() {
    const all = [...state.incidents.values()].filter(visible);
    for (const b of ['fire', 'law', 'all']) {
      const n = all.filter((i) => !i.closed && (b === 'all' || i.board === b)).length;
      document.querySelector(`[data-count="${b}"]`).textContent = n;
    }
    document.querySelectorAll('.cad-tabs button').forEach((btn) => btn.setAttribute('aria-selected', String(btn.dataset.board === state.board)));

    const mine = all.filter(onBoard);
    const open = mine.filter((i) => !i.closed).sort(sortOpen);
    const closed = mine.filter((i) => i.closed).sort((a, b) => b.closed - a.closed);
    $('incident-list').innerHTML = open.map(rowHtml).join('');
    $('closed-list').innerHTML = closed.map(rowHtml).join('');
    $('closed-count').textContent = closed.length;
    $('closed-wrap').hidden = closed.length === 0;
    $('empty').hidden = open.length > 0;
    if (!open.length) $('empty').textContent = state.showMinor ? 'No active incidents.' : 'No active incidents. Minor calls are hidden.';

    renderP1(all);
    renderStats(open);
    renderSide();
    for (const inc of all) { inc._flash = false; }
  }

  function rowHtml(inc) {
    const units = inc.units.filter((u) => u.status !== 'clear' || inc.closed);
    // Named units first; unnamed radios (police radios rarely send aliases) only up to the space left
    const isRadio = (u) => /^Radio \d+$/.test(u.name);
    const ordered = [...units.filter((u) => !isRadio(u)), ...units.filter(isRadio).sort((a, b) => (a.status === 'dispatched') - (b.status === 'dispatched'))];
    const shown = ordered.slice(0, 4);
    const more = ordered.length - shown.length;
    const chips = units.length
      ? shown.map((u) => `<span class="chip ${statusClass(u.status)}" title="${esc(u.name)}: ${esc(u.status)}${u.agency ? ` (${esc(u.agency)})` : ''}">${esc(u.name)}</span>`).join('')
        + (more > 0 ? `<span class="chip none" title="${esc(ordered.slice(4).map((u) => `${u.name}: ${u.status}`).join(', '))}">+${more} radio${more === 1 ? '' : 's'}</span>` : '')
      : '<span class="chip none">no units</span>';
    const ag = inc.agencies.map((a) => `<span class="badge ${esc(a.kind)}">${esc(a.name)}</span>`).join('');
    const end = inc.closed || now();
    return `<button class="inc ${inc.priority}${inc._flash ? ' flash' : ''}${state.selected === inc.id ? ' selected' : ''}" data-id="${inc.id}">
      <span class="pcell"><span class="pri ${inc.priority}">${inc.priority}</span></span>
      <span class="what"><div class="type">${esc(inc.type)}</div><div class="addr">${esc(inc.address || 'Location unknown')}</div><div class="ag">${ag}</div></span>
      <span class="units">${chips}</span>
      <span class="stcell"><span class="status ${statusClass(inc.closed ? 'closed' : inc.status)}">${esc(inc.closed ? 'closed' : inc.status)}</span></span>
      <span class="elapsed" data-opened="${inc.opened}" data-closed="${inc.closed || ''}">${elapsed(end - inc.opened)}<span class="sub">${clockTime(inc.opened)}</span></span>
    </button>`;
  }

  function renderP1(all) {
    const p1 = all.filter((i) => i.priority === 'P1' && !i.closed).sort((a, b) => b.opened - a.opened);
    const band = $('p1-band');
    band.hidden = p1.length === 0;
    band.innerHTML = p1.map((i) => {
      const html = `<button class="p1-card${i._newP1 ? ' new' : ''}" data-id="${i.id}">
        <div class="t">🔴 ${esc(i.type)}</div><div class="a">${esc(i.address || 'Location unknown')}</div>
        <div class="m">${esc(i.status)} · ${i.units.length} unit${i.units.length === 1 ? '' : 's'} · opened ${clockTime(i.opened)} · <span data-opened="${i.opened}" class="p1-el">${elapsed(now() - i.opened)}</span></div></button>`;
      i._newP1 = false;
      return html;
    }).join('');
  }

  function renderStats(open) {
    const counts = PRI.map((p) => [p, open.filter((i) => i.priority === p).length]).filter(([, n]) => n);
    const units = new Set(); open.forEach((i) => i.units.filter((u) => u.status !== 'clear').forEach((u) => units.add(u.name)));
    const onScene = open.filter((i) => i.status === 'on scene').length;
    $('cad-stats').innerHTML = [
      `<span><b>${open.length}</b> active</span>`,
      ...counts.map(([p, n]) => `<span><span class="pri ${p}">${p}</span> <b>${n}</b></span>`),
      `<span><b>${units.size}</b> units committed</span>`,
      `<span><b>${onScene}</b> on scene</span>`,
    ].join('');
  }

  function renderSide() {
    const inc = state.selected != null ? state.incidents.get(state.selected) : null;
    const detail = $('detail');
    $('side').classList.toggle('has-detail', !!inc);
    if (!inc) {
      detail.hidden = true; detail.innerHTML = ''; destroyMap();
      $('unit-board').hidden = false;
      renderUnitBoard();
      return;
    }
    $('unit-board').hidden = true;
    const scroll = detail.scrollTop;
    const keepMap = miniMap && miniMap._incId === inc.id;
    const end = inc.closed || now();
    const items = [
      ...inc.calls.map((c) => ({ at: c.timestamp, call: c })),
      ...inc.events.filter((e) => !/^note:/.test(e.text)).map((e) => ({ at: e.at, ev: e.text })),
    ].sort((a, b) => a.at - b.at || (a.call ? -1 : 1));
    const notes = inc.events.filter((e) => /^note:/.test(e.text)).slice(-1);
    detail.hidden = false;
    detail.innerHTML = `
      <div class="top"><span class="pri ${inc.priority}">${inc.priority}</span><h2>${esc(inc.type)}</h2><button class="close-btn" data-close aria-label="Close">✕</button></div>
      <div class="meta">
        <div class="addr">${esc(inc.address || 'Location unknown')}</div>
        <div><span class="status ${statusClass(inc.closed ? 'closed' : inc.status)}">${esc(inc.closed ? 'closed' : inc.status)}</span>
          · opened ${clockTime(inc.opened)} · ${inc.closed ? `closed ${clockTime(inc.closed)}${inc.closedBy === 'quiet' ? ' (quiet)' : ''}` : `<span data-opened="${inc.opened}" class="d-el">${elapsed(end - inc.opened)}</span> elapsed`}</div>
        <div>${inc.agencies.map((a) => `<span class="badge ${esc(a.kind)}">${esc(a.name)}</span>`).join(' ')}</div>
        ${inc.channels.length ? `<div>Channels: ${esc(inc.channels.join(', '))}</div>` : ''}
        ${notes.length ? `<div>Latest: ${esc(notes[0].text.replace(/^note:\s*/, ''))}</div>` : ''}
      </div>
      ${inc.lat != null ? (keepMap ? '' : '<div class="mini-map" id="mini-map"></div>') : ''}
      <h3>Units</h3>
      ${inc.units.length ? `<table class="utable">${inc.units.map((u) => `<tr><td><b>${esc(u.name)}</b>${u.agency ? `<br><small>${esc(u.agency)}</small>` : ''}</td><td><span class="chip ${statusClass(u.status)}">${esc(u.status)}</span></td><td>${clockTime(u.at)}</td></tr>`).join('')}</table>` : '<p class="empty" style="padding:0">No units identified yet.</p>'}
      <h3>Timeline</h3>
      <ul class="timeline">${items.map((it) => it.call
        ? `<li class="call"><span class="tm">${clockTime(it.at)}</span><span><div class="who"><button class="play${playingId === it.call.id ? ' playing' : ''}" data-play="${it.call.id}" aria-label="Play">${playingId === it.call.id ? '■' : '▶'}</button>${esc(it.call.tg)}${it.call.radios.length ? ` · ${esc(it.call.radios.slice(0, 4).join(', '))}` : ''}${it.call.fromDispatcher ? ' · dispatch' : ''}</div><div class="txt">${esc(it.call.text)}</div></span></li>`
        : `<li><span class="tm">${clockTime(it.at)}</span><span class="ev">${esc(it.ev)}</span></li>`).join('')}</ul>`;
    if (keepMap) {
      // Same incident: move the existing map back in instead of rebuilding it (no tile flicker)
      detail.insertBefore(miniMap.getContainer(), detail.querySelector('h3'));
    } else {
      destroyMap();
      if (inc.lat != null && window.L) {
        miniMap = L.map('mini-map', { zoomControl: false, attributionControl: false }).setView([inc.lat, inc.lon], 15);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(miniMap);
        L.circleMarker([inc.lat, inc.lon], { radius: 9, color: getComputedStyle(document.documentElement).getPropertyValue(`--${inc.priority.toLowerCase()}`).trim() || '#ef4444', weight: 3 }).addTo(miniMap);
        miniMap._incId = inc.id;
      }
    }
    detail.scrollTop = scroll;
  }
  function destroyMap() { if (miniMap) { miniMap.remove(); miniMap = null; } }

  function renderUnitBoard() {
    const open = [...state.incidents.values()].filter((i) => visible(i) && onBoard(i) && !i.closed);
    const groups = new Map();
    for (const inc of open) {
      for (const u of inc.units) {
        if (u.status === 'clear') continue;
        const g = u.agency || inc.agencies[0]?.name || 'Other';
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push({ u, inc });
      }
    }
    const html = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([g, list]) => `
      <div class="group"><h3>${esc(g)} (${list.length})</h3>
      ${list.sort((a, b) => a.u.name.localeCompare(b.u.name, undefined, { numeric: true })).map(({ u, inc }) => `
        <button class="unit-row" data-id="${inc.id}"><span class="n">${esc(u.name)}<span class="i">${esc(inc.type)}${inc.address ? ` · ${esc(inc.address)}` : ''}</span></span><span class="chip ${statusClass(u.status)}">${esc(u.status)}</span></button>`).join('')}
      </div>`).join('');
    $('unit-board').innerHTML = `<h2>Units</h2>${html || '<p class="empty" style="padding:0">No units committed.</p>'}`;
  }

  // ---------- audio ----------
  async function getToken() {
    if (state.token) return state.token;
    try { const j = await (await fetch('/api/sessions/current', { credentials: 'same-origin' })).json(); state.token = j.session?.token || ''; } catch { state.token = ''; }
    return state.token;
  }
  async function play(id) {
    if (audio) { audio.pause(); audio = null; }
    if (playingId === id) { playingId = null; renderSide(); return; }
    const token = await getToken();
    audio = new Audio(`/audio/${encodeURIComponent(id)}${token ? `?token=${encodeURIComponent(token)}` : ''}`);
    playingId = id;
    audio.addEventListener('ended', () => { playingId = null; renderSide(); });
    audio.play().catch(() => { playingId = null; renderSide(); });
    renderSide();
  }
  let actx = null;
  function beep() {
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      [0, 0.25, 0.5].forEach((t) => {
        const o = actx.createOscillator(); const g = actx.createGain();
        o.frequency.value = 880; o.connect(g); g.connect(actx.destination);
        g.gain.setValueAtTime(0.15, actx.currentTime + t); g.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + t + 0.2);
        o.start(actx.currentTime + t); o.stop(actx.currentTime + t + 0.2);
      });
    } catch { /* audio blocked */ }
  }

  // ---------- events ----------
  document.addEventListener('click', (e) => {
    const playBtn = e.target.closest('[data-play]');
    if (playBtn) { play(playBtn.dataset.play); return; }
    if (e.target.closest('[data-close]')) { state.selected = null; render(); return; }
    const tab = e.target.closest('.cad-tabs button');
    if (tab) { state.board = tab.dataset.board; store('cad.board', state.board); state.selected = null; render(); return; }
    const row = e.target.closest('[data-id]');
    if (row) { const id = Number(row.dataset.id); state.selected = state.selected === id ? null : id; render(); }
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.selected != null) { state.selected = null; render(); } });
  $('show-minor').checked = state.showMinor;
  $('show-minor').addEventListener('change', (e) => { state.showMinor = e.target.checked; store('cad.minor', String(state.showMinor)); render(); });
  $('p1-sound').checked = state.p1Sound;
  $('p1-sound').addEventListener('change', (e) => { state.p1Sound = e.target.checked; store('cad.p1sound', String(state.p1Sound)); if (state.p1Sound) beep(); });

  // Clock and running timers, without re-rendering everything
  setInterval(() => {
    $('clock').textContent = new Date((now()) * 1000).toLocaleTimeString();
    document.querySelectorAll('[data-opened]').forEach((el) => {
      const opened = Number(el.dataset.opened); const closed = Number(el.dataset.closed || 0);
      const txt = elapsed((closed || now()) - opened);
      if (el.firstChild && el.firstChild.nodeType === 3) el.firstChild.nodeValue = txt; else el.textContent = txt;
    });
  }, 1000);
  setInterval(() => { prune(); render(); }, 60 * 1000);

  // Theme changed on the map (or another CAD tab): follow it
  window.addEventListener('storage', (e) => {
    if (e.key === 'scannerMap.theme' && e.newValue && window.ScannerTheme) window.ScannerTheme.apply(e.newValue);
  });
  // The mini map's marker color comes from the theme's priority colors; redraw it on a theme change
  document.addEventListener('scannermap:themechange', () => { destroyMap(); renderSide(); });

  // Live updates
  const conn = $('conn');
  if (window.io) {
    const socket = io();
    socket.on('connect', () => { conn.classList.add('live'); conn.title = 'Live'; initialLoad(); });
    socket.on('disconnect', () => { conn.classList.remove('live'); conn.title = 'Disconnected, reconnecting…'; });
    socket.on('cadUpdate', (msg) => upsert(msg.incidents || [], msg.now));
  } else {
    initialLoad();
    setInterval(initialLoad, 15000);
  }
})();
