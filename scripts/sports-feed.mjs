// Teen Patti Club - sports data job.
// Runs on a schedule in GitHub Actions (.github/workflows/sports-feed.yml). Every run it:
//   1. reads matches, live scores and results from the data services,
//   2. writes them to Firestore (/sports/{id}) with opening odds for new matches,
//   3. closes betting when a match starts, and settles every open bet when a match ends (or is called off),
//   4. records what it did in /sportsMeta/feed (shown on the console's Data feed tab).
// Football and basketball come from API-Sports (APISPORTS_KEY), cricket from CricketData.org (CRICKETDATA_KEY).
// A sport whose key is missing is skipped. The Firebase service account is the secret FIREBASE_SERVICE_ACCOUNT.
// To save calls, the full list of the next days' matches is fetched every few hours; in between, only the
// matches that are live (or about to start) are refreshed.

const FULL_EVERY_MS = 3 * 3600e3;     // the full schedule, every 3 hours
const DAYS_AHEAD = 2;                 // today and the next 2 days
const SOON_MS = 20 * 60000;           // a match this close to its start is checked every run
const KEEP_DONE_MS = 3 * 864e5;       // settled matches are removed after 3 days
const MAX_PER_SPORT = 60;             // at most this many upcoming matches per sport in the list

// Competitions to list (edit the GitHub variables FOOTBALL_LEAGUES / BASKETBALL_LEAGUES to change them).
// Football (API-Sports ids): Premier League 39, La Liga 140, Serie A 135, Bundesliga 78, Ligue 1 61, Champions League 2,
// Europa League 3, Indian Super League 323, World Cup 1, Euro 4, Nations League 5, MLS 253, Saudi Pro League 307.
const FB_DEFAULT = [39, 140, 135, 78, 61, 2, 3, 323, 1, 4, 5, 253, 307];
// Basketball: NBA 12, Euroleague 120.
const BK_DEFAULT = [12, 120];

export const payout = (stake, odds) => Math.floor(stake * odds + 0.000001);

export function defaultMarkets(sport, home, away, withDraw) {
  const opts = { home: { label: home, odds: sport === 'football' ? 2.3 : 1.9 } };
  if (sport === 'football' || withDraw) opts.draw = { label: 'Draw', odds: sport === 'football' ? 3.2 : 4.0 };
  opts.away = { label: away, odds: sport === 'football' ? 2.9 : 1.9 };
  return { win: { name: sport === 'football' ? 'Match result' : 'Match winner', open: true, opts } };
}

