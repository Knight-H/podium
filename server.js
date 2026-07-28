'use strict';

/*
 * Demo-day ranked-choice voting — single-file, zero-dependency Node server.
 *
 * Voters open  /            -> type name, pick 1st/2nd/3rd, submit.
 * Admin opens  /admin?key=  -> add demo names live, open/close voting, watch results.
 *
 * Scoring: 1st = 3 pts, 2nd = 2 pts, 3rd = 1 pt.
 * One ballot per name (server-side) + one name per device (client localStorage lock).
 * State lives in ./data.json — delete it to fully reset.
 *
 *   node server.js            # PORT defaults to 8080
 *   PORT=3000 node server.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;
const DATA_FILE = path.join(__dirname, 'data.json');

// ---------------------------------------------------------------------------
// storage (a plain JSON file; fine for a single-room demo)
// ---------------------------------------------------------------------------
function defaultData() {
  return {
    adminKey: crypto.randomBytes(6).toString('hex'), // stable across restarts once saved
    contestants: [],                                 // [{ id, name }]
    votes: {},                                       // { nameKey: { name, first, second, third, ts } }
    votingOpen: false,
  };
}

let data;
try {
  data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  // backfill any missing fields if the file is from an older run
  const d = defaultData();
  data = { ...d, ...data };
} catch {
  data = defaultData();
}

function save() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}
save(); // persist the freshly generated adminKey on first run

const nameKey = (s) => String(s || '').trim().toLowerCase();

// ---------------------------------------------------------------------------
// scoring
// ---------------------------------------------------------------------------
function leaderboard() {
  const byId = new Map(data.contestants.map((c) => [c.id, { id: c.id, name: c.name, points: 0, firsts: 0, seconds: 0, thirds: 0 }]));
  let voters = 0;
  for (const v of Object.values(data.votes)) {
    voters++;
    const add = (id, pts, key) => {
      const row = byId.get(id);
      if (row) { row.points += pts; row[key]++; }
    };
    if (v.first) add(v.first, 3, 'firsts');
    if (v.second) add(v.second, 2, 'seconds');
    if (v.third) add(v.third, 1, 'thirds');
  }
  const rows = [...byId.values()].sort(
    (a, b) => b.points - a.points || b.firsts - a.firsts || b.seconds - a.seconds || a.name.localeCompare(b.name),
  );
  return { rows, voters };
}

// ---------------------------------------------------------------------------
// http helpers
// ---------------------------------------------------------------------------
function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
function sendHtml(res, html) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e6) { req.destroy(); reject(new Error('body too large')); }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}
function isAdmin(req, url) {
  const key = url.searchParams.get('key') || req.headers['x-admin-key'];
  return key && key === data.adminKey;
}

// ---------------------------------------------------------------------------
// server
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  const m = req.method;

  try {
    // ---- pages ----
    if (m === 'GET' && p === '/') return sendHtml(res, VOTER_HTML);
    if (m === 'GET' && p === '/admin') return sendHtml(res, ADMIN_HTML);
    if (m === 'GET' && p === '/reveal') return sendHtml(res, REVEAL_HTML);

    // ---- public API ----
    if (m === 'GET' && p === '/api/state') {
      return send(res, 200, {
        contestants: data.contestants.map((c) => ({ id: c.id, name: c.name })),
        votingOpen: data.votingOpen,
      });
    }

    if (m === 'POST' && p === '/api/vote') {
      if (!data.votingOpen) return send(res, 403, { error: 'Voting is not open yet.' });
      const body = await readBody(req);

      // voter identity = one of the roster entries (one ballot per person)
      const voterId = String(body.voterId || '');
      const voter = data.contestants.find((c) => c.id === voterId);
      if (!voter) return send(res, 400, { error: 'Pick who you are.' });

      const ids = new Set(data.contestants.map((c) => c.id));
      const picks = [body.first, body.second, body.third].map((x) => (x ? String(x) : null));
      const provided = picks.filter(Boolean);

      // you can rank everyone except yourself; require up to 3
      const required = Math.min(3, Math.max(0, data.contestants.length - 1));
      if (provided.length < required) return send(res, 400, { error: `Please pick your top ${required}.` });
      for (const id of provided) {
        if (!ids.has(id)) return send(res, 400, { error: 'Unknown pick — refresh and try again.' });
        if (id === voterId) return send(res, 400, { error: "You can't vote for yourself." });
      }
      if (new Set(provided).size !== provided.length) return send(res, 400, { error: 'Pick a different team for each place.' });

      data.votes[voterId] = {
        voterId,
        name: voter.name,
        first: picks[0] || null,
        second: picks[1] || null,
        third: picks[2] || null,
        ts: Date.now(),
      };
      save();
      return send(res, 200, { ok: true });
    }

    // ---- admin API (everything below requires the key) ----
    if (p.startsWith('/api/admin/')) {
      if (!isAdmin(req, url)) return send(res, 401, { error: 'Invalid or missing admin key.' });

      if (m === 'GET' && p === '/api/admin/results') {
        const lb = leaderboard();
        return send(res, 200, { ...lb, votingOpen: data.votingOpen, contestants: data.contestants });
      }

      if (m === 'POST' && p === '/api/admin/contestant') {
        const body = await readBody(req);
        const name = String(body.name || '').trim();
        if (!name) return send(res, 400, { error: 'Name required.' });
        if (data.contestants.some((c) => c.name.toLowerCase() === name.toLowerCase()))
          return send(res, 400, { error: 'That demo is already on the list.' });
        data.contestants.push({ id: crypto.randomUUID(), name });
        save();
        return send(res, 200, { ok: true, contestants: data.contestants });
      }

      if (m === 'POST' && p === '/api/admin/contestant/delete') {
        const body = await readBody(req);
        const id = String(body.id || '');
        data.contestants = data.contestants.filter((c) => c.id !== id);
        // strip the removed demo from any cast ballots
        for (const v of Object.values(data.votes)) {
          if (v.first === id) v.first = null;
          if (v.second === id) v.second = null;
          if (v.third === id) v.third = null;
        }
        save();
        return send(res, 200, { ok: true, contestants: data.contestants });
      }

      if (m === 'POST' && p === '/api/admin/voting') {
        const body = await readBody(req);
        data.votingOpen = !!body.open;
        save();
        return send(res, 200, { ok: true, votingOpen: data.votingOpen });
      }

      if (m === 'POST' && p === '/api/admin/reset') {
        const body = await readBody(req);
        data.votes = {};
        if (body.what === 'all') data.contestants = [];
        data.votingOpen = false;
        save();
        return send(res, 200, { ok: true });
      }
    }

    return send(res, 404, { error: 'Not found' });
  } catch (err) {
    return send(res, 400, { error: err.message || 'Bad request' });
  }
});

server.listen(PORT, () => {
  const line = '='.repeat(52);
  console.log(`\n${line}`);
  console.log('  Demo-day voting is running');
  console.log(line);
  console.log(`  Voter page : http://localhost:${PORT}/`);
  console.log(`  Admin page : http://localhost:${PORT}/admin?key=${data.adminKey}`);
  console.log(line);
  console.log('  Share the VOTER page with the room (QR is on the admin page).');
  console.log('  Keep the ADMIN url private — the key is your password.\n');
});

// ===========================================================================
// HTML — voter page
// ===========================================================================
const VOTER_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Vote — Demo Day</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 16px/1.5 -apple-system, system-ui, "Segoe UI", Roboto, sans-serif;
         background: #0f1115; color: #e8eaed; -webkit-font-smoothing: antialiased; }
  .wrap { max-width: 440px; margin: 0 auto; padding: 24px 18px 60px; }
  h1 { font-size: 22px; margin: 8px 0 2px; }
  .sub { color: #9aa0a6; margin: 0 0 22px; font-size: 14px; }
  label { display: block; font-size: 13px; color: #9aa0a6; margin: 16px 0 6px; font-weight: 600;
          text-transform: uppercase; letter-spacing: .04em; }
  input, select { width: 100%; padding: 13px 12px; font-size: 16px; border-radius: 12px;
          border: 1px solid #2a2f3a; background: #171a21; color: #e8eaed; }
  input:focus, select:focus { outline: 2px solid #6c8cff; border-color: #6c8cff; }
  input:disabled { opacity: .6; }
  .rank { display: flex; align-items: center; gap: 10px; }
  .medal { width: 30px; height: 30px; flex: none; border-radius: 50%; display: grid; place-items: center;
           font-weight: 700; font-size: 14px; }
  .m1 { background: #ffd54a; color: #3a2e00; }
  .m2 { background: #cfd4dc; color: #2a2e34; }
  .m3 { background: #e0a06a; color: #3a2400; }
  button { width: 100%; margin-top: 24px; padding: 15px; font-size: 17px; font-weight: 700;
           border: 0; border-radius: 12px; background: #6c8cff; color: #fff; cursor: pointer; }
  button:disabled { opacity: .45; cursor: default; }
  .msg { margin-top: 16px; padding: 12px 14px; border-radius: 12px; font-size: 14px; display: none; }
  .msg.err { background: #3a1c1c; color: #ffb4b4; display: block; }
  .msg.ok  { background: #16301f; color: #a7f3c0; display: block; }
  .closed { text-align: center; padding: 40px 20px; }
  .closed .big { font-size: 40px; margin-bottom: 8px; }
  .card { background: #171a21; border: 1px solid #232833; border-radius: 16px; padding: 18px; margin-top: 18px; }
  .done h2 { margin: 0 0 10px; font-size: 18px; }
  .ballot-row { display: flex; align-items: center; gap: 10px; padding: 6px 0; }
  .linkish { background: none; color: #8aa4ff; width: auto; margin: 14px 0 0; padding: 0; font-size: 14px; text-decoration: underline; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Demo Day — Vote</h1>
  <p class="sub">Rank your top 3 favourite demos. One vote per person.</p>

  <div id="closed" class="closed" style="display:none">
    <div class="big">🗳️</div>
    <p><strong>Voting hasn't opened yet.</strong><br>Hang tight — it opens once all demos have presented.</p>
    <div id="closedList"></div>
  </div>

  <form id="form" style="display:none">
    <label for="voter">You are</label>
    <select id="voter"></select>

    <label>1st place</label>
    <div class="rank"><span class="medal m1">1</span><select id="first"></select></div>
    <label>2nd place</label>
    <div class="rank"><span class="medal m2">2</span><select id="second"></select></div>
    <label>3rd place</label>
    <div class="rank"><span class="medal m3">3</span><select id="third"></select></div>

    <button id="submit" type="submit">Submit my vote</button>
    <div id="msg" class="msg"></div>
  </form>

  <div id="done" class="card done" style="display:none">
    <h2>✅ Vote counted — thanks!</h2>
    <p style="margin:-4px 0 12px;color:#9aa0a6;font-size:14px">Voted as <strong id="doneName"></strong></p>
    <div id="doneBallot"></div>
    <button id="edit" class="linkish" type="button">Change my vote</button>
  </div>
</div>

<script>
const KEY = 'demoVote.ballot';
let contestants = [], votingOpen = false, editing = false;

function saved() { try { const r = JSON.parse(localStorage.getItem(KEY) || 'null'); return (r && r.voterId) ? r : null; } catch { return null; } }

function escapeHtml(s){ return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

// fill the "You are" dropdown from the roster
function fillIdentity() {
  const sel = el('voter'); const cur = sel.value;
  sel.innerHTML = '<option value="">Choose your name…</option>' +
    contestants.map(c => '<option value="' + c.id + '">' + escapeHtml(c.name) + '</option>').join('');
  if (cur) sel.value = cur;
}
// people you can rank = everyone except yourself
function rankable() { return contestants.filter(c => c.id !== el('voter').value); }
// rebuild the three rank dropdowns: each hides you + anyone already chosen in another place
function rebuildRanks() {
  const selects = [el('first'), el('second'), el('third')];
  const chosen = selects.map(s => s.value);
  selects.forEach((sel, i) => {
    const mine = sel.value;
    const taken = new Set(chosen.filter((v, j) => v && j !== i));
    const opts = rankable().filter(c => !taken.has(c.id));
    sel.innerHTML = '<option value="">Choose…</option>' +
      opts.map(c => '<option value="' + c.id + '"' + (c.id === mine ? ' selected' : '') + '>' + escapeHtml(c.name) + '</option>').join('');
    sel.value = opts.some(c => c.id === mine) ? mine : '';
  });
}
function nameOf(id){ const c = contestants.find(x => x.id === id); return c ? c.name : '—'; }

const el = id => document.getElementById(id);

function render() {
  const rec = saved();
  const hasVoted = !!rec && !editing;

  el('closed').style.display = votingOpen ? 'none' : 'block';
  el('form').style.display = (votingOpen && !hasVoted) ? 'block' : 'none';
  el('done').style.display = (votingOpen && hasVoted) ? 'block' : 'none';

  // list of demos so far, shown while voting is closed
  if (!votingOpen) {
    el('closedList').innerHTML = contestants.length
      ? '<div class="card" style="text-align:left"><label style="margin-top:0">Demos so far</label>' +
        contestants.map(c => '<div class="ballot-row">• ' + escapeHtml(c.name) + '</div>').join('') + '</div>'
      : '';
  }

  if (votingOpen && !hasVoted) {
    fillIdentity();
    if (rec) { // editing your ballot: lock identity to you, prefill picks
      el('voter').value = rec.voterId; el('voter').disabled = true;
      el('first').value = rec.first || ''; el('second').value = rec.second || ''; el('third').value = rec.third || '';
    } else {
      el('voter').disabled = false;
    }
    rebuildRanks();
  }
  if (votingOpen && hasVoted) {
    el('doneName').textContent = nameOf(rec.voterId);
    el('doneBallot').innerHTML =
      '<div class="ballot-row"><span class="medal m1">1</span>' + escapeHtml(nameOf(rec.first)) + '</div>' +
      (rec.second ? '<div class="ballot-row"><span class="medal m2">2</span>' + escapeHtml(nameOf(rec.second)) + '</div>' : '') +
      (rec.third ? '<div class="ballot-row"><span class="medal m3">3</span>' + escapeHtml(nameOf(rec.third)) + '</div>' : '');
  }
}

// re-filter the rank dropdowns whenever any selection changes
['voter', 'first', 'second', 'third'].forEach(id => el(id).addEventListener('change', rebuildRanks));

async function poll() {
  try {
    const r = await fetch('/api/state', { cache: 'no-store' });
    const s = await r.json();
    contestants = s.contestants; votingOpen = s.votingOpen;
    render();
  } catch {}
}

el('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = el('msg'); msg.className = 'msg';
  const rec = saved();
  const voterId = rec ? rec.voterId : el('voter').value;
  const first = el('first').value, second = el('second').value, third = el('third').value;
  const picks = [first, second, third].filter(Boolean);
  if (!voterId) { msg.className = 'msg err'; msg.textContent = 'Pick your name first.'; return; }
  const need = Math.min(3, Math.max(0, contestants.length - 1));
  if (picks.length < need) { msg.className = 'msg err'; msg.textContent = 'Please pick your top ' + need + '.'; return; }
  if (new Set(picks).size !== picks.length) { msg.className = 'msg err'; msg.textContent = 'Pick a different team for each place.'; return; }
  if (picks.includes(voterId)) { msg.className = 'msg err'; msg.textContent = "You can't vote for yourself."; return; }

  el('submit').disabled = true;
  try {
    const r = await fetch('/api/vote', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voterId, first, second, third }),
    });
    const out = await r.json();
    if (!r.ok) { msg.className = 'msg err'; msg.textContent = out.error || 'Something went wrong.'; el('submit').disabled = false; return; }
    localStorage.setItem(KEY, JSON.stringify({ voterId, first, second: second || null, third: third || null }));
    editing = false; el('submit').disabled = false; render();
  } catch {
    msg.className = 'msg err'; msg.textContent = 'Network error — try again.'; el('submit').disabled = false;
  }
});

el('edit').addEventListener('click', () => { editing = true; render(); });

poll();
setInterval(poll, 2500);
</script>
</body>
</html>`;

// ===========================================================================
// HTML — admin page
// ===========================================================================
const ADMIN_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Admin — Demo Day Voting</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.5 -apple-system, system-ui, "Segoe UI", Roboto, sans-serif;
         background: #0f1115; color: #e8eaed; }
  .wrap { max-width: 760px; margin: 0 auto; padding: 22px 18px 70px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #9aa0a6; margin: 0 0 20px; font-size: 13px; }
  .card { background: #171a21; border: 1px solid #232833; border-radius: 16px; padding: 18px; margin-bottom: 18px; }
  .card h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .05em; color: #9aa0a6; margin: 0 0 14px; }
  .row { display: flex; gap: 10px; }
  input { flex: 1; padding: 12px; font-size: 15px; border-radius: 10px; border: 1px solid #2a2f3a; background: #0f1115; color: #e8eaed; }
  input:focus { outline: 2px solid #6c8cff; }
  button { padding: 12px 16px; font-size: 15px; font-weight: 700; border: 0; border-radius: 10px; background: #6c8cff; color: #fff; cursor: pointer; white-space: nowrap; }
  button.ghost { background: #232833; color: #e8eaed; }
  button.danger { background: #402020; color: #ff9d9d; }
  button.big { width: 100%; padding: 16px; font-size: 17px; margin-top: 4px; }
  .list { list-style: none; margin: 14px 0 0; padding: 0; }
  .list li { display: flex; align-items: center; justify-content: space-between; padding: 9px 0; border-top: 1px solid #232833; }
  .list li:first-child { border-top: 0; }
  .del { background: none; color: #ff9d9d; padding: 4px 8px; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 9px 8px; border-bottom: 1px solid #232833; }
  th { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: #9aa0a6; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .pts { font-weight: 800; font-size: 16px; }
  tr.win td { background: #1a2417; }
  tr.win .rankcell::before { content: '🏆 '; }
  .status { display: inline-block; padding: 4px 10px; border-radius: 999px; font-size: 12px; font-weight: 700; }
  .open { background: #16301f; color: #a7f3c0; }
  .shut { background: #3a1c1c; color: #ffb4b4; }
  .share { display: flex; gap: 18px; align-items: center; flex-wrap: wrap; }
  .qr { background: #fff; padding: 10px; border-radius: 12px; }
  .qr img { display: block; width: 150px; height: 150px; }
  .voterurl { font-size: 18px; font-weight: 700; word-break: break-all; }
  .muted { color: #9aa0a6; font-size: 13px; }
  .banner { background: #3a1c1c; color: #ffb4b4; padding: 14px; border-radius: 12px; margin-bottom: 18px; }
  code { background: #0f1115; padding: 2px 6px; border-radius: 6px; }
  .spacer { height: 6px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Demo Day — Admin</h1>
  <p class="sub">Add demos as they present · open voting at the end · watch the leaderboard.</p>

  <div id="authbanner" class="banner" style="display:none">
    Missing or invalid admin key. Open the admin URL printed in your terminal (it ends with <code>?key=…</code>).
  </div>

  <div id="app" style="display:none">
    <!-- share -->
    <div class="card">
      <h2>Share with the room</h2>
      <div class="share">
        <div class="qr"><img id="qr" alt="QR to voter page"></div>
        <div>
          <div class="muted">Voter link</div>
          <div class="voterurl" id="voterUrl"></div>
          <div class="spacer"></div>
          <div class="muted">Wrong link? Paste your public/tunnel URL:</div>
          <div class="row" style="margin-top:6px">
            <input id="shareInput" placeholder="https://something.trycloudflare.com">
            <button class="ghost" id="shareSet">Set</button>
          </div>
        </div>
      </div>
    </div>

    <!-- contestants -->
    <div class="card">
      <h2>Demos <span id="demoCount" class="muted"></span></h2>
      <form id="addForm" class="row">
        <input id="addName" placeholder="Demo / team / project name" maxlength="60" autocomplete="off">
        <button type="submit">Add</button>
      </form>
      <ul id="demoList" class="list"></ul>
    </div>

    <!-- voting control -->
    <div class="card">
      <h2>Voting</h2>
      <p>Status: <span id="statusPill" class="status shut">CLOSED</span>
         &nbsp;·&nbsp; <strong id="voterCount">0</strong> <span class="muted">people have voted</span></p>
      <button id="toggle" class="big">Open voting</button>
    </div>

    <!-- results -->
    <div class="card">
      <h2>Live results (3 · 2 · 1)</h2>
      <button id="revealBtn" style="width:100%;margin-bottom:14px;background:linear-gradient(135deg,#ffd54a,#ff8f3a);color:#3a2400">🏆 Open reveal screen</button>
      <table>
        <thead><tr>
          <th>#</th><th>Demo</th>
          <th class="num">Pts</th><th class="num">1st</th><th class="num">2nd</th><th class="num">3rd</th>
        </tr></thead>
        <tbody id="results"></tbody>
      </table>
      <p id="noResults" class="muted" style="margin-top:14px">No demos yet — add some above.</p>
    </div>

    <!-- danger -->
    <div class="card">
      <h2>Reset</h2>
      <div class="row">
        <button class="danger" id="resetVotes">Clear all votes</button>
        <button class="danger" id="resetAll">Clear votes + demos</button>
      </div>
    </div>
  </div>
</div>

<script>
const KEY = new URLSearchParams(location.search).get('key') || '';
const el = id => document.getElementById(id);
function escapeHtml(s){ return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

async function api(pathname, opts = {}) {
  const sep = pathname.includes('?') ? '&' : '?';
  const r = await fetch(pathname + sep + 'key=' + encodeURIComponent(KEY), {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    cache: 'no-store',
  });
  if (r.status === 401) { el('authbanner').style.display = 'block'; el('app').style.display = 'none'; throw new Error('unauthorized'); }
  return r.json();
}

// open the big-screen reveal (carries the admin key so it can read final results)
el('revealBtn').addEventListener('click', () => window.open('/reveal?key=' + encodeURIComponent(KEY), '_blank'));

// share link + QR
function voterBase() {
  return localStorage.getItem('demoVote.shareUrl') || location.origin;
}
function renderShare() {
  const url = voterBase().replace(/\\/$/, '') + '/';
  el('voterUrl').textContent = url;
  el('qr').src = 'https://api.qrserver.com/v1/create-qr-code/?size=300x300&margin=0&data=' + encodeURIComponent(url);
}
el('shareSet').addEventListener('click', () => {
  const v = el('shareInput').value.trim();
  if (v) { localStorage.setItem('demoVote.shareUrl', v); renderShare(); }
});

// contestants
el('addForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = el('addName').value.trim();
  if (!name) return;
  const out = await api('/api/admin/contestant', { method: 'POST', body: JSON.stringify({ name }) });
  if (out.error) { alert(out.error); return; }
  el('addName').value = ''; el('addName').focus();
  refresh();
});
async function delDemo(id) {
  if (!confirm('Remove this demo?')) return;
  await api('/api/admin/contestant/delete', { method: 'POST', body: JSON.stringify({ id }) });
  refresh();
}

// voting toggle
el('toggle').addEventListener('click', async () => {
  await api('/api/admin/voting', { method: 'POST', body: JSON.stringify({ open: !current.votingOpen }) });
  refresh();
});

// reset
el('resetVotes').addEventListener('click', async () => {
  if (!confirm('Clear ALL votes? Demos stay. This cannot be undone.')) return;
  await api('/api/admin/reset', { method: 'POST', body: JSON.stringify({ what: 'votes' }) });
  refresh();
});
el('resetAll').addEventListener('click', async () => {
  if (!confirm('Clear votes AND all demos, and close voting? This cannot be undone.')) return;
  await api('/api/admin/reset', { method: 'POST', body: JSON.stringify({ what: 'all' }) });
  refresh();
});

let current = { votingOpen: false, rows: [], voters: 0, contestants: [] };
async function refresh() {
  try {
    const d = await api('/api/admin/results');
    current = d;
    // demos
    el('demoCount').textContent = '(' + d.contestants.length + ')';
    el('demoList').innerHTML = d.contestants.map(c =>
      '<li><span>' + escapeHtml(c.name) + '</span><button class="del" data-id="' + c.id + '">Remove</button></li>').join('');
    el('demoList').querySelectorAll('.del').forEach(b => b.onclick = () => delDemo(b.dataset.id));
    // voting status
    el('statusPill').textContent = d.votingOpen ? 'OPEN' : 'CLOSED';
    el('statusPill').className = 'status ' + (d.votingOpen ? 'open' : 'shut');
    el('toggle').textContent = d.votingOpen ? 'Close voting' : 'Open voting';
    el('toggle').className = 'big' + (d.votingOpen ? ' danger' : '');
    el('voterCount').textContent = d.voters;
    // results
    const hasAny = d.rows.length > 0;
    el('noResults').style.display = hasAny ? 'none' : 'block';
    el('results').innerHTML = d.rows.map((row, i) =>
      '<tr class="' + (i === 0 && row.points > 0 ? 'win' : '') + '">' +
        '<td class="rankcell">' + (i + 1) + '</td>' +
        '<td>' + escapeHtml(row.name) + '</td>' +
        '<td class="num pts">' + row.points + '</td>' +
        '<td class="num">' + row.firsts + '</td>' +
        '<td class="num">' + row.seconds + '</td>' +
        '<td class="num">' + row.thirds + '</td>' +
      '</tr>').join('');
  } catch (e) { /* 401 handled in api() */ }
}