/* ---- turning each service's answer into one match shape ---- */
const FB_LIVE = ['1H', 'HT', '2H', 'ET', 'BT', 'P', 'SUSP', 'INT', 'LIVE'], FB_DONE = ['FT', 'AET', 'PEN'], FB_OFF = ['PST', 'CANC', 'ABD', 'AWD', 'WO'];
export function fromFootball(x) {
  const st = x.fixture.status.short, home = x.teams.home, away = x.teams.away;
  const status = FB_LIVE.includes(st) ? 'live' : FB_DONE.includes(st) ? 'finished' : FB_OFF.includes(st) ? 'cancelled' : 'upcoming';
  const g = x.goals || {};
  let win = '';
  if (status === 'finished') win = home.winner === true ? 'home' : away.winner === true ? 'away' : 'draw';
  // a cup tie decided on penalties: the 90-minute result is what counts for "Match result"
  if (status === 'finished' && st === 'PEN' && x.score && x.score.fulltime && x.score.fulltime.home != null) {
    const f = x.score.fulltime; win = f.home > f.away ? 'home' : f.away > f.home ? 'away' : 'draw';
  }
  return { id: 'fb_' + x.fixture.id, srcId: String(x.fixture.id), sport: 'football', league: x.league.name, leagueLogo: x.league.logo || '',
    home: { name: home.name, short: '', logo: home.logo || '' }, away: { name: away.name, short: '', logo: away.logo || '' },
    startAt: x.fixture.timestamp * 1000, status,
    score: { home: g.home == null ? '' : String(g.home), away: g.away == null ? '' : String(g.away) },
    detail: status === 'live' ? (st === 'HT' ? 'Half time' : x.fixture.status.elapsed ? x.fixture.status.elapsed + "'" : st) : status === 'cancelled' ? x.fixture.status.long : '',
    win, leagueId: x.league.id };
}
const BK_LIVE = ['Q1', 'Q2', 'Q3', 'Q4', 'OT', 'BT', 'HT'], BK_DONE = ['FT', 'AOT'], BK_OFF = ['POST', 'CANC', 'SUSP', 'AWD', 'ABD'];
export function fromBasketball(x) {
  const st = x.status.short, s = x.scores || {}, h0 = (s.home && s.home.total), a0 = (s.away && s.away.total);
  const status = BK_LIVE.includes(st) ? 'live' : BK_DONE.includes(st) ? 'finished' : BK_OFF.includes(st) ? 'cancelled' : 'upcoming';
  return { id: 'bk_' + x.id, srcId: String(x.id), sport: 'basketball', league: x.league.name, leagueLogo: x.league.logo || '',
    home: { name: x.teams.home.name, short: '', logo: x.teams.home.logo || '' }, away: { name: x.teams.away.name, short: '', logo: x.teams.away.logo || '' },
    startAt: x.timestamp * 1000, status,
    score: { home: h0 == null ? '' : String(h0), away: a0 == null ? '' : String(a0) },
    detail: status === 'live' ? st + (x.status.timer ? ' ' + x.status.timer + "'" : '') : status === 'cancelled' ? x.status.long : '',
    win: status === 'finished' && h0 != null && a0 != null ? (h0 > a0 ? 'home' : a0 > h0 ? 'away' : 'void') : '', leagueId: x.league.id };
}
export function fromCricket(x) {
  const teams = x.teams || [], info = x.teamInfo || [], ti = n => info.find(t => t.name === n) || {};
  const [hn, an] = teams; if (!hn || !an) return null;
  const startAt = Date.parse((x.dateTimeGMT || x.date) + (/Z$|[+-]\d\d:?\d\d$/.test(x.dateTimeGMT || '') ? '' : 'Z'));
  const statusTxt = String(x.status || ''), low = statusTxt.toLowerCase();
  const off = /abandon|no result|cancel|postpon/.test(low);
  const status = x.matchEnded ? (off ? 'cancelled' : 'finished') : x.matchStarted ? 'live' : off ? 'cancelled' : 'upcoming';
  const inn = n => (x.score || []).filter(s => String(s.inning || '').toLowerCase().startsWith(n.toLowerCase())).map(s => s.r + '/' + s.w + (s.o != null ? ' (' + s.o + ')' : '')).join(' & ');
  let win = '';
  if (status === 'finished') {
    if (/\bdrawn?\b/.test(low)) win = 'draw';
    else if (/\btied?\b/.test(low) && !/super over/.test(low)) win = 'void';
    else { const m = /^(.*?)\s+won\b/i.exec(statusTxt); const w = m ? m[1].trim().toLowerCase() : '';
      win = w && (w === hn.toLowerCase() || hn.toLowerCase().startsWith(w) || w.startsWith(hn.toLowerCase())) ? 'home' : w && (w === an.toLowerCase() || an.toLowerCase().startsWith(w) || w.startsWith(an.toLowerCase())) ? 'away' : ''; }
  }
  return { id: 'cr_' + String(x.id).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 50), srcId: String(x.id), sport: 'cricket', league: x.series || x.name && x.name.split(',').slice(-1)[0].trim() || 'Cricket', leagueLogo: '',
    home: { name: hn, short: ti(hn).shortname || '', logo: ti(hn).img || '' }, away: { name: an, short: ti(an).shortname || '', logo: ti(an).img || '' },
    startAt, status, score: { home: inn(hn), away: inn(an) }, detail: status === 'upcoming' ? '' : statusTxt.slice(0, 80),
    win, draw: String(x.matchType || '').toLowerCase() === 'test', type: x.matchType || '' };
}

/* ---- one run ---- */
export async function run({ db, inc, ts, fetchJson, env, now = Date.now(), log = console.log }) {
  const meta = db.doc('sportsMeta/feed'), M0 = (await meta.get()).data() || {}, sports = Object.assign({}, M0.sports || {});
  const errors = [], counts = { added: 0, updated: 0, settled: 0, paid: 0, removed: 0 };
  let calls = 0;
  const call = async (url, headers) => { calls++; return fetchJson(url, headers); };
  const existing = {};
  (await db.collection('sports').get()).docs.forEach(d => { existing[d.id] = d.data(); });
  const tracked = sport => Object.entries(existing).filter(([, m]) => m.sport === sport && m.source !== 'manual');
  const needsLive = sport => tracked(sport).some(([, m]) => m.status === 'live' || (m.status === 'upcoming' && m.startAt - now < SOON_MS));
  const dates = Array.from({ length: DAYS_AHEAD + 1 }, (_, i) => new Date(now + i * 864e5).toISOString().slice(0, 10));
  const found = { football: [], basketball: [], cricket: [] };

  // FOOTBALL
  if (env.APISPORTS_KEY) {
    const H = { 'x-apisports-key': env.APISPORTS_KEY }, B = 'https://v3.football.api-sports.io';
    const leagues = (env.FOOTBALL_LEAGUES || '').split(/[ ,]+/).map(Number).filter(Boolean); const L = leagues.length ? leagues : FB_DEFAULT;
    try {
      const full = !sports.football || !sports.football.full || now - sports.football.full > FULL_EVERY_MS;
      if (full) {
        for (const d of dates) { const r = await call(B + '/fixtures?date=' + d, H); apiErr(r); (r.response || []).filter(x => L.includes(x.league.id)).forEach(x => found.football.push(fromFootball(x))); }
        sports.football = { ok: true, full: now };
      } else if (needsLive('football')) {
        const ids = tracked('football').filter(([, m]) => m.status === 'live' || (m.status === 'upcoming' && m.startAt - now < SOON_MS) || ((m.status === 'live') && !m.settled)).map(([, m]) => m.srcId).slice(0, 20);
        if (ids.length) { const r = await call(B + '/fixtures?ids=' + ids.join('-'), H); apiErr(r); (r.response || []).forEach(x => found.football.push(fromFootball(x))); }
        sports.football = Object.assign({}, sports.football, { ok: true });
      }
    } catch (e) { errors.push('football: ' + e.message); sports.football = Object.assign({}, sports.football, { ok: false, error: e.message }); }
  }
  // BASKETBALL
  if (env.APISPORTS_KEY) {
    const H = { 'x-apisports-key': env.APISPORTS_KEY }, B = 'https://v1.basketball.api-sports.io';
    const leagues = (env.BASKETBALL_LEAGUES || '').split(/[ ,]+/).map(Number).filter(Boolean); const L = leagues.length ? leagues : BK_DEFAULT;
    try {
      const full = !sports.basketball || !sports.basketball.full || now - sports.basketball.full > FULL_EVERY_MS;
      const days = full ? dates : needsLive('basketball') ? [...new Set(tracked('basketball').filter(([, m]) => m.status === 'live' || m.startAt - now < SOON_MS).map(([, m]) => new Date(m.startAt).toISOString().slice(0, 10)))] : [];
      for (const d of days) { const r = await call(B + '/games?date=' + d, H); apiErr(r); (r.response || []).filter(x => L.includes(x.league.id)).forEach(x => found.basketball.push(fromBasketball(x))); }
      if (full) sports.basketball = { ok: true, full: now }; else if (days.length) sports.basketball = Object.assign({}, sports.basketball, { ok: true });
    } catch (e) { errors.push('basketball: ' + e.message); sports.basketball = Object.assign({}, sports.basketball, { ok: false, error: e.message }); }
  }
  // CRICKET
  if (env.CRICKETDATA_KEY) {
    const B = 'https://api.cricapi.com/v1', k = encodeURIComponent(env.CRICKETDATA_KEY);
    try {
      const full = !sports.cricket || !sports.cricket.full || now - sports.cricket.full > FULL_EVERY_MS;
      if (full) {
        const r = await call(B + '/matches?apikey=' + k + '&offset=0'); cricErr(r);
        (r.data || []).map(fromCricket).filter(Boolean).filter(m => m.startAt < now + (DAYS_AHEAD + 1) * 864e5 && m.startAt > now - 5 * 864e5).forEach(m => found.cricket.push(m));
        sports.cricket = { ok: true, full: now };
      }
      if (full || needsLive('cricket')) {
        const r = await call(B + '/currentMatches?apikey=' + k + '&offset=0'); cricErr(r);
        (r.data || []).map(fromCricket).filter(Boolean).forEach(m => { const i = found.cricket.findIndex(x => x.id === m.id); if (i >= 0) found.cricket[i] = m; else found.cricket.push(m); });
        sports.cricket = Object.assign({}, sports.cricket, { ok: true });
      }
    } catch (e) { errors.push('cricket: ' + e.message); sports.cricket = Object.assign({}, sports.cricket, { ok: false, error: e.message }); }
  }

  // write: new matches get opening odds; known ones get status, score and times (never the odds the admin set)
  for (const sport of Object.keys(found)) {
    let list = found[sport].filter(m => m && m.startAt && !isNaN(m.startAt));
    // keep the list short: everything already listed, plus the soonest new upcoming ones
    const fresh = list.filter(m => !existing[m.id] && m.status === 'upcoming').sort((a, b) => a.startAt - b.startAt).slice(0, MAX_PER_SPORT);
    list = list.filter(m => existing[m.id] || fresh.includes(m) || m.status === 'live');
    for (const m of list) {
      const old = existing[m.id];
      const base = { sport: m.sport, league: m.league, leagueLogo: m.leagueLogo, home: m.home, away: m.away, startAt: m.startAt, status: m.status, score: m.score, detail: m.detail, source: m.sport === 'cricket' ? 'cricketdata' : 'apisports', srcId: m.srcId, updatedAt: ts() };
      if (!old) {
        if (m.status === 'finished' || m.status === 'cancelled') continue;          // never listed, nothing to settle
        Object.assign(base, { bettingOpen: m.status === 'upcoming', markets: defaultMarkets(m.sport, m.home.name, m.away.name, m.draw), result: {}, settled: false, createdAt: ts() });
        await db.doc('sports/' + m.id).set(base); counts.added++; existing[m.id] = Object.assign({}, base, { createdAt: now, updatedAt: now });
      } else {
        if (old.settled) continue;
        if (m.status !== 'upcoming') base.bettingOpen = false;
        await db.doc('sports/' + m.id).update(base); counts.updated++; Object.assign(existing[m.id], base);
      }
      const cur = existing[m.id];
      // settle once the result is in
      if (!cur.settled && (m.status === 'cancelled' || (m.status === 'finished' && m.win))) {
        const r = m.status === 'cancelled' ? 'void' : (m.win === 'draw' && !(cur.markets && cur.markets.win && cur.markets.win.opts && cur.markets.win.opts.draw)) ? 'void' : m.win;
        const x = await settle(db, inc, ts, m.id, { win: r }); counts.settled += x.n; counts.paid += x.paid;
        await db.doc('sports/' + m.id).update({ result: { win: r }, settled: true, bettingOpen: false, updatedAt: ts() }); cur.settled = true;
      }
    }
  }
  // any listed match that has started: no more bets (also covers matches the services were not asked about this run)
  for (const [id, m] of Object.entries(existing)) {
    if (m.status === 'upcoming' && m.bettingOpen && m.startAt <= now) { await db.doc('sports/' + id).update({ bettingOpen: false, updatedAt: ts() }); m.bettingOpen = false; }
    if (m.settled && m.startAt < now - KEEP_DONE_MS) { await db.doc('sports/' + id).delete(); counts.removed++; }
  }
  Object.keys(sports).forEach(k => { if (sports[k] && sports[k].ok) sports[k].matches = Object.values(existing).filter(m => m.sport === k && !m.settled).length; });
  const errs = (M0.errors || []).concat(errors.map(e => new Date(now).toISOString().slice(0, 16) + ' ' + e)).slice(-10);
  await meta.set({ lastRun: now, calls, counts, sports, errors: errs, updatedAt: ts() });
  log('done', JSON.stringify({ calls, counts, errors }));
  return { calls, counts, errors };
}
function apiErr(r) {
  const e = r && r.errors && (Array.isArray(r.errors) ? r.errors.join(' ') : Object.values(r.errors).join(' '));
  if (e) throw new Error(String(e).slice(0, 200));
}
function cricErr(r) { if (r && r.status && r.status !== 'success') throw new Error(String(r.reason || r.status).slice(0, 200)); }