if (!KEY) { el('authbanner').style.display = 'block'; }
else {
  el('app').style.display = 'block';
  renderShare();
  refresh();
  setInterval(refresh, 2500);
}
</script>
</body>
</html>`;

// ===========================================================================
// HTML — reveal page (cinematic awards reveal: light is the hero)
// ===========================================================================
const REVEAL_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Reveal — Demo Day</title>
<style>
  :root{
    --void:#05060c; --deep:#0d1230; --ink:#f7f8fc; --dim:#8b93ac;
    --gold:#ffcf5c; --gold-hi:#fff3c6; --gold-deep:#c8891f;
    --silver:#d8dee9; --silver-deep:#95a0b2;
    --bronze:#e0965c; --bronze-deep:#9c5a2a;
    --mono:ui-monospace,"SF Mono","JetBrains Mono",Menlo,Consolas,monospace;
    --sans:system-ui,-apple-system,"Helvetica Neue",Arial,sans-serif;
  }
  *{box-sizing:border-box;margin:0;padding:0;}
  html,body{height:100%;}
  body{
    font-family:var(--sans); color:var(--ink); height:100%; overflow:hidden;
    background:var(--void); -webkit-font-smoothing:antialiased;
    user-select:none;-webkit-user-select:none;
  }
  /* ambient aurora — deep indigo blooms that slowly drift */
  body::before{
    content:''; position:fixed; inset:-25%; z-index:0; pointer-events:none;
    background:
      radial-gradient(40% 35% at 30% 25%, rgba(58,74,180,.30), transparent 70%),
      radial-gradient(45% 40% at 72% 68%, rgba(120,52,150,.22), transparent 70%),
      radial-gradient(50% 45% at 50% 50%, rgba(20,26,70,.5), transparent 75%);
    filter:blur(8px); animation:aurora 22s ease-in-out infinite alternate;
  }
  @keyframes aurora{
    0%{transform:translate3d(-3%,-2%,0) scale(1);}
    50%{transform:translate3d(2%,3%,0) scale(1.08);}
    100%{transform:translate3d(3%,-3%,0) scale(1.04);}
  }
  #fx{position:fixed;inset:0;z-index:2;pointer-events:none;}
  /* spotlight cone */
  .beam{
    position:fixed;top:-12%;left:50%;width:66vw;height:128vh;transform:translateX(-50%);
    background:linear-gradient(to bottom, rgba(255,246,224,.16), rgba(255,246,224,0) 68%);
    clip-path:polygon(43% 0,57% 0,100% 100%,0 100%);
    filter:blur(34px);opacity:0;transition:opacity 1s ease;z-index:1;pointer-events:none;
  }
  .beam.on{opacity:1;}
  .beam.hot{background:linear-gradient(to bottom, rgba(255,214,140,.42), rgba(255,214,140,0) 70%);}
  .vignette{position:fixed;inset:0;z-index:3;pointer-events:none;
    background:radial-gradient(120% 120% at 50% 42%, transparent 45%, rgba(0,0,0,.55) 100%);}
  .flash{position:fixed;inset:0;z-index:20;background:#fff;opacity:0;pointer-events:none;}
  .flash.go{animation:flash .7s ease-out;}
  @keyframes flash{0%{opacity:0;}8%{opacity:.92;}100%{opacity:0;}}

  #root{position:relative;height:100%;z-index:4;}
  .screen{position:absolute;inset:0;display:flex;flex-direction:column;
    align-items:center;justify-content:center;text-align:center;padding:24px;}
  .hidden{display:none!important;}

  .eyebrow{font-family:var(--mono);font-size:clamp(11px,2vw,15px);letter-spacing:.5em;
    text-transform:uppercase;color:var(--dim);padding-left:.5em;}
  h1{font-family:var(--sans);font-weight:900;letter-spacing:-.03em;line-height:.95;
    font-size:clamp(46px,12vw,132px);margin:10px 0 4px;
    background:linear-gradient(180deg,#fff, #b9c2e0);-webkit-background-clip:text;background-clip:text;color:transparent;}
  .hint{font-family:var(--mono);color:var(--dim);font-size:clamp(12px,2.2vw,15px);line-height:1.9;margin-top:18px;letter-spacing:.04em;}
  .hint b{color:var(--ink);font-weight:600;}
  #startBtn{margin-top:36px;padding:17px 40px;font-family:var(--sans);font-size:18px;font-weight:800;
    letter-spacing:.01em;border:0;border-radius:999px;cursor:pointer;color:#2a1c00;
    background:linear-gradient(135deg,var(--gold-hi),var(--gold) 45%,var(--gold-deep));
    box-shadow:0 14px 50px rgba(255,170,60,.4), inset 0 1px 0 rgba(255,255,255,.7);}
  #startBtn:hover{transform:translateY(-2px);box-shadow:0 20px 60px rgba(255,170,60,.5), inset 0 1px 0 rgba(255,255,255,.7);}
  #startBtn:active{transform:translateY(0) scale(.98);}
  #startBtn,.pcol,.reveal,h1,.eyebrow{transition:transform .2s ease;}
  .err{font-family:var(--mono);color:#ff9d9d;margin-top:22px;font-size:14px;max-width:440px;line-height:1.6;}

  /* rotating light rays */
  .rays{position:absolute;width:170vmax;height:170vmax;left:50%;top:50%;
    transform:translate(-50%,-50%);pointer-events:none;z-index:-1;opacity:.0;
    background:repeating-conic-gradient(from 0deg, rgba(255,220,150,.10) 0deg 6deg, transparent 6deg 18deg);
    animation:rayspin 34s linear infinite;transition:opacity 1s ease;}
  .rays.show{opacity:1;}
  .introrays{opacity:.5;}
  @keyframes rayspin{to{transform:translate(-50%,-50%) rotate(360deg);}}

  /* emblem coin (intro) */
  .emblem{width:clamp(96px,20vw,172px);aspect-ratio:1;border-radius:50%;display:grid;place-items:center;position:relative;
    background:radial-gradient(circle at 36% 30%, var(--gold-hi), var(--gold) 42%, var(--gold-deep) 88%);
    box-shadow:inset 0 -10px 26px rgba(90,50,0,.45), inset 0 10px 22px rgba(255,255,255,.55), 0 24px 70px rgba(255,180,60,.35);
    animation:breathe 3.4s ease-in-out infinite;}
  .emblem span{font-size:clamp(44px,9vw,80px);color:rgba(90,50,0,.5);line-height:1;text-shadow:0 1px 0 rgba(255,255,255,.4);}
  @keyframes breathe{0%,100%{transform:translateY(0) scale(1);}50%{transform:translateY(-10px) scale(1.03);}}

  /* countdown */
  .count{font-family:var(--sans);font-weight:900;letter-spacing:-.05em;line-height:1;color:#fff;
    font-size:clamp(180px,46vw,560px);text-shadow:0 0 90px rgba(150,180,255,.55);}
  .count.go{animation:focusIn .95s cubic-bezier(.2,.8,.2,1) both;}
  @keyframes focusIn{0%{filter:blur(46px);opacity:0;transform:scale(2.4);}38%{opacity:1;}100%{filter:blur(0);opacity:0;transform:scale(1);}}
  .ring{position:absolute;border:2px solid rgba(170,195,255,.6);border-radius:50%;
    width:220px;height:220px;left:50%;top:50%;margin:-110px 0 0 -110px;animation:ringOut .95s ease-out both;}
  @keyframes ringOut{0%{transform:scale(.2);opacity:.85;}100%{transform:scale(3.4);opacity:0;}}
  .shake{animation:shake .5s cubic-bezier(.36,.07,.19,.97);}
  @keyframes shake{10%,90%{transform:translateX(-2px);}20%,80%{transform:translateX(4px);}30%,50%,70%{transform:translateX(-8px);}40%,60%{transform:translateX(8px);}}

  /* place reveal */
  .reveal{display:flex;flex-direction:column;align-items:center;position:relative;}
  .coin{width:clamp(120px,25vw,240px);aspect-ratio:1;border-radius:50%;position:relative;display:grid;place-items:center;
    overflow:hidden;animation:coinDrop .7s cubic-bezier(.2,1.3,.4,1) both;}
  .coin .coinnum{font-family:var(--sans);font-weight:900;line-height:1;font-size:clamp(56px,13vw,116px);
    color:rgba(70,42,0,.5);text-shadow:0 1px 0 rgba(255,255,255,.35);}
  .coin::after{content:'';position:absolute;inset:0;border-radius:50%;
    background:linear-gradient(115deg,transparent 38%,rgba(255,255,255,.75) 50%,transparent 62%);
    transform:translateX(-130%);animation:coinShine 2.6s ease-in-out infinite;}
  .coin.gold{background:radial-gradient(circle at 36% 30%,var(--gold-hi),var(--gold) 42%,var(--gold-deep) 88%);
    box-shadow:inset 0 -12px 30px rgba(90,50,0,.45),inset 0 10px 22px rgba(255,255,255,.55),0 26px 70px rgba(255,180,60,.4);}
  .coin.silver{background:radial-gradient(circle at 36% 30%,#ffffff,var(--silver) 42%,var(--silver-deep) 88%);
    box-shadow:inset 0 -12px 30px rgba(40,50,70,.4),inset 0 10px 22px rgba(255,255,255,.7),0 24px 60px rgba(180,195,220,.3);}
  .coin.silver .coinnum{color:rgba(50,60,80,.5);}
  .coin.bronze{background:radial-gradient(circle at 36% 30%,#ffd9b3,var(--bronze) 42%,var(--bronze-deep) 88%);
    box-shadow:inset 0 -12px 30px rgba(70,35,10,.45),inset 0 10px 22px rgba(255,230,200,.5),0 24px 60px rgba(200,120,60,.3);}
  .coin.bronze .coinnum{color:rgba(70,35,10,.55);}
  @keyframes coinDrop{0%{opacity:0;transform:translateY(-40px) scale(.6) rotate(-25deg);}100%{opacity:1;transform:none;}}
  @keyframes coinShine{0%{transform:translateX(-130%);}55%,100%{transform:translateX(130%);}}

  .ranklabel{font-family:var(--mono);text-transform:uppercase;letter-spacing:.44em;padding-left:.44em;
    font-size:clamp(13px,2.6vw,22px);color:var(--dim);margin:22px 0 6px;
    opacity:0;animation:fadeUp .5s ease-out .15s forwards;}
  .pname{font-family:var(--sans);font-weight:900;letter-spacing:-.03em;line-height:1;
    font-size:clamp(46px,11vw,128px);max-width:94vw;overflow-wrap:anywhere;}
  .pname .ltr{display:inline-block;opacity:0;transform:translateY(.55em) rotateX(-55deg);filter:blur(6px);
    animation:ltrIn .55s cubic-bezier(.2,1,.3,1) forwards;}
  @keyframes ltrIn{to{opacity:1;transform:none;filter:blur(0);}}
  .pname.gold{background:linear-gradient(100deg,var(--gold-deep),var(--gold) 30%,var(--gold-hi) 50%,var(--gold) 70%,var(--gold-deep));
    background-size:250% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;
    text-shadow:0 0 70px rgba(255,190,70,.35);
    animation:shimmer 2.4s linear infinite, focusName .9s cubic-bezier(.2,.9,.2,1) both;}
  @keyframes shimmer{0%{background-position:200% 0;}100%{background-position:-60% 0;}}
  @keyframes focusName{0%{opacity:0;filter:blur(26px);transform:scale(1.35);}100%{opacity:1;filter:blur(0);transform:scale(1);}}
  .score{margin-top:20px;display:flex;align-items:baseline;gap:10px;justify-content:center;
    opacity:0;animation:fadeUp .5s ease-out .3s forwards;}
  .scoreN{font-family:var(--mono);font-weight:700;font-variant-numeric:tabular-nums;
    font-size:clamp(30px,6vw,52px);color:var(--ink);}
  .champion .scoreN{color:var(--gold);text-shadow:0 0 30px rgba(255,190,70,.4);}
  .scoreU{font-family:var(--mono);font-size:clamp(13px,2.4vw,18px);letter-spacing:.3em;color:var(--dim);}
  @keyframes fadeUp{0%{opacity:0;transform:translateY(14px);}100%{opacity:1;transform:none;}}

  .suspense{font-family:var(--mono);text-transform:uppercase;letter-spacing:.4em;padding-left:.4em;
    font-size:clamp(20px,5vw,46px);font-weight:600;color:#cbd3e6;animation:pulseDim 1.3s ease-in-out infinite;}
  @keyframes pulseDim{0%,100%{opacity:.3;transform:scale(.99);}50%{opacity:1;transform:scale(1.02);}}

  /* podium */
  .podium-head{margin-bottom:34px;}
  .podium-head .eyebrow{margin-bottom:8px;}
  .podium-head h2{font-family:var(--sans);font-weight:900;letter-spacing:-.02em;font-size:clamp(26px,6vw,52px);
    background:linear-gradient(135deg,var(--gold-hi),var(--gold));-webkit-background-clip:text;background-clip:text;color:transparent;}
  .bars{display:flex;align-items:flex-end;gap:clamp(12px,3vw,40px);}
  .pcol{display:flex;flex-direction:column;align-items:center;justify-content:flex-end;
    opacity:0;transform:translateY(26px);animation:fadeUp .55s ease-out forwards;}
  .pcol .coin{width:clamp(58px,13vw,104px);}
  .pcol .coin .coinnum{font-size:clamp(26px,6vw,50px);}
  .pcol .pname-sm{font-family:var(--sans);font-weight:800;font-size:clamp(15px,3.4vw,26px);
    margin:12px 0 3px;max-width:30vw;overflow-wrap:anywhere;line-height:1.1;}
  .pcol .pts-sm{font-family:var(--mono);font-weight:700;font-variant-numeric:tabular-nums;
    font-size:clamp(13px,3vw,20px);color:var(--gold);}
  .pillar{width:clamp(86px,22vw,178px);border-radius:14px 14px 0 0;margin-top:14px;position:relative;overflow:hidden;
    display:flex;align-items:flex-start;justify-content:center;padding-top:14px;
    transform:scaleY(0);transform-origin:bottom;animation:growBar .8s cubic-bezier(.2,1,.3,1) .1s forwards;
    box-shadow:inset 0 2px 0 rgba(255,255,255,.25), inset 0 -30px 50px rgba(0,0,0,.25);}
  .pillar .rk{font-family:var(--sans);font-weight:900;font-size:clamp(32px,7vw,60px);color:rgba(0,0,0,.28);}
  .pillar.gold{background:linear-gradient(180deg,var(--gold),var(--gold-deep));}
  .pillar.silver{background:linear-gradient(180deg,var(--silver),var(--silver-deep));}
  .pillar.bronze{background:linear-gradient(180deg,var(--bronze),var(--bronze-deep));}
  .pillar.gold::after{content:'';position:absolute;inset:0;
    background:linear-gradient(115deg,transparent 40%,rgba(255,255,255,.55) 50%,transparent 60%);
    transform:translateX(-130%);animation:coinShine 3s ease-in-out 1s infinite;}
  .b1 .pillar{height:clamp(150px,33vh,290px);}
  .b2 .pillar{height:clamp(112px,25vh,220px);}
  .b3 .pillar{height:clamp(84px,19vh,168px);}
  @keyframes growBar{to{transform:scaleY(1);}}

  #controls{position:fixed;bottom:24px;left:0;right:0;display:flex;gap:14px;justify-content:center;z-index:30;}
  .ctl{font-family:var(--mono);padding:11px 22px;border-radius:999px;border:1px solid rgba(255,255,255,.14);
    background:rgba(14,18,40,.75);backdrop-filter:blur(8px);color:var(--ink);font-size:13px;letter-spacing:.06em;
    text-transform:uppercase;font-weight:600;cursor:pointer;text-decoration:none;}
  .ctl:hover{border-color:rgba(255,255,255,.35);}
  .ctl:active{transform:scale(.97);}
  .mute{position:fixed;top:18px;right:18px;z-index:40;font-family:var(--mono);font-size:12px;letter-spacing:.08em;
    text-transform:uppercase;padding:9px 16px;border-radius:999px;border:1px solid rgba(255,255,255,.14);
    background:rgba(14,18,40,.7);backdrop-filter:blur(8px);color:var(--dim);cursor:pointer;}
  .mute:hover{color:var(--ink);border-color:rgba(255,255,255,.3);}

  @media (prefers-reduced-motion:reduce){
    body::before,.emblem,.rays,.coin::after,.pillar.gold::after,.pname.gold{animation:none!important;}
    .count.go,.coin,.ranklabel,.pname .ltr,.score,.pcol{animation-duration:.4s!important;}
    .pname.gold{background-position:0 0;}
  }
</style>
</head>
<body>
<canvas id="fx"></canvas>
<div class="beam" id="beam"></div>
<div class="vignette"></div>
<div class="flash" id="flash"></div>
<div id="root">
  <div id="intro" class="screen">
    <div class="rays introrays"></div>
    <div class="emblem"><span>&#9733;</span></div>
    <div class="eyebrow" style="margin-top:26px">Demo Day</div>
    <h1>The Awards</h1>
    <p class="hint">Close voting first, then begin.<br>Tap the screen or press <b>Space</b> to advance.</p>
    <button id="startBtn">Begin the ceremony</button>
    <div id="err" class="err"></div>
  </div>
  <div id="stage" class="screen hidden"></div>
  <div id="podium" class="screen hidden"></div>
</div>
<div id="controls" class="hidden">
  <button id="replayBtn" class="ctl">&#8635; Replay</button>
  <a id="backLink" class="ctl" href="/admin">&#8592; Admin</a>
</div>
<button id="muteBtn" class="mute">Sound: On</button>

<script>
var KEY = new URLSearchParams(location.search).get('key') || '';
var el = function(id){ return document.getElementById(id); };
function esc(s){ return String(s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
var REDUCE = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
var RANKW = { 1:'First Place', 2:'Second Place', 3:'Third Place' };
var COINCLS = { 1:'gold', 2:'silver', 3:'bronze' };
if (el('backLink')) el('backLink').href = '/admin?key=' + encodeURIComponent(KEY);

/* ---- skippable sleep ---- */
var skipResolve = null, running = false;
function sleep(ms){ return new Promise(function(res){
  skipResolve = function(){ skipResolve = null; res(); };
  setTimeout(function(){ if (skipResolve){ skipResolve = null; res(); } }, ms);
}); }
function skip(){ if (skipResolve) skipResolve(); }

/* ---- audio: synthesized SFX via Web Audio (no files, unlocked by the Start tap) ---- */
var AC = null, master = null, muted = false;
try { muted = localStorage.getItem('demoVote.muted') === '1'; } catch(e){}
function audioInit(){
  if (AC) return;
  var Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  AC = new Ctx();
  master = AC.createGain(); master.gain.value = muted ? 0 : 0.9; master.connect(AC.destination);
}
function aNow(){ return AC ? AC.currentTime : 0; }
function tone(freq, t, dur, type, peak, glide){
  if (!AC) return;
  var o = AC.createOscillator(), g = AC.createGain();
  o.type = type || 'sine'; o.frequency.setValueAtTime(freq, t);
  if (glide) o.frequency.exponentialRampToValueAtTime(glide, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak || 0.3, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(master); o.start(t); o.stop(t + dur + 0.03);
}
function noise(t, dur, peak, ftype, ffreq, q){
  if (!AC) return;
  var n = Math.max(1, Math.floor(AC.sampleRate * dur));
  var buf = AC.createBuffer(1, n, AC.sampleRate), d = buf.getChannelData(0);
  for (var i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  var src = AC.createBufferSource(); src.buffer = buf;
  var f = AC.createBiquadFilter(); f.type = ftype || 'highpass'; f.frequency.value = ffreq || 1000; if (q) f.Q.value = q;
  var g = AC.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak || 0.3, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f); f.connect(g); g.connect(master); src.start(t); src.stop(t + dur + 0.03);
}
function sfxTick(nn){ var t = aNow(); tone(360 + (3 - nn) * 100, t, 0.18, 'triangle', 0.3); noise(t, 0.03, 0.12, 'highpass', 3000); }
function sfxReveal(){ var t = aNow(); tone(200, t, 0.3, 'sawtooth', 0.14, 1400); tone(1568, t + 0.16, 0.45, 'sine', 0.22); tone(3136, t + 0.16, 0.2, 'sine', 0.08); }
function sfxDrumroll(dur){
  if (!AC) return; var t = aNow(), time = t;
  while (time < t + dur){ var prog = (time - t) / dur; noise(time, 0.06, 0.08 + prog * 0.3, 'highpass', 1700, 1); time += 0.09 - prog * 0.06; }
  tone(70, t, dur, 'sine', 0.12);
}
function sfxWinner(){
  var t = aNow();
  noise(t, 1.3, 0.5, 'highpass', 4000);                                  // cymbal crash
  tone(70, t, 0.7, 'sine', 0.4);                                         // sub boom
  var arp = [523.25, 659.25, 783.99, 1046.5];
  for (var i = 0; i < arp.length; i++) tone(arp[i], t + 0.09 * i, 0.5, 'square', 0.16);   // fanfare arpeggio
  var chord = [523.25, 659.25, 783.99];
  for (var j = 0; j < chord.length; j++) tone(chord[j], t + 0.42, 1.5, 'sawtooth', 0.11); // held chord
  for (var a = 0; a < 44; a++) noise(t + 0.15 + a * 0.055 + Math.random() * 0.03, 0.13, 0.03 + Math.random() * 0.06, 'bandpass', 1500 + Math.random() * 1600, 0.7); // applause
}
function updateMuteBtn(){ el('muteBtn').textContent = muted ? 'Sound: Off' : 'Sound: On'; }
function toggleMute(e){ if (e) e.stopPropagation(); muted = !muted;
  try { localStorage.setItem('demoVote.muted', muted ? '1' : '0'); } catch(x){}
  if (master) master.gain.setValueAtTime(muted ? 0 : 0.9, aNow()); updateMuteBtn(); }

function show(id){ ['intro','stage','podium'].forEach(function(s){ el(s).classList.add('hidden'); }); if (id) el(id).classList.remove('hidden'); }
function beamOn(hot){ var b = el('beam'); b.classList.add('on'); b.classList.toggle('hot', !!hot); }
function beamOff(){ el('beam').classList.remove('on'); }

/* ---- canvas: ambient dust always, confetti/streamers on demand ---- */
var canvas = el('fx'), ctx = canvas.getContext('2d'), W = 0, H = 0;
var dust = [], burstParts = [];
var PAL = ['#ffcf5c','#ff8f3a','#ffffff','#8aa4ff','#ff6b9d','#7cf5b0'];
function resize(){ W = canvas.width = window.innerWidth; H = canvas.height = window.innerHeight; }
resize(); window.addEventListener('resize', resize);
function rnd(a,b){ return a + Math.random()*(b-a); }
for (var i=0;i<70;i++) dust.push({ x:rnd(0,1), y:rnd(0,1), r:rnd(.6,2.4), a:rnd(.06,.34), vx:rnd(-.02,.02), vy:rnd(-.06,-.015) });
function addConfetti(n){
  for (var i=0;i<n;i++) burstParts.push({ t:'c', x:rnd(0,W), y:-20-rnd(0,H*.4), w:rnd(6,12), h:rnd(8,16)*.7,
    vx:rnd(-2.5,2.5), vy:rnd(1.5,5), rot:rnd(0,6.28), vr:rnd(-.3,.3), c:PAL[i%PAL.length], life:1 });
}
function cannon(){
  var shots = [{x:W*0.10, dir:1},{x:W*0.90, dir:-1}];
  for (var s=0;s<shots.length;s++){
    for (var i=0;i<70;i++){
      var ang = (shots[s].dir>0? rnd(-1.15,-0.35) : rnd(-2.79,-1.99));
      var sp = rnd(9,17);
      burstParts.push({ t:'c', x:shots[s].x, y:H+10, w:rnd(6,12), h:rnd(8,16)*.7,
        vx:Math.cos(ang)*sp, vy:Math.sin(ang)*sp, rot:rnd(0,6.28), vr:rnd(-.4,.4), c:PAL[i%PAL.length], life:1 });
    }
    for (var j=0;j<10;j++){
      var a2 = (shots[s].dir>0? rnd(-1.1,-0.5) : rnd(-2.64,-2.04));
      var sp2 = rnd(11,18);
      burstParts.push({ t:'s', x:shots[s].x, y:H+10, len:rnd(50,120), vx:Math.cos(a2)*sp2, vy:Math.sin(a2)*sp2,
        rot:a2, vr:rnd(-.06,.06), c:PAL[j%PAL.length], life:1 });
    }
  }
}
function frame(){
  ctx.clearRect(0,0,W,H);
  for (var i=0;i<dust.length;i++){
    var d = dust[i]; d.x += d.vx/ W; d.y += d.vy / H;
    if (d.y < -0.05) { d.y = 1.05; d.x = Math.random(); }
    if (d.x < -0.05) d.x = 1.05; if (d.x > 1.05) d.x = -0.05;
    ctx.globalAlpha = d.a; ctx.fillStyle = '#fff6e0';
    ctx.beginPath(); ctx.arc(d.x*W, d.y*H, d.r, 0, 6.283); ctx.fill();
  }
  ctx.globalAlpha = 1;
  for (var k=burstParts.length-1;k>=0;k--){
    var p = burstParts[k];
    p.vy += 0.16; p.x += p.vx; p.y += p.vy; p.vx *= 0.992;
    if (p.t==='c'){
      p.rot += p.vr;
      ctx.save(); ctx.translate(p.x,p.y); ctx.rotate(p.rot); ctx.fillStyle = p.c;
      ctx.fillRect(-p.w/2,-p.h/2,p.w,p.h); ctx.restore();
    } else {
      p.rot += p.vr;
      ctx.save(); ctx.translate(p.x,p.y); ctx.rotate(Math.atan2(p.vy,p.vx));
      ctx.strokeStyle = p.c; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(p.len,0); ctx.stroke(); ctx.restore();
    }
    if (p.y > H+140) burstParts.splice(k,1);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

/* ---- helpers ---- */
function nameLetters(name){
  var chars = String(name).split(''), out = '';
  for (var i=0;i<chars.length;i++){
    var ch = chars[i]===' ' ? '&nbsp;' : esc(chars[i]);
    var delay = REDUCE ? 0 : (i*42);
    out += '<span class="ltr" style="animation-delay:'+delay+'ms">'+ch+'</span>';
  }
  return out;
}
function countUp(node, to, ms){
  if (REDUCE){ node.textContent = to; return; }
  var start = null;
  function step(t){ if(start===null)start=t; var p=Math.min(1,(t-start)/ms);
    node.textContent = Math.round(to*(1-Math.pow(1-p,3))); if(p<1) requestAnimationFrame(step); else node.textContent = to; }
  requestAnimationFrame(step);
}
function fireRings(){
  var s = el('stage');
  for (var i=0;i<2;i++){ var r=document.createElement('div'); r.className='ring';
    r.style.animationDelay=(i*140)+'ms'; s.appendChild(r); (function(rr){ setTimeout(function(){ if(rr.parentNode) rr.parentNode.removeChild(rr); },1200); })(r); }
}

async function fetchTop(){
  var r = await fetch('/api/admin/results?key=' + encodeURIComponent(KEY), { cache:'no-store' });
  if (r.status === 401) throw new Error('Wrong or missing admin key. Open this via the admin page (the "Open reveal screen" button).');
  var d = await r.json();
  return (d.rows || []).filter(function(x){ return x.points > 0; });
}

async function countdown(){
  show('stage'); beamOn(false);
  for (var i=3;i>=1;i--){
    el('stage').innerHTML = '<div class="count go">'+i+'</div>';
    fireRings(); sfxTick(i);
    if (i===1 && !REDUCE) el('root').classList.add('shake');
    await sleep(950);
    el('root').classList.remove('shake');
  }
}

async function revealPlace(rank, row, hold){
  var champ = rank===1;
  el('stage').innerHTML =
    '<div class="reveal'+(champ?' champion':'')+'">'+
      (champ?'<div class="rays show"></div>':'')+
      '<div class="coin '+COINCLS[rank]+'"><span class="coinnum">'+rank+'</span></div>'+
      '<div class="ranklabel">'+RANKW[rank]+'</div>'+
      '<div class="pname'+(champ?' gold':'')+'">'+(champ?esc(row.name):nameLetters(row.name))+'</div>'+
      '<div class="score"><span class="scoreN">0</span><span class="scoreU">Pts</span></div>'+
    '</div>';
  show('stage'); beamOn(champ);
  if (!champ) sfxReveal();
  var scoreN = el('stage').querySelector('.scoreN');
  setTimeout(function(){ countUp(scoreN, row.points, champ?1200:900); }, champ?350:(String(row.name).length*42+250));
  await sleep(hold);
}

async function suspense(){
  beamOff();
  el('stage').innerHTML = '<div class="suspense">And the winner is</div>';
  show('stage');
  sfxDrumroll(2.2);
  await sleep(2200);
}

function buildPodium(top){
  function col(rank, row, bcls){
    if (!row) return '';
    return '<div class="pcol '+bcls+'" style="animation-delay:'+((3-rank)*140)+'ms">'+
      '<div class="coin '+COINCLS[rank]+'"><span class="coinnum">'+rank+'</span></div>'+
      '<div class="pname-sm">'+esc(row.name)+'</div>'+
      '<div class="pts-sm"><span class="pu" data-to="'+row.points+'">0</span> pts</div>'+
      '<div class="pillar '+COINCLS[rank]+'"><span class="rk">'+rank+'</span></div>'+
    '</div>';
  }
  el('podium').innerHTML =
    '<div class="podium-head"><div class="eyebrow">Demo Day</div><h2>Final Standings</h2></div>'+
    '<div class="bars">'+ col(2, top[1], 'b2') + col(1, top[0], 'b1') + col(3, top[2], 'b3') +'</div>';
  show('podium');
  var pus = el('podium').querySelectorAll('.pu');
  for (var i=0;i<pus.length;i++){ (function(node){ setTimeout(function(){ countUp(node, parseInt(node.getAttribute('data-to'),10), 1100); }, 500); })(pus[i]); }
}

async function run(){
  if (running) return;
  running = true;
  audioInit(); if (AC && AC.state === 'suspended') AC.resume();
  el('err').textContent = '';
  el('controls').classList.add('hidden');
  var top;
  try { top = await fetchTop(); }
  catch (e){ show('intro'); el('err').textContent = e.message; running = false; return; }
  if (!top.length){ show('intro'); el('err').textContent = 'No votes yet — nothing to reveal.'; running = false; return; }

  await countdown();
  if (top[2]) await revealPlace(3, top[2], 2800);
  if (top[1]) await revealPlace(2, top[1], 2800);
  await suspense();
  el('flash').classList.remove('go'); void el('flash').offsetWidth; el('flash').classList.add('go');
  sfxWinner();
  await revealPlace(1, top[0], 3200);
  cannon(); cannon();
  await sleep(600);
  buildPodium(top);
  addConfetti(60);
  el('controls').classList.remove('hidden');
  running = false;
}

el('startBtn').addEventListener('click', run);
el('replayBtn').addEventListener('click', run);
el('muteBtn').addEventListener('click', toggleMute); updateMuteBtn();
document.addEventListener('click', function(){ if (running) skip(); });
document.addEventListener('keydown', function(e){
  if (e.code === 'Space' || e.code === 'Enter'){
    e.preventDefault();
    if (running) skip();
    else if (!el('intro').classList.contains('hidden')) run();
  }
});
</script>
</body>
</html>`;