// every open bet on the match: won, lost or void; winners (and voids) are paid into their wallets
export async function settle(db, inc, ts, id, result) {
  const sn = await db.collection('bets').where('matchId', '==', id).get();
  let n = 0, paid = 0;
  for (const d of sn.docs) {
    const b = d.data(); if (b.status !== 'open') continue;
    const r = result[b.market] || 'void', st = r === 'void' ? 'void' : r === b.pick ? 'won' : 'lost';
    const pay = st === 'won' ? payout(b.stake, b.odds) : st === 'void' ? b.stake : 0;
    const batch = db.batch();
    batch.update(db.doc('bets/' + d.id), { status: st, payout: pay, settledAt: ts() });
    if (pay > 0) batch.update(db.doc('users/' + b.uid), { chips: inc(pay), lastPayout: d.id, updatedAt: ts() });
    try { await batch.commit(); n++; paid += pay; }
    catch (e) { console.warn('could not settle bet ' + d.id + ' (' + e.message + ')'); }
  }
  return { n, paid };
}

/* ---- started by GitHub Actions ---- */
async function main() {
  const { default: admin } = await import('firebase-admin');
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
  if (!sa.project_id) throw new Error('The secret FIREBASE_SERVICE_ACCOUNT is missing or is not the service account JSON.');
  admin.initializeApp({ credential: admin.credential.cert(sa) });
  const fs = admin.firestore(), FieldValue = admin.firestore.FieldValue;
  const fetchJson = async (url, headers) => { const r = await fetch(url, { headers }); const t = await r.text(); if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + t.slice(0, 120)); return JSON.parse(t); };
  await run({ db: fs, inc: n => FieldValue.increment(n), ts: () => FieldValue.serverTimestamp(), fetchJson, env: process.env });
}
if (process.argv[1] && process.argv[1].endsWith('sports-feed.mjs')) main().catch(e => { console.error(e); process.exit(1); });
